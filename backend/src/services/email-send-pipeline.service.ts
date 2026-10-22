import { EmailDraft } from '../models/EmailDraft.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailSendAttempt, SendAttemptStatus } from '../models/EmailSendAttempt.js';
import { EmailThread, IEmailMessageItem } from '../models/EmailThread.js';
import { Suppression } from '../models/Suppression.js';
import { IEmailProvider } from '../providers/email/email-provider.interface.js';
import { mockEmailProvider } from '../providers/email/mock-email.provider.js';
import { gmailProvider } from '../providers/email/gmail.provider.js';
import { AppError } from '../middleware/errorHandler.js';
import { senderAccountService } from './sender-account.service.js';

export interface ExecuteSendOptions {
  draftId: string;
  mailboxId: string;
  organizationId: string;
  actorId: string;
  idempotencyKey: string;
  /** Campaign attribution, persisted so campaign "Sent" can be derived from accepted sends. */
  campaignId?: string;
  recipientId?: string;
  stepIndex?: number;
  /**
   * Maximum time to wait for the mailbox's Gmail API quota before deferring
   * the send. Batch senders use a small value so one quota-limited mailbox
   * does not stall the whole batch.
   */
  maxQuotaWaitMs?: number;
}

export interface SendPipelineResult {
  status: SendAttemptStatus;
  providerMessageId?: string;
  providerThreadId?: string;
  errorMessage?: string;
  idempotencyKey: string;
  /**
   * True when the provider outcome is unknown and the message may or may not
   * have been delivered. The caller must reconcile before retrying.
   */
  deliveryUncertain?: boolean;
  /** Earliest time a deferred send may be retried. */
  deferredUntil?: Date;
}

/** AppError codes that mean "the request was never sent, quota was exhausted". */
const QUOTA_DEFERRED_CODES = new Set(['GMAIL_QUOTA_EXCEEDED', 'GMAIL_QUOTA_EXHAUSTED']);

export class EmailSendPipelineService {
  constructor(private emailProvider: IEmailProvider = mockEmailProvider) {}

  /**
   * Atomically books the send against the mailbox's daily and hourly counters.
   *
   * A read-modify-write (`sendsToday += 1`) loses updates when two campaigns
   * send from the same mailbox at the same time, so the counter is always
   * incremented with a single atomic `$inc`.
   */
  private async incrementSendCounters(mailbox: { _id: unknown; emailAddress: string }): Promise<void> {
    await EmailAccount.updateOne(
      { _id: mailbox._id },
      {
        $inc: { sendsToday: 1, sendsThisHour: 1 },
        $set: { lastSendAt: new Date() },
      }
    ).catch(() => undefined);
  }

  /**
   * Executes the strict approval and send pipeline.
   * Runs 7 comprehensive pre-flight verification checks before dispatching.
   */
  async executeSend(options: ExecuteSendOptions): Promise<SendPipelineResult> {
    const { draftId, mailboxId, organizationId, actorId, idempotencyKey, campaignId, recipientId, stepIndex } =
      options;

    // CHECK 1: IDEMPOTENCY / DOUBLE-CLICK LOCK
    const existingAttempt = await EmailSendAttempt.findOne({
      organizationId,
      idempotencyKey,
    });

    if (existingAttempt) {
      if (existingAttempt.status === 'accepted') {
        return {
          status: 'accepted',
          providerMessageId: existingAttempt.providerMessageId,
          providerThreadId: existingAttempt.providerThreadId,
          idempotencyKey,
        };
      }
      if (existingAttempt.status === 'dispatching') {
        throw new AppError('Concurrent send in progress for this request', 409, 'CONCURRENT_SEND');
      }
      if (existingAttempt.status === 'deferred') {
        // Quota-limited: wait until the mailbox budget refills before retrying.
        const deferredUntil = existingAttempt.deferredUntil || new Date();
        if (deferredUntil.getTime() > Date.now()) {
          return {
            status: 'deferred',
            errorMessage: existingAttempt.errorMessage,
            idempotencyKey,
            deferredUntil,
          };
        }
        // Budget is back — fall through and reuse the same attempt document.
      }
    }

    // CHECK 2: DRAFT STATE & APPROVAL STATUS
    const draft = await EmailDraft.findOne({
      _id: draftId,
      organizationId,
    });

    if (!draft) {
      throw new AppError('Draft not found in this organization', 404, 'DRAFT_NOT_FOUND');
    }

    if (draft.status !== 'approved') {
      throw new AppError(
        `Draft status is '${draft.status}'. Explicit human review and approval is strictly required before send.`,
        400,
        'UNAPPROVED_DRAFT'
      );
    }

    // CHECK 2b: MESSAGE CONTENT COMPLETENESS
    // Never claim success on a partial message: a missing/blank subject or body
    // (e.g. an imported CSV body that failed to parse or was truncated to empty)
    // must block the send with a clear, actionable error.
    const subject = String(draft.subject ?? '').trim();
    const body = String(draft.bodyText ?? '').trim();
    if (!subject) {
      throw new AppError(
        'Draft has no subject line. A complete subject is required before sending.',
        400,
        'DRAFT_SUBJECT_MISSING'
      );
    }
    if (!body) {
      throw new AppError(
        'Draft has no email body. A complete body is required before sending; sending a partial or empty message is blocked.',
        400,
        'DRAFT_BODY_MISSING'
      );
    }

    // CHECK 3: RECIPIENT VALIDITY
    const recipientEmail = draft.recipientEmail?.trim().toLowerCase();
    if (!recipientEmail || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(recipientEmail)) {
      throw new AppError(`Recipient email address '${recipientEmail}' is invalid`, 400, 'INVALID_RECIPIENT');
    }

    // CHECK 4: SUPPRESSION & OPT-OUT VERIFICATION
    const isSuppressed = await Suppression.findOne({
      organizationId,
      email: recipientEmail,
    });

    if (isSuppressed) {
      throw new AppError(
        `Recipient '${recipientEmail}' is on the suppression list (${isSuppressed.reason})`,
        400,
        'RECIPIENT_SUPPRESSED'
      );
    }

    // CHECK 5: MAILBOX OWNERSHIP, HEALTH & PAUSE SWITCH
    const mailbox = await EmailAccount.findOne({
      organizationId,
      emailAddress: mailboxId.toLowerCase(),
    });

    if (!mailbox) {
      throw new AppError(`Mailbox '${mailboxId}' not found for this organization`, 404, 'MAILBOX_NOT_FOUND');
    }

    if (mailbox.status === 'error') {
      throw new AppError('Mailbox is in an error state. Check connection credentials.', 400, 'MAILBOX_ERROR');
    }

    if (mailbox.isPaused) {
      throw new AppError(
        `Outbound dispatches are currently paused: ${mailbox.pausedReason || 'Emergency pause engaged'}`,
        400,
        'MAILBOX_PAUSED'
      );
    }

    // CHECK 6: DAILY SEND LIMITS
    // The daily window is rolled over first: a counter that was never reset
    // would otherwise block the mailbox forever after its first busy day.
    await senderAccountService.rollOverCounters(String(mailbox._id));
    const counters = await EmailAccount.findOne({ _id: mailbox._id })
      .select('sendsToday sendsThisHour reservedSends dailySendLimit')
      .lean();
    const dailyLimit = Math.min(
      mailbox.dailySendLimit ?? 0,
      counters?.dailySendLimit ?? mailbox.dailySendLimit ?? 0
    );
    const usedToday = (counters?.sendsToday ?? 0) + (counters?.reservedSends ?? 0);
    if (usedToday >= dailyLimit) {
      throw new AppError(
        `Daily send limit of ${dailyLimit} reached for mailbox ${mailbox.emailAddress}`,
        429,
        'LIMIT_EXCEEDED'
      );
    }

    // CHECK 7: RECONCILE A PREVIOUS UNCERTAIN DELIVERY BEFORE ANY RETRY
    // A previous attempt ended in an unknown state (timeout / 5xx). Sending
    // again right away could deliver the email twice, so the sent folder is
    // checked first. Only when the message is provably absent is a resend
    // allowed.
    if (existingAttempt?.deliveryUncertain && existingAttempt.status === 'unknown_timeout') {
      const reconcileProvider = mailbox.provider === 'gmail' ? gmailProvider : this.emailProvider;
      let sent: { messageId: string; threadId?: string } | null = null;

      if (typeof reconcileProvider.findSentMessage === 'function') {
        sent = await reconcileProvider
          .findSentMessage(mailbox.emailAddress, {
            to: recipientEmail,
            subject: draft.subject,
            after: existingAttempt.startedAt || new Date(Date.now() - 60 * 60 * 1000),
            organizationId,
          })
          .catch(() => null);
      }

      if (sent) {
        existingAttempt.status = 'accepted';
        existingAttempt.deliveryUncertain = false;
        existingAttempt.providerMessageId = sent.messageId;
        existingAttempt.providerThreadId = sent.threadId;
        existingAttempt.completedAt = new Date();
        await existingAttempt.save();

        await this.incrementSendCounters(mailbox);

        draft.status = 'accepted';
        draft.sentAt = new Date();
        draft.providerMessageId = sent.messageId;
        draft.providerThreadId = sent.threadId;
        await draft.save();

        return {
          status: 'accepted',
          providerMessageId: sent.messageId,
          providerThreadId: sent.threadId,
          idempotencyKey,
        };
      }

      // Message is provably absent from the sent folder: safe to resend.
      existingAttempt.deliveryUncertain = false;
      existingAttempt.status = 'failed';
      await existingAttempt.save();
    }

    // REGISTER DISPATCHING ATTEMPT (Idempotent Lock)
    let attemptDoc: any;
    const reuseExisting =
      existingAttempt &&
      ['failed', 'unknown_timeout', 'deferred'].includes(existingAttempt.status) &&
      !existingAttempt.deliveryUncertain;

    if (reuseExisting) {
      // The previous attempt definitely did not deliver (or was deferred), so
      // the very same attempt document is reused instead of creating a new one.
      attemptDoc = existingAttempt;
      attemptDoc.status = 'dispatching';
      attemptDoc.attempts = (attemptDoc.attempts || 0) + 1;
      attemptDoc.deliveryUncertain = false;
      attemptDoc.errorMessage = undefined;
      attemptDoc.startedAt = new Date();
      attemptDoc.completedAt = undefined;
      await attemptDoc.save();
    } else {
      try {
        attemptDoc = await EmailSendAttempt.create({
          organizationId,
          draftId: draft._id,
          campaignId: campaignId || draft.campaignId,
          recipientId: recipientId || draft.recipientId,
          stepIndex: stepIndex ?? draft.stepIndex,
          mailboxId: mailbox.emailAddress,
          accountId: String(mailbox._id),
          actorId,
          recipientEmail,
          idempotencyKey,
          status: 'dispatching',
          attempts: 1,
          startedAt: new Date(),
        });
      } catch (lockErr: any) {
        if (lockErr.code === 11000) {
          throw new AppError('Idempotency lock already acquired for this operation', 409, 'DUPLICATE_SEND');
        }
        throw lockErr;
      }
    }

    // EXECUTE DISPATCH VIA PROVIDER ADAPTER
    const provider = mailbox.provider === 'gmail' ? gmailProvider : this.emailProvider;
    try {
      const sendPayload: any = {
        to: recipientEmail,
        subject: draft.subject,
        body: draft.bodyText,
      };
      if (options.maxQuotaWaitMs !== undefined) {
        sendPayload.maxQuotaWaitMs = options.maxQuotaWaitMs;
      }
      if (draft.replyContext?.threadId) {
        sendPayload.threadId = draft.replyContext.threadId;
      }
      if (draft.replyContext?.inReplyTo) {
        sendPayload.inReplyTo = draft.replyContext.inReplyTo;
      }

      const sendResult = await provider.sendMessage(mailbox.emailAddress, sendPayload, organizationId);

      // OUTCOME: ACCEPTED BY PROVIDER (Note: Provider acceptance is not guaranteed delivery)
      attemptDoc.status = 'accepted';
      attemptDoc.providerMessageId = sendResult.messageId;
      attemptDoc.providerThreadId = sendResult.threadId;
      attemptDoc.completedAt = new Date();
      await attemptDoc.save();

      // Increment mailbox quota counter
      await this.incrementSendCounters(mailbox);

      // Update draft status
      draft.status = 'accepted';
      draft.sentAt = new Date();
      draft.providerMessageId = sendResult.messageId;
      draft.providerThreadId = sendResult.threadId;
      await draft.save();

      // Persist or update the outbound message in EmailThread so it immediately appears
      // in the Inbox "Sent" folder with full thread context
      try {
        const now = new Date();
        const outboundMsg: IEmailMessageItem = {
          id: sendResult.messageId,
          from: { name: mailbox.displayName || mailbox.emailAddress, email: mailbox.emailAddress },
          to: [{ name: draft.recipientName || '', email: recipientEmail }],
          subject: draft.subject,
          bodyText: draft.bodyText,
          snippet: draft.bodyText.slice(0, 160),
          date: now,
          isRead: true,
          isStarred: false,
          hasAttachments: false,
          messageIdHeader: sendResult.messageId,
        };

        const existingThread = await EmailThread.findOne({
          organizationId,
          mailboxEmail: mailbox.emailAddress.toLowerCase(),
          threadId: sendResult.threadId,
        });

        if (existingThread) {
          const alreadyHasMsg = existingThread.messages.some((m) => m.id === sendResult.messageId);
          if (!alreadyHasMsg) {
            existingThread.messages.push(outboundMsg);
            existingThread.messageCount = existingThread.messages.length;
            existingThread.lastMessageDate = now;
            existingThread.snippet = outboundMsg.snippet;
            if (!existingThread.labels.includes('SENT')) existingThread.labels.push('SENT');
            if (!existingThread.participants.includes(recipientEmail.toLowerCase())) {
              existingThread.participants.push(recipientEmail.toLowerCase());
            }
            if (draft.companyId && !existingThread.companyId) {
              existingThread.companyId = draft.companyId;
              existingThread.companyName = draft.companyName;
            }
            await existingThread.save();
          }
        } else {
          await EmailThread.create({
            organizationId,
            mailboxEmail: mailbox.emailAddress.toLowerCase(),
            threadId: sendResult.threadId,
            subject: draft.subject,
            snippet: draft.bodyText.slice(0, 160),
            lastMessageDate: now,
            messageCount: 1,
            isRead: true,
            isStarred: false,
            isArchived: false,
            isSpam: false,
            isTrash: false,
            isSnoozed: false,
            inInbox: false,
            hasAttachments: false,
            unreadCount: 0,
            labels: ['SENT'],
            lastFromName: mailbox.displayName || mailbox.emailAddress,
            lastFromEmail: mailbox.emailAddress,
            participants: [mailbox.emailAddress.toLowerCase(), recipientEmail.toLowerCase()],
            companyId: draft.companyId,
            companyName: draft.companyName,
            messages: [outboundMsg],
          });
        }
      } catch (threadErr) {
        console.warn('Failed to record outbound EmailThread:', threadErr);
      }

      return {
        status: 'accepted',
        providerMessageId: sendResult.messageId,
        providerThreadId: sendResult.threadId,
        idempotencyKey,
      };
    } catch (dispatchErr: any) {
      const errorCode: string = dispatchErr?.code || '';
      const details: any = dispatchErr?.details || {};

      // Quota exhaustion: the request was never handed to Gmail, so nothing was
      // sent. Defer instead of failing so the send can be retried once the
      // mailbox's API budget refills.
      if (QUOTA_DEFERRED_CODES.has(errorCode)) {
        const retryAfterMs = Number(details.retryAfterMs) > 0 ? Number(details.retryAfterMs) : 60000;
        const deferredUntil = new Date(Date.now() + retryAfterMs);

        attemptDoc.status = 'deferred';
        attemptDoc.deliveryUncertain = false;
        attemptDoc.deferredUntil = deferredUntil;
        attemptDoc.errorMessage =
          dispatchErr?.message || 'Gmail API quota exhausted — the send was deferred and will be retried.';
        attemptDoc.completedAt = undefined;
        await attemptDoc.save();

        return {
          status: 'deferred',
          errorMessage: attemptDoc.errorMessage,
          idempotencyKey,
          deferredUntil,
        };
      }

      // The provider could not tell us whether the message went out (timeout,
      // dropped connection, 5xx). Reconcile against the sent folder before
      // deciding to retry, otherwise the recipient gets the email twice.
      const uncertain = details.uncertainDelivery === true;
      if (uncertain && typeof provider.findSentMessage === 'function') {
        const reconcileFrom = attemptDoc.startedAt || new Date(Date.now() - 10 * 60 * 1000);
        const sent = await provider
          .findSentMessage(mailbox.emailAddress, {
            to: recipientEmail,
            subject: draft.subject,
            after: reconcileFrom,
            organizationId,
          })
          .catch(() => null);

        if (sent) {
          attemptDoc.status = 'accepted';
          attemptDoc.deliveryUncertain = false;
          attemptDoc.providerMessageId = sent.messageId;
          attemptDoc.providerThreadId = sent.threadId;
          attemptDoc.completedAt = new Date();
          await attemptDoc.save();

          await this.incrementSendCounters(mailbox);

          draft.status = 'accepted';
          draft.sentAt = new Date();
          draft.providerMessageId = sent.messageId;
          draft.providerThreadId = sent.threadId;
          await draft.save();

          return {
            status: 'accepted',
            providerMessageId: sent.messageId,
            providerThreadId: sent.threadId,
            idempotencyKey,
          };
        }
      }

      const isTimeout = dispatchErr?.message?.toLowerCase().includes('timeout');
      const outcomeStatus: SendAttemptStatus = uncertain || isTimeout ? 'unknown_timeout' : 'failed';

      attemptDoc.status = outcomeStatus;
      attemptDoc.deliveryUncertain = outcomeStatus === 'unknown_timeout';
      attemptDoc.errorMessage = dispatchErr?.message || 'Dispatch error';
      attemptDoc.completedAt = new Date();
      await attemptDoc.save();

      return {
        status: outcomeStatus,
        errorMessage: dispatchErr?.message,
        idempotencyKey,
        deliveryUncertain: attemptDoc.deliveryUncertain,
      };
    }
  }
}

export const emailSendPipelineService = new EmailSendPipelineService();

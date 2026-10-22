import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient, ICampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { EmailThread } from '../models/EmailThread.js';
import { FollowUpTask } from '../models/FollowUpTask.js';

const INACTIVE_CAMPAIGN_STATUSES = ['failed', 'cancelled'];

export interface InboundReplyContext {
  organizationId: string;
  mailboxEmail: string;
  threadId: string;
  messageId?: string;
  fromEmail: string;
  fromName?: string;
  subject?: string;
  bodySnippet?: string;
  inReplyTo?: string;
  references?: string;
  receivedAt?: Date;
  companyName?: string;
}

export interface ReplyAssociationResult {
  associated: boolean;
  campaignId?: string;
  recipientId?: string;
  alreadyReplied?: boolean;
}

/**
 * Extracts Message-IDs from RFC headers (both bracketed <id@domain> and raw ids).
 */
export function extractMessageIds(header?: string): string[] {
  if (!header || !header.trim()) return [];
  const matches = header.match(/<[^>]+>/g) || [];
  const cleanedMatches = matches.map((m) => m.replace(/^<|>$/g, '').trim());
  const parts = header
    .split(/\s+/)
    .map((p) => p.replace(/^<|>$/g, '').trim())
    .filter(Boolean);
  return Array.from(new Set([...cleanedMatches, ...parts])).filter(Boolean);
}

/**
 * Associates a genuine inbound reply with the campaign recipient it came from.
 *
 * Multi-tiered matching algorithm:
 *  1. Thread ID Match: matches threadId against CampaignRecipient.replyThreadId,
 *     stepDrafts.providerThreadId, or EmailSendAttempt / EmailDraft records with recipientId.
 *  2. Header Match: matches In-Reply-To / References against EmailSendAttempt or
 *     EmailDraft providerMessageId, messageIdHeader, or idempotencyKey.
 *  3. Sender Email Match: matches sender against CampaignRecipient.email in the same organization,
 *     prioritizing contacts who have received outreach (completedSteps > 0).
 *
 * Deduplication & Safety:
 *  - Idempotent: repeated syncs of the same thread or messages do not double-increment
 *    repliesReceived.
 *  - Future follow-up sequence steps are automatically skipped/cancelled.
 *  - Thread document in MongoDB is linked to the company and campaign for inbox display.
 *  - Unmatched incoming messages are not discarded; they remain visible in the inbox.
 */
export class ReplyAssociationService {
  async handleInboundReply(ctx: InboundReplyContext): Promise<ReplyAssociationResult> {
    if (!ctx.organizationId || !ctx.fromEmail) {
      return { associated: false };
    }

    const email = ctx.fromEmail.trim().toLowerCase();
    let recipient: ICampaignRecipient | null = null;

    // --- TIER 1: MATCH BY THREAD ID ---
    if (ctx.threadId) {
      // 1a: Direct check on CampaignRecipient
      recipient = await CampaignRecipient.findOne({
        organizationId: ctx.organizationId,
        $or: [
          { replyThreadId: ctx.threadId },
          { 'stepDrafts.providerThreadId': ctx.threadId },
        ],
      });

      // 1b: Check EmailSendAttempt by providerThreadId
      if (!recipient) {
        const attempt = await EmailSendAttempt.findOne({
          organizationId: ctx.organizationId,
          providerThreadId: ctx.threadId,
          recipientId: { $exists: true },
        });
        if (attempt?.recipientId) {
          recipient = await CampaignRecipient.findOne({
            _id: attempt.recipientId,
            organizationId: ctx.organizationId,
          });
        }
      }

      // 1c: Check EmailDraft by providerThreadId
      if (!recipient) {
        const draft = await EmailDraft.findOne({
          organizationId: ctx.organizationId,
          providerThreadId: ctx.threadId,
          recipientId: { $exists: true },
        });
        if (draft?.recipientId) {
          recipient = await CampaignRecipient.findOne({
            _id: draft.recipientId,
            organizationId: ctx.organizationId,
          });
        }
      }
    }

    // --- TIER 2: MATCH BY RFC HEADERS (In-Reply-To / References) ---
    if (!recipient && (ctx.inReplyTo || ctx.references)) {
      const tokenCandidates = [
        ...extractMessageIds(ctx.inReplyTo),
        ...extractMessageIds(ctx.references),
      ];

      if (tokenCandidates.length > 0) {
        // 2a: Check CampaignRecipient stepDrafts providerMessageId
        recipient = await CampaignRecipient.findOne({
          organizationId: ctx.organizationId,
          'stepDrafts.providerMessageId': { $in: tokenCandidates },
        });

        // 2b: Check EmailSendAttempt by providerMessageId or idempotencyKey
        if (!recipient) {
          const attempt = await EmailSendAttempt.findOne({
            organizationId: ctx.organizationId,
            recipientId: { $exists: true },
            $or: [
              { providerMessageId: { $in: tokenCandidates } },
              { idempotencyKey: { $in: tokenCandidates } },
            ],
          });
          if (attempt?.recipientId) {
            recipient = await CampaignRecipient.findOne({
              _id: attempt.recipientId,
              organizationId: ctx.organizationId,
            });
          }
        }

        // 2c: Check EmailDraft by providerMessageId or messageIdHeader
        if (!recipient) {
          const draft = await EmailDraft.findOne({
            organizationId: ctx.organizationId,
            recipientId: { $exists: true },
            $or: [
              { providerMessageId: { $in: tokenCandidates } },
              { messageIdHeader: { $in: tokenCandidates } },
            ],
          });
          if (draft?.recipientId) {
            recipient = await CampaignRecipient.findOne({
              _id: draft.recipientId,
              organizationId: ctx.organizationId,
            });
          }
        }
      }
    }

    // --- TIER 3: MATCH BY SENDER EMAIL ADDRESS ---
    if (!recipient && email) {
      const mailbox = (ctx.mailboxEmail || '').trim().toLowerCase();

      // Prefer the recipient that was contacted from the mailbox which
      // actually received the reply. In a multi-account campaign a prospect
      // may exist in several campaigns, and the reply belongs to the one
      // whose sender account received it.
      if (mailbox) {
        recipient = await CampaignRecipient.findOne({
          organizationId: ctx.organizationId,
          email,
          assignedAccountEmail: mailbox,
          $or: [{ completedSteps: { $gt: 0 } }, { 'stepDrafts.status': 'sent' }],
        }).sort({ lastSentAt: -1, createdAt: -1 });
      }

      // Prioritize recipients who were actually sent an email
      if (!recipient) {
        recipient = await CampaignRecipient.findOne({
          organizationId: ctx.organizationId,
          email,
          $or: [{ completedSteps: { $gt: 0 } }, { 'stepDrafts.status': 'sent' }],
        }).sort({ lastSentAt: -1, createdAt: -1 });
      }

      // Fallback: match any active recipient for this email
      if (!recipient) {
        recipient = await CampaignRecipient.findOne({
          organizationId: ctx.organizationId,
          email,
          replied: false,
        }).sort({ createdAt: -1 });
      }
    }

    if (!recipient) {
      return { associated: false };
    }

    const campaign = await Campaign.findById(recipient.campaignId);
    if (!campaign || INACTIVE_CAMPAIGN_STATUSES.includes(campaign.status)) {
      return { associated: false };
    }

    // --- HANDLE ALREADY-REPLIED (IDEMPOTENCE) ---
    if (recipient.replied) {
      let needsSave = false;
      if (!recipient.replyThreadId && ctx.threadId) {
        recipient.replyThreadId = ctx.threadId;
        needsSave = true;
      }
      if (!recipient.replySnippet && ctx.bodySnippet) {
        recipient.replySnippet = ctx.bodySnippet;
        needsSave = true;
      }
      if (!recipient.replySubject && ctx.subject) {
        recipient.replySubject = ctx.subject;
        needsSave = true;
      }
      if (!recipient.replyFromEmail && ctx.fromEmail) {
        recipient.replyFromEmail = ctx.fromEmail;
        needsSave = true;
      }
      if (needsSave) {
        await recipient.save();
      }

      // Ensure thread linkage is set
      if (ctx.threadId) {
        await EmailThread.updateOne(
          { organizationId: ctx.organizationId, threadId: ctx.threadId },
          {
            $set: {
              companyId: recipient.companyId,
              companyName: recipient.companyName || ctx.companyName,
              campaignName: campaign.name,
            },
          }
        );
      }

      return {
        associated: false,
        campaignId: campaign._id.toString(),
        recipientId: recipient._id.toString(),
        alreadyReplied: true,
      };
    }

    // --- MARK RECIPIENT REPLIED & CANCEL PENDING STEPS ---
    recipient.replied = true;
    recipient.repliedAt = ctx.receivedAt || new Date();
    recipient.replyThreadId = ctx.threadId || recipient.replyThreadId;
    recipient.replySnippet = ctx.bodySnippet || recipient.replySnippet;
    recipient.replySubject = ctx.subject || recipient.replySubject;
    recipient.replyFromEmail = ctx.fromEmail || recipient.replyFromEmail;
    recipient.replyMailboxEmail =
      (ctx.mailboxEmail || '').trim().toLowerCase() || recipient.replyMailboxEmail;
    recipient.status = 'replied';

    for (const slot of recipient.stepDrafts) {
      if (['pending', 'draft', 'approved'].includes(slot.status)) {
        slot.status = 'skipped';
        slot.error = 'Follow-up cancelled: recipient replied.';
      }
    }
    await recipient.save();

    // Reconcile unique campaign replies received to avoid any double counts
    const uniqueRepliedCount = await CampaignRecipient.countDocuments({
      organizationId: ctx.organizationId,
      campaignId: campaign._id,
      replied: true,
    });
    campaign.repliesReceived = uniqueRepliedCount;
    if (!campaign.stats) {
      campaign.stats = { totalRecipients: 0, prepared: 0, sent: 0, failed: 0, skipped: 0 };
    }
    campaign.stats.replied = uniqueRepliedCount;
    await campaign.save();

    // Link the thread to the known company and campaign
    if (ctx.threadId) {
      await EmailThread.updateOne(
        { organizationId: ctx.organizationId, threadId: ctx.threadId },
        {
          $set: {
            companyId: recipient.companyId,
            companyName: recipient.companyName || ctx.companyName,
            campaignName: campaign.name,
          },
        }
      );
    }

    // Cancel pending follow-up tasks for this contact
    await FollowUpTask.updateMany(
      {
        organizationId: ctx.organizationId,
        status: 'pending',
        $or: [{ threadId: ctx.threadId }, { contactEmail: email }],
      },
      { $set: { status: 'cancelled', notes: 'Auto-cancelled: recipient replied' } }
    );

    return {
      associated: true,
      campaignId: campaign._id.toString(),
      recipientId: recipient._id.toString(),
      alreadyReplied: false,
    };
  }

  /** Manually links a thread to a campaign recipient (used from the inbox / campaign UI). */
  async associateManually(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    threadId: string
  ): Promise<{ associated: boolean }> {
    const recipient = await CampaignRecipient.findOne({
      _id: recipientId,
      organizationId,
      campaignId,
    });
    if (!recipient) return { associated: false };

    const thread = await EmailThread.findOne({ organizationId, threadId });
    const lastIncoming = thread?.messages
      ?.filter((m) => !m.from?.email?.toLowerCase().includes('outreach@'))
      ?.at(-1);

    recipient.replied = true;
    recipient.repliedAt = recipient.repliedAt || new Date();
    recipient.replyThreadId = threadId;
    if (lastIncoming?.snippet) recipient.replySnippet = lastIncoming.snippet;
    if (lastIncoming?.subject) recipient.replySubject = lastIncoming.subject;
    if (lastIncoming?.from?.email) recipient.replyFromEmail = lastIncoming.from.email;
    recipient.status = 'replied';

    for (const slot of recipient.stepDrafts) {
      if (['pending', 'draft', 'approved'].includes(slot.status)) {
        slot.status = 'skipped';
        slot.error = 'Follow-up cancelled: recipient replied.';
      }
    }
    await recipient.save();

    const uniqueRepliedCount = await CampaignRecipient.countDocuments({
      organizationId,
      campaignId,
      replied: true,
    });
    await Campaign.updateOne(
      { _id: campaignId, organizationId },
      { $set: { repliesReceived: uniqueRepliedCount, 'stats.replied': uniqueRepliedCount } }
    );

    const campaign = await Campaign.findById(campaignId).select('name').lean();

    await EmailThread.updateOne(
      { organizationId, threadId },
      {
        $set: {
          companyId: recipient.companyId,
          companyName: recipient.companyName,
          campaignName: campaign?.name,
        },
      }
    );

    await FollowUpTask.updateMany(
      {
        organizationId,
        status: 'pending',
        $or: [{ threadId }, { contactEmail: recipient.email.toLowerCase() }],
      },
      { $set: { status: 'cancelled', notes: 'Manual association: recipient replied' } }
    );

    return { associated: true };
  }
}

export const replyAssociationService = new ReplyAssociationService();

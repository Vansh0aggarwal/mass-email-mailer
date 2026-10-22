/**
 * Per-sender-account dispatch queue.
 *
 * A drip campaign is not one big batch: every connected Gmail account owns a
 * small logical queue of recipients and sends them at its own pace. This
 * service is the component that turns "the campaign is scheduled" into "this
 * account may send *one* message right now".
 *
 * Guarantees:
 *
 *  1. **A recipient is always contacted from its assigned mailbox.** The queue
 *     only ever looks at recipients whose `assignedAccountId` matches the
 *     account it is dispatching for, so a thread never moves between inboxes.
 *  2. **The drip rate is never exceeded.** An account sends at most one
 *     message per configured interval (plus jitter). A paused or throttled
 *     account resumes at its configured rate — it never "catches up" with a
 *     burst.
 *  3. **The caps are enforced atomically.** The daily and hourly caps are
 *     claimed with a conditional update on the account, so two workers can
 *     never book the same slot.
 *  4. **Quota errors are observed.** A deferred send is not lost: the step
 *     stays approved, the account is backed off, and the next tick retries.
 */
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { AppError } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';
import { evaluateAuthorization, senderAccountService } from './sender-account.service.js';
import { campaignService } from './campaign.service.js';

export interface SenderQueueAccountState {
  accountId: string;
  emailAddress: string;
  displayName?: string;
  /** The account is part of the campaign's roster. */
  enabled: boolean;
  /** The account may be used for outbound sends right now. */
  authorized: boolean;
  /** Why the account cannot send right now (machine readable). */
  reasonCode?:
    | 'ACCOUNT_DISCONNECTED'
    | 'ACCOUNT_ERROR'
    | 'ACCOUNT_PAUSED'
    | 'MISSING_REFRESH_TOKEN'
    | 'MISSING_SEND_SCOPE'
    | 'UNSUPPORTED_PROVIDER'
    | 'ACCOUNT_NOT_FOUND'
    | 'DAILY_LIMIT_REACHED'
    | 'HOURLY_LIMIT_REACHED'
    | 'INTERVAL_NOT_ELAPSED'
    | 'NO_READY_RECIPIENT';
  /** Human readable explanation. */
  reason?: string;
  /** Recipients assigned to this account that are still waiting for a send. */
  waiting: number;
  /** Recipients assigned to this account that already received a message. */
  sent: number;
  /** Per-campaign cap configured for this account. */
  dailySendCap: number;
  maxPerHour: number;
  minIntervalSeconds: number;
  jitterSeconds: number;
  /** Caps after the account's own limits are taken into account. */
  effectiveDailyCap: number;
  effectiveMaxPerHour: number;
  /** Live counters of the connected account. */
  sendsToday: number;
  sendsThisHour: number;
  reservedSends: number;
  /** Earliest time this account may send again. */
  nextSendAt?: string;
  /** Timestamp of the last successful send. */
  lastSendAt?: string;
  /** True when the account may send a message right now. */
  ready: boolean;
}

export interface SenderQueueDispatchResult {
  campaignId: string;
  status: string;
  /** Messages accepted by the provider during this tick. */
  sent: number;
  /** Sends that were deferred (quota) during this tick. */
  deferred: number;
  /** Sends that failed during this tick. */
  failed: number;
  /** Recipients that were skipped because they are not ready yet. */
  skipped: number;
  /** The campaign has no roster and keeps using its legacy single mailbox. */
  legacy: boolean;
  accounts: SenderQueueAccountState[];
}

/** How many candidates are inspected per account before giving up. */
const CANDIDATE_SCAN_LIMIT = 50;

/** Backoff applied to an account after a quota deferral. */
const QUOTA_BACKOFF_SECONDS = 60;

function randomJitterSeconds(jitterSeconds: number): number {
  if (!jitterSeconds || jitterSeconds <= 0) return 0;
  return Math.floor(Math.random() * (jitterSeconds + 1));
}

function toIso(value?: Date | null): string | undefined {
  if (!value) return undefined;
  return new Date(value).toISOString();
}

export class SenderQueueService {
  /**
   * Returns the live state of every sender account of a campaign.
   * Used by the campaign detail page to show progress, limits and the next
   * eligible send time per account.
   */
  async describe(organizationId: string, campaignId: string): Promise<SenderQueueAccountState[]> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const roster = campaign.senderAccounts || [];
    if (roster.length === 0) return [];

    const accountIds = roster.map((entry) => entry.accountId);
    const accounts = await EmailAccount.find({ _id: { $in: accountIds }, organizationId }).lean();
    const accountById = new Map(accounts.map((a) => [String(a._id), a]));

    // "waiting" counts the recipients of an account that still have a pending
    // send. A recipient is done when every step was sent, when it replied or
    // when it was skipped/suppressed.
    const grouped = await CampaignRecipient.aggregate([
      { $match: { organizationId, campaignId: campaign._id, assignedAccountId: { $in: accountIds } } },
      {
        $group: {
          _id: '$assignedAccountId',
          waiting: {
            $sum: {
              $cond: [{ $in: ['$status', ['sent', 'replied', 'skipped', 'suppressed']] }, 0, 1],
            },
          },
        },
      },
    ]);
    const waitingByAccount = new Map<string, number>();
    for (const row of grouped) {
      waitingByAccount.set(String(row._id), row.waiting);
    }

    const now = new Date();
    const states: SenderQueueAccountState[] = [];

    for (const entry of roster) {
      const account = accountById.get(entry.accountId);
      const authorization = account
        ? evaluateAuthorization(account as any)
        : {
            authorized: false,
            reasonCode: 'ACCOUNT_NOT_FOUND' as const,
            reason: 'The connected account no longer exists.',
          };

      const dailySendCap = Math.min(
        entry.dailySendCap ?? env.CAMPAIGN_SENDER_DAILY_CAP_DEFAULT,
        env.CAMPAIGN_SENDER_DAILY_CAP_MAX
      );
      const maxPerHour = Math.min(
        entry.maxPerHour ?? env.CAMPAIGN_SENDER_MAX_PER_HOUR_DEFAULT,
        env.CAMPAIGN_SENDER_MAX_PER_HOUR_MAX
      );
      const effectiveDailyCap = Math.min(dailySendCap, account?.dailySendLimit ?? dailySendCap);
      const effectiveMaxPerHour = maxPerHour;

      const sendsToday = account?.sendsToday ?? 0;
      const reservedSends = account?.reservedSends ?? 0;
      const sendsThisHour = account?.sendsThisHour ?? 0;

      const nextSendAt = this.computeNextSendAt(entry, account, now);
      const dailyExhausted = sendsToday + reservedSends >= effectiveDailyCap;
      const hourlyExhausted = sendsThisHour + reservedSends >= effectiveMaxPerHour;
      const intervalElapsed = !nextSendAt || now.getTime() >= new Date(nextSendAt).getTime();

      let reasonCode: SenderQueueAccountState['reasonCode'];
      let reason: string | undefined;
      let ready = authorization.authorized && !dailyExhausted && !hourlyExhausted && intervalElapsed;
      if (!authorization.authorized) {
        reasonCode = authorization.reasonCode as SenderQueueAccountState['reasonCode'];
        reason = authorization.reason;
      } else if (dailyExhausted) {
        reasonCode = 'DAILY_LIMIT_REACHED';
        reason = `Daily cap of ${effectiveDailyCap} reached for this account.`;
      } else if (hourlyExhausted) {
        reasonCode = 'HOURLY_LIMIT_REACHED';
        reason = `Hourly cap of ${effectiveMaxPerHour} reached for this account.`;
      } else if (!intervalElapsed) {
        reasonCode = 'INTERVAL_NOT_ELAPSED';
        reason = `Next send is scheduled for ${toIso(nextSendAt)}.`;
      } else {
        // The mailbox may send right now, but there may be nothing that is due:
        // every remaining recipient is waiting for an approval or for the
        // delay of its follow-up step.
        const candidate = await this.findNextReadyRecipient(organizationId, campaign, entry);
        if (!candidate) {
          reasonCode = 'NO_READY_RECIPIENT';
          reason = 'No recipient is due to receive a message right now.';
          ready = false;
        }
      }

      states.push({
        accountId: entry.accountId,
        emailAddress: entry.emailAddress,
        displayName: account?.displayName,
        enabled: entry.enabled,
        authorized: authorization.authorized,
        reasonCode,
        reason,
        waiting: waitingByAccount.get(entry.accountId) ?? 0,
        sent: entry.sentCount ?? 0,
        dailySendCap,
        maxPerHour,
        minIntervalSeconds: entry.minIntervalSeconds ?? env.CAMPAIGN_SENDER_MIN_INTERVAL_SECONDS_DEFAULT,
        jitterSeconds: entry.jitterSeconds ?? env.CAMPAIGN_SENDER_JITTER_SECONDS_DEFAULT,
        effectiveDailyCap,
        effectiveMaxPerHour,
        sendsToday,
        sendsThisHour,
        reservedSends,
        nextSendAt: toIso(nextSendAt),
        lastSendAt: toIso(entry.lastSentAt ?? account?.lastSendAt ?? null),
        ready,
      });
    }

    return states;
  }

  /**
   * Dispatches one round of the campaign: at most one message per account and
   * only when the account's drip interval and caps allow it.
   *
   * The scheduler calls this on every tick. The manual "send now" endpoint
   * keeps using `campaignService.sendBatch`, which honours the same caps but
   * intentionally sends without the drip pacing.
   */
  async dispatch(
    organizationId: string,
    campaignId: string,
    actorId: string,
    options: { maxAccounts?: number } = {}
  ): Promise<SenderQueueDispatchResult> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const base: SenderQueueDispatchResult = {
      campaignId,
      status: campaign.status,
      sent: 0,
      deferred: 0,
      failed: 0,
      skipped: 0,
      legacy: false,
      accounts: [],
    };

    if (campaign.status === 'paused' || campaign.status === 'cancelled') {
      return base;
    }

    const roster = (campaign.senderAccounts || []).filter((entry) => entry.enabled);
    if (roster.length === 0) {
      base.legacy = true;
      return base;
    }

    const maxAccounts = Math.max(1, options.maxAccounts ?? roster.length);
    const now = new Date();

    for (const entry of roster.slice(0, maxAccounts)) {
      const outcome = await this.dispatchForAccount(organizationId, campaign, entry, actorId, now);
      base.sent += outcome.sent;
      base.deferred += outcome.deferred;
      base.failed += outcome.failed;
      base.skipped += outcome.skipped;
    }

    base.accounts = await this.describe(organizationId, campaignId);
    base.status = campaign.status;
    return base;
  }

  /**
   * Dispatches at most one message for a single sender account.
   */
  private async dispatchForAccount(
    organizationId: string,
    campaign: any,
    entry: any,
    actorId: string,
    now: Date
  ): Promise<{ sent: number; deferred: number; failed: number; skipped: number }> {
    const totals = { sent: 0, deferred: 0, failed: 0, skipped: 0 };

    const account = await EmailAccount.findOne({ _id: entry.accountId, organizationId });
    if (!account) {
      await this.markUnavailable(campaign, entry, 'ACCOUNT_NOT_FOUND', 'The connected account no longer exists.');
      return totals;
    }

    const authorization = evaluateAuthorization(account);
    if (!authorization.authorized) {
      await this.markUnavailable(
        campaign,
        entry,
        authorization.reasonCode as string,
        authorization.reason || 'The account is not authorized to send.'
      );
      return totals;
    }

    // The account works again: drop a stale "unavailable" marker of a former
    // outage so the campaign page does not keep showing an old problem.
    if (entry.unavailableReason || entry.unavailableReasonCode) {
      await this.updateProgress(campaign, entry, {
        unavailableReason: undefined,
        unavailableReasonCode: undefined,
      });
    }

    const minIntervalSeconds = entry.minIntervalSeconds ?? env.CAMPAIGN_SENDER_MIN_INTERVAL_SECONDS_DEFAULT;
    const jitterSeconds = entry.jitterSeconds ?? env.CAMPAIGN_SENDER_JITTER_SECONDS_DEFAULT;
    const dailyCap = Math.min(
      entry.dailySendCap ?? env.CAMPAIGN_SENDER_DAILY_CAP_DEFAULT,
      env.CAMPAIGN_SENDER_DAILY_CAP_MAX,
      account.dailySendLimit ?? env.CAMPAIGN_SENDER_DAILY_CAP_DEFAULT
    );
    const maxPerHour = Math.min(
      entry.maxPerHour ?? env.CAMPAIGN_SENDER_MAX_PER_HOUR_DEFAULT,
      env.CAMPAIGN_SENDER_MAX_PER_HOUR_MAX
    );

    // Roll the daily/hourly windows over before the counters are read.
    await senderAccountService.rollOverCounters(String(account._id), now);

    const counters = await EmailAccount.findOne({ _id: account._id })
      .select('sendsToday sendsThisHour reservedSends lastSendAt')
      .lean();

    const usedToday = (counters?.sendsToday ?? 0) + (counters?.reservedSends ?? 0);
    const usedThisHour = (counters?.sendsThisHour ?? 0) + (counters?.reservedSends ?? 0);
    if (usedToday >= dailyCap || usedThisHour >= maxPerHour) {
      // Transient: the cap rolls over, the account is not broken.
      await this.markThrottled(
        campaign,
        entry,
        this.windowResetAt(account, usedToday >= dailyCap ? 'daily' : 'hourly', now)
      );
      return totals;
    }

    // Drip pacing: the account may only send one message per interval.
    const nextSendAt = this.computeNextSendAt(entry, counters, now);
    if (nextSendAt && now.getTime() < new Date(nextSendAt).getTime()) {
      return totals;
    }

    const recipient = await this.findNextReadyRecipient(organizationId, campaign, entry);
    if (!recipient) {
      // Transient: a recipient may become due later, this is not an error.
      await this.markThrottled(campaign, entry);
      return totals;
    }

    // Claim the slot atomically so two workers cannot send the same account
    // at the same time.
    const claimed = await senderAccountService.reserveSendSlot(
      organizationId,
      String(account._id),
      { dailyCap, maxPerHour },
      now
    );
    if (!claimed) {
      // Another worker booked the slot first: try again on the next tick.
      await this.markThrottled(campaign, entry);
      return totals;
    }

    try {
      const outcome = await campaignService.sendRecipientStep(
        campaign,
        recipient,
        entry.emailAddress,
        actorId,
        { maxQuotaWaitMs: 2000 }
      );

      if (outcome.status === 'sent') {
        totals.sent += 1;
        await this.updateProgress(campaign, entry, {
          sentCount: (entry.sentCount ?? 0) + 1,
          lastSentAt: now,
          nextSendAt: this.nextInterval(now, minIntervalSeconds, jitterSeconds),
          lastError: undefined,
          unavailableReason: undefined,
          unavailableReasonCode: undefined,
        });
        return totals;
      }

      if (outcome.status === 'deferred') {
        totals.deferred += 1;
        await this.updateProgress(campaign, entry, {
          lastError: outcome.errorMessage,
          nextSendAt: new Date(now.getTime() + QUOTA_BACKOFF_SECONDS * 1000),
        });
        return totals;
      }

      if (outcome.status === 'failed') {
        totals.failed += 1;
        await this.updateProgress(campaign, entry, {
          lastError: outcome.errorMessage,
          nextSendAt: this.nextInterval(now, minIntervalSeconds, jitterSeconds),
        });
        return totals;
      }

      // Nothing was sent (recipient replied, is not due, ...): do not consume
      // the account's slot, try the next candidate on the next tick.
      totals.skipped += 1;
      return totals;
    } finally {
      await senderAccountService.releaseSendSlot(String(account._id));
    }
  }

  /**
   * Finds the next recipient of an account that can really be sent right now:
   * no reply, a next step with an approved draft, and the step delay elapsed.
   */
  private async findNextReadyRecipient(organizationId: string, campaign: any, entry: any): Promise<any | null> {
    const candidates = await CampaignRecipient.find({
      organizationId,
      campaignId: campaign._id,
      assignedAccountId: entry.accountId,
      status: { $in: ['approved', 'sending'] },
    })
      .sort({ rowNumber: 1 })
      .limit(CANDIDATE_SCAN_LIMIT);

    for (const candidate of candidates) {
      if (candidate.replied) continue;
      const nextStepIndex = candidate.completedSteps ?? 0;
      if (nextStepIndex >= (campaign.steps?.length ?? 0)) continue;
      const step = campaign.steps.find((s: any) => s.stepIndex === nextStepIndex);
      if (!step) continue;
      const slot = (candidate.stepDrafts || []).find((d: any) => d.stepIndex === nextStepIndex);
      if (!slot || !slot.draftId) continue;
      if (slot.status !== 'approved') continue;

      if (nextStepIndex > 0) {
        const lastSent = (candidate.stepDrafts || [])
          .filter((d: any) => d.sentAt)
          .sort((a: any, b: any) => a.sentAt.getTime() - b.sentAt.getTime())
          .at(-1)?.sentAt as Date | undefined;
        if (!this.isStepDue(lastSent, step.delayDays)) continue;
      }

      return candidate;
    }

    return null;
  }

  /** True when a follow-up step may be sent yet. */
  private isStepDue(lastSentAt: Date | undefined, delayDays: number): boolean {
    if (!lastSentAt || !delayDays) return true;
    const due = new Date(lastSentAt).getTime() + delayDays * 24 * 60 * 60 * 1000;
    return Date.now() >= due;
  }

  /**
   * The earliest time the account may send again: the roster's own
   * `nextSendAt` (drip pacing) or the interval after the last real send.
   */
  private computeNextSendAt(entry: any, account: any, now: Date): Date | undefined {
    const minIntervalSeconds = entry.minIntervalSeconds ?? env.CAMPAIGN_SENDER_MIN_INTERVAL_SECONDS_DEFAULT;
    const candidates: number[] = [];

    if (entry.nextSendAt) candidates.push(new Date(entry.nextSendAt).getTime());
    const lastSendAt = entry.lastSentAt ?? account?.lastSendAt;
    if (lastSendAt) {
      candidates.push(new Date(lastSendAt).getTime() + minIntervalSeconds * 1000);
    }

    if (candidates.length === 0) return undefined;
    const next = Math.max(...candidates);
    if (Number.isNaN(next) || next <= now.getTime()) return undefined;
    return new Date(next);
  }

  /** The next eligible send time after a send, including the jitter. */
  private nextInterval(from: Date, minIntervalSeconds: number, jitterSeconds: number): Date {
    const seconds = Math.max(1, minIntervalSeconds) + randomJitterSeconds(jitterSeconds);
    return new Date(from.getTime() + seconds * 1000);
  }

  /** Records that an account cannot be used and stops sending from it. */
  private async markUnavailable(
    campaign: any,
    entry: any,
    reasonCode: string,
    reason: string
  ): Promise<void> {
    await this.updateProgress(campaign, entry, {
      unavailableReason: reason,
      unavailableReasonCode: reasonCode,
      lastError: reason,
    });
  }

  /**
   * Records a *transient* state of the queue (a cap that is reached for now,
   * no recipient that is due yet, a slot another worker booked first).
   *
   * These are not errors and they are not permanent: the account becomes
   * usable again as soon as the window rolls over. They must therefore never
   * overwrite `unavailableReason`, which is reserved for a mailbox that
   * really cannot send (disconnected, revoked, paused, missing scope). The
   * live reason is computed by `describe()` from the real counters.
   */
  private async markThrottled(
    campaign: any,
    entry: any,
    nextSendAt?: Date
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (nextSendAt) patch.nextSendAt = nextSendAt;
    if (Object.keys(patch).length === 0) return;
    await this.updateProgress(campaign, entry, patch);
  }

  /**
   * The moment the exhausted window rolls over: the start of the next day for
   * the daily cap, the end of the current hour window for the hourly cap.
   */
  private windowResetAt(account: any, kind: 'daily' | 'hourly', now: Date): Date {
    if (kind === 'daily') {
      const resetAt = account?.sendsTodayResetAt ? new Date(account.sendsTodayResetAt) : null;
      if (resetAt && resetAt.getTime() > now.getTime()) return resetAt;
      const tomorrow = new Date(now);
      tomorrow.setHours(0, 0, 0, 0);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow;
    }

    const startedAt = account?.hourWindowStartedAt ? new Date(account.hourWindowStartedAt) : null;
    if (startedAt) {
      const end = new Date(startedAt.getTime() + 60 * 60 * 1000);
      if (end.getTime() > now.getTime()) return end;
    }
    return new Date(now.getTime() + 60 * 60 * 1000);
  }

  /** Persists the per-account progress of the roster with a targeted update. */
  private async updateProgress(campaign: any, entry: any, patch: Record<string, unknown>): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        set[`senderAccounts.$.${key}`] = null;
      } else {
        set[`senderAccounts.$.${key}`] = value;
      }
    }

    if (Object.keys(set).length === 0) return;

    await Campaign.updateOne(
      { _id: campaign._id, 'senderAccounts.accountId': entry.accountId },
      { $set: set }
    ).catch(() => undefined);
  }
}

export const senderQueueService = new SenderQueueService();

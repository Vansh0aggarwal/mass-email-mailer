import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { campaignService } from './campaign.service.js';
import { senderQueueService } from './sender-queue.service.js';

export interface ScheduleInput {
  startAt: string | Date;
  timezone?: string;
  batchSize?: number;
  paceMinutes?: number;
  windowStartHour?: number;
  windowEndHour?: number;
  /** Permitted weekdays (0 = Sunday ... 6 = Saturday) in the schedule timezone. */
  allowedWeekdays?: number[];
  /** Global minimum spacing between two sends of the same account (seconds). */
  minIntervalSeconds?: number;
  /** Global randomized extra spacing bound (seconds). */
  jitterSeconds?: number;
  /** Global per-account hourly rate cap. */
  maxPerHour?: number;
  /** Global per-account daily cap. */
  dailySendCap?: number;
  label?: string;
}

const MAX_CLAIM_BATCH = 20;

/** Returns the current hour (0-23) in the given IANA timezone. */
export function hourInTimezone(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(date);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    return hour === undefined ? date.getUTCHours() : parseInt(hour, 10) % 24;
  } catch {
    return date.getUTCHours();
  }
}

/** Returns the weekday (0 = Sunday ... 6 = Saturday) in the given IANA timezone. */
export function weekdayInTimezone(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).formatToParts(date);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const index = order.indexOf(weekday || '');
    return index >= 0 ? index : date.getUTCDay();
  } catch {
    return date.getUTCDay();
  }
}

/** True when `date` falls inside the configured local sending window. */
export function isWithinWindow(
  schedule: { timezone?: string; windowStartHour?: number; windowEndHour?: number },
  date: Date = new Date()
): boolean {
  const { windowStartHour: start, windowEndHour: end } = schedule;
  if (start === undefined || end === undefined) return true;
  const hour = hourInTimezone(date, schedule.timezone || 'UTC');
  if (start <= end) return hour >= start && hour < end;
  // Cross-midnight window (e.g. 22 -> 06)
  return hour >= start || hour < end;
}

/** True when the schedule permits sending on the weekday of `date`. */
export function isAllowedWeekday(
  schedule: { timezone?: string; allowedWeekdays?: number[] },
  date: Date = new Date()
): boolean {
  const allowed = schedule.allowedWeekdays;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(weekdayInTimezone(date, schedule.timezone || 'UTC'));
}

/** Validates an IANA timezone name. */
export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export class CampaignSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** Persists a durable schedule and moves the campaign to `scheduled`. */
  async schedule(organizationId: string, campaignId: string, actorId: string, input: ScheduleInput) {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');
    if (campaign.steps.length === 0) throw new AppError('Campaign has no email steps', 400, 'NO_STEPS');

    const startAt = new Date(input.startAt);
    if (isNaN(startAt.getTime())) throw new AppError('Invalid schedule start date', 400, 'INVALID_SCHEDULE');

    const timezone = input.timezone || 'UTC';
    if (!isValidTimezone(timezone)) throw new AppError(`Unknown timezone '${timezone}'`, 400, 'INVALID_TIMEZONE');

    const windowStartHour = input.windowStartHour;
    const windowEndHour = input.windowEndHour;
    if ((windowStartHour === undefined) !== (windowEndHour === undefined)) {
      throw new AppError('Both windowStartHour and windowEndHour must be provided together', 400, 'INVALID_WINDOW');
    }

    const allowedWeekdays = Array.isArray(input.allowedWeekdays)
      ? [...new Set(input.allowedWeekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : undefined;
    if (allowedWeekdays && allowedWeekdays.length === 0) {
      throw new AppError('allowedWeekdays must contain at least one day', 400, 'INVALID_WEEKDAYS');
    }

    const minIntervalSeconds = Math.min(Math.max(input.minIntervalSeconds ?? 0, 0), 86400);
    const jitterSeconds = Math.min(Math.max(input.jitterSeconds ?? 0, 0), 3600);
    const maxPerHour = Math.min(Math.max(input.maxPerHour ?? 0, 0), env.CAMPAIGN_SENDER_MAX_PER_HOUR_MAX);
    const dailySendCap = Math.min(Math.max(input.dailySendCap ?? 0, 0), env.CAMPAIGN_SENDER_DAILY_CAP_MAX);

    const approvedCount = await CampaignRecipient.countDocuments({
      organizationId,
      campaignId: campaign._id,
      status: { $in: ['approved', 'sending'] },
    });
    if (approvedCount === 0) {
      throw new AppError(
        'Approve at least one draft before scheduling the campaign.',
        400,
        'NO_APPROVED_RECIPIENTS'
      );
    }

    campaign.schedule = {
      startAt,
      timezone,
      batchSize: Math.min(Math.max(input.batchSize ?? 25, 1), 200),
      paceMinutes: Math.min(Math.max(input.paceMinutes ?? 0, 0), 1440),
      windowStartHour,
      windowEndHour,
      allowedWeekdays,
      minIntervalSeconds: minIntervalSeconds || undefined,
      jitterSeconds: jitterSeconds || undefined,
      maxPerHour: maxPerHour || undefined,
      dailySendCap: dailySendCap || undefined,
      label: input.label,
      scheduledBy: actorId,
      scheduledAt: new Date(),
      lastRunAt: undefined,
    } as any;

    // The campaign level pacing acts as the default for every mailbox of the
    // roster. A mailbox that was tuned explicitly keeps its own value.
    this.applyCampaignPacing(campaign, {
      minIntervalSeconds: minIntervalSeconds || undefined,
      jitterSeconds: jitterSeconds || undefined,
      maxPerHour: maxPerHour || undefined,
      dailySendCap: dailySendCap || undefined,
    });

    campaign.status = 'scheduled';
    await campaign.save();

    return {
      campaignId: campaign._id.toString(),
      status: campaign.status,
      schedule: campaign.schedule,
      approvedRecipients: approvedCount,
    };
  }

  /**
   * Copies the campaign level pacing onto the sender roster.
   *
   * Only mailboxes that still carry the built-in default are changed: a
   * mailbox whose limits were tuned on the campaign page keeps its own value.
   */
  private applyCampaignPacing(
    campaign: any,
    pacing: {
      minIntervalSeconds?: number;
      jitterSeconds?: number;
      maxPerHour?: number;
      dailySendCap?: number;
    }
  ): void {
    const roster = campaign.senderAccounts || [];
    if (roster.length === 0) return;

    for (const entry of roster) {
      if (
        pacing.minIntervalSeconds !== undefined &&
        entry.minIntervalSeconds === env.CAMPAIGN_SENDER_MIN_INTERVAL_SECONDS_DEFAULT
      ) {
        entry.minIntervalSeconds = pacing.minIntervalSeconds;
      }
      if (
        pacing.jitterSeconds !== undefined &&
        entry.jitterSeconds === env.CAMPAIGN_SENDER_JITTER_SECONDS_DEFAULT
      ) {
        entry.jitterSeconds = pacing.jitterSeconds;
      }
      if (pacing.maxPerHour !== undefined && entry.maxPerHour === env.CAMPAIGN_SENDER_MAX_PER_HOUR_DEFAULT) {
        entry.maxPerHour = pacing.maxPerHour;
      }
      if (pacing.dailySendCap !== undefined && entry.dailySendCap === env.CAMPAIGN_SENDER_DAILY_CAP_DEFAULT) {
        entry.dailySendCap = pacing.dailySendCap;
      }
    }
  }

  async pause(organizationId: string, campaignId: string) {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: campaignId, organizationId, status: { $in: ['scheduled', 'sending'] } },
      { $set: { status: 'paused' } },
      { new: true }
    );
    if (!campaign) throw new AppError('No active campaign to pause', 404, 'CAMPAIGN_NOT_FOUND');
    await this.setRosterPaused(campaign._id, true);
    return { campaignId: campaign._id.toString(), status: campaign.status };
  }

  async resume(organizationId: string, campaignId: string) {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');
    if (campaign.status !== 'paused') {
      throw new AppError('Only a paused campaign can be resumed', 400, 'NOT_PAUSED');
    }
    // Resume as a durable scheduled campaign if it has a schedule, otherwise
    // hand it back to manual batched sending.
    campaign.status = campaign.schedule ? 'scheduled' : 'ready_for_review';
    if (campaign.schedule) campaign.schedule.lastRunAt = undefined as any;
    await campaign.save();
    await this.setRosterPaused(campaign._id, false);
    return { campaignId: campaign._id.toString(), status: campaign.status };
  }

  /** Marks every sender account of a campaign as paused / active. */
  private async setRosterPaused(campaignId: any, paused: boolean): Promise<void> {
    await Campaign.updateOne(
      { _id: campaignId },
      { $set: { 'senderAccounts.$[entry].pausedAt': paused ? new Date() : null } },
      { arrayFilters: [{ 'entry.enabled': true }] }
    ).catch(() => undefined);
  }

  /**
   * Cancels a campaign.
   *
   * Cancelling must not only stop the scheduler: a worker that already picked
   * the campaign up must never send afterwards. Every unsent step of every
   * still-open recipient is therefore invalidated, so a late worker finds
   * nothing to send.
   */
  async cancel(organizationId: string, campaignId: string) {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: campaignId, organizationId, status: { $in: ['scheduled', 'paused', 'sending', 'ready_for_review'] } },
      { $set: { status: 'cancelled', lastError: 'Campaign cancelled' } },
      { new: true }
    );
    if (!campaign) throw new AppError('Campaign not found or already finished', 404, 'CAMPAIGN_NOT_FOUND');

    await this.invalidatePendingSteps(organizationId, campaign._id);

    return { campaignId: campaign._id.toString(), status: campaign.status, cancelled: true };
  }

  /**
   * Marks every unsent step of an open recipient as skipped, so no later
   * worker can pick the campaign up and send it.
   */
  private async invalidatePendingSteps(organizationId: string, campaignId: any): Promise<number> {
    const recipients = await CampaignRecipient.find({
      organizationId,
      campaignId,
      status: { $in: ['approved', 'sending', 'prepared', 'pending'] },
    }).select('_id stepDrafts status');

    let invalidated = 0;
    for (const recipient of recipients) {
      let changed = false;
      for (const slot of recipient.stepDrafts || []) {
        if (slot.status === 'sent') continue;
        if (slot.status === 'skipped') continue;
        slot.status = 'skipped';
        slot.error = 'Campaign cancelled before this step was sent.';
        changed = true;
      }
      if (changed) {
        recipient.status = 'skipped';
        recipient.canRetry = false;
        await recipient.save();
        invalidated += 1;
      }
    }

    return invalidated;
  }

  /**
   * Claims and processes one round of due scheduled campaigns. Atomic claims
   * prevent two workers (or overlapping ticks) from processing a campaign twice.
   */
  async processDueCampaigns(now: Date = new Date()): Promise<{ processed: number; details: any[] }> {
    const details: any[] = [];
    const candidates = await Campaign.find({
      status: 'scheduled',
      'schedule.startAt': { $lte: now },
    })
      .sort({ 'schedule.startAt': 1 })
      .limit(MAX_CLAIM_BATCH)
      .lean();

    for (const candidate of candidates) {
      const schedule = (candidate as any).schedule;
      if (!schedule) continue;

      if (!isWithinWindow(schedule, now)) {
        details.push({ campaignId: String(candidate._id), skipped: 'outside_window' });
        continue;
      }

      if (!isAllowedWeekday(schedule, now)) {
        details.push({ campaignId: String(candidate._id), skipped: 'weekday_not_allowed' });
        continue;
      }

      const paceMs = (schedule.paceMinutes || 0) * 60 * 1000;
      const lastRunAt = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
      if (paceMs > 0 && lastRunAt && now.getTime() - lastRunAt.getTime() < paceMs) {
        details.push({ campaignId: String(candidate._id), skipped: 'pace_not_elapsed' });
        continue;
      }

      // Atomic claim: only one worker wins this update.
      const claimed = await Campaign.findOneAndUpdate(
        {
          _id: candidate._id,
          status: 'scheduled',
          $or: [{ 'schedule.lastRunAt': { $exists: false } }, { 'schedule.lastRunAt': { $lte: lastRunAt || new Date(0) } }],
        },
        { $set: { 'schedule.lastRunAt': now, lastScheduledRunAt: now } },
        { new: true }
      );
      if (!claimed) continue;

      try {
        const organizationId = String(candidate.organizationId);
        const actorId = String(schedule.scheduledBy || candidate.createdBy);
        const roster = (candidate as any).senderAccounts || [];

        if (roster.length > 0) {
          // Multi-account drip: every sender account sends at most one message
          // per interval, so the campaign is paced by the roster, not by the
          // campaign level batch size.
          const dispatch = await senderQueueService.dispatch(organizationId, String(candidate._id), actorId);

          const remaining = await CampaignRecipient.countDocuments({
            organizationId,
            campaignId: candidate._id,
            status: { $in: ['approved', 'sending'] },
          });

          if (remaining === 0) {
            const pendingOrPrepared = await CampaignRecipient.countDocuments({
              organizationId,
              campaignId: candidate._id,
              status: { $in: ['pending', 'prepared'] },
            });
            await Campaign.updateOne(
              { _id: candidate._id },
              {
                $set: {
                  status: pendingOrPrepared > 0 ? 'ready_for_review' : 'completed',
                },
              }
            );
          } else {
            await Campaign.updateOne(
              { _id: candidate._id, status: { $ne: 'cancelled' } },
              { $set: { status: 'scheduled' } }
            );
          }

          details.push({
            campaignId: String(candidate._id),
            processed: dispatch.sent,
            deferred: dispatch.deferred,
            failed: dispatch.failed,
            remaining,
            accounts: dispatch.accounts.map((a) => ({
              accountId: a.accountId,
              emailAddress: a.emailAddress,
              sent: a.sent,
              waiting: a.waiting,
              ready: a.ready,
              reason: a.reason,
            })),
          });
          continue;
        }

        const result = await campaignService.sendBatch(
          organizationId,
          String(candidate._id),
          String(candidate.mailboxId),
          schedule.batchSize,
          actorId
        );

        const fresh = await Campaign.findById(candidate._id);
        if (fresh && result.remaining > 0 && fresh.status !== 'paused') {
          fresh.status = 'scheduled';
          await fresh.save();
        }
        details.push({ campaignId: String(candidate._id), processed: result.processed, remaining: result.remaining });
      } catch (err: any) {
        // Leave the campaign scheduled so a later tick can retry, unless the
        // failure is permanent (e.g. mailbox disconnected).
        await Campaign.updateOne(
          { _id: candidate._id },
          { $set: { lastError: err?.message || 'Scheduled send error' } }
        );
        details.push({ campaignId: String(candidate._id), error: err?.message || 'error' });
      }
    }

    return { processed: details.filter((d) => !d.error && !d.skipped).length, details };
  }

  /** Starts the background polling loop (no-op unless enabled). */
  start(): void {
    if (!env.CAMPAIGN_SCHEDULER_ENABLED || this.timer) return;
    const interval = Math.max(env.CAMPAIGN_SCHEDULER_INTERVAL_MS, 5000);
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    // Do not keep the process alive solely for the scheduler.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // Run one tick shortly after boot to recover work missed during downtime.
    setTimeout(() => void this.tick(), 3000).unref?.();
    console.log(`[Campaign Scheduler] Started (interval ${interval}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return; // avoid overlapping ticks
    this.running = true;
    try {
      await this.processDueCampaigns();
    } catch (err: any) {
      console.error('[Campaign Scheduler] tick failed:', err?.message || err);
    } finally {
      this.running = false;
    }
  }
}

export const campaignSchedulerService = new CampaignSchedulerService();

import { EmailAccount } from '../models/EmailAccount.js';
import { gmailProvider } from '../providers/email/gmail.provider.js';
import { gmailQuotaService, GMAIL_METHOD_QUOTA_COST } from './gmail-quota.service.js';

export class MailboxSyncWorkerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private intervalMs = 60000; // 60 seconds

  /**
   * Minimum time between two syncs of the same mailbox.
   *
   * Gmail bills a full thread sync at `threads.list (10) + N x threads.get
   * format=full (120)` units, which is 3,010 units for 25 threads — half of a
   * mailbox's entire 6,000 units/minute budget. Re-syncing every mailbox every
   * minute therefore starved outbound sending. Syncing less often (and only
   * what the budget can afford) keeps the mailbox quota available for sends.
   */
  private minSyncIntervalMs = 300000; // 5 minutes

  /** Units kept aside so a mailbox always has room for an interactive send. */
  private interactiveReserveUnits = 400;

  start(intervalMs = 60000): void {
    if (this.timer) return;
    this.intervalMs = Math.max(intervalMs, 10000);

    // Run first sync shortly after boot
    setTimeout(() => void this.syncAllMailboxes(), 5000).unref?.();

    this.timer = setInterval(() => {
      void this.syncAllMailboxes();
    }, this.intervalMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    console.log(`[Mailbox Sync Worker] Started (interval: ${this.intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[Mailbox Sync Worker] Stopped');
    }
  }

  /**
   * How many threads this mailbox can afford to sync right now, given the
   * remaining quota budget. A full thread costs `threads.get format=full`.
   */
  private async affordableThreadCount(mailboxKey: string, desired: number): Promise<number> {
    const threadCost = GMAIL_METHOD_QUOTA_COST['threads.get.full'] ?? 120;
    const state = await gmailQuotaService.getState(mailboxKey).catch(() => null);
    if (!state) return desired;

    const usable = Math.max(0, state.tokens - this.interactiveReserveUnits);
    const affordable = Math.floor(usable / threadCost);
    return Math.max(0, Math.min(desired, affordable));
  }

  async syncAllMailboxes(): Promise<{ synced: number; errors: number; skipped: number }> {
    if (this.running) return { synced: 0, errors: 0, skipped: 0 };
    this.running = true;

    let synced = 0;
    let errors = 0;
    let skipped = 0;

    try {
      const activeAccounts = await EmailAccount.find({
        provider: 'gmail',
        status: 'connected',
        isPaused: { $ne: true },
      }).lean();

      for (const account of activeAccounts) {
        try {
          const lastSyncedAt = account.lastSyncedAt ? new Date(account.lastSyncedAt) : undefined;
          if (lastSyncedAt && Date.now() - lastSyncedAt.getTime() < this.minSyncIntervalMs) {
            skipped++;
            continue;
          }

          const mailboxKey = account.emailAddress.toLowerCase();
          const maxThreads = await this.affordableThreadCount(mailboxKey, 25);
          if (maxThreads <= 0) {
            // No budget left for background work right now — try again later.
            skipped++;
            continue;
          }

          const count = await gmailProvider.syncThreadsToDb(
            account.organizationId,
            account.emailAddress,
            { maxThreads }
          );
          synced += count;
        } catch (err: any) {
          // A deferred (quota limited) mailbox is not an error: it is retried
          // on the next tick once the budget refills.
          if (err?.code === 'GMAIL_QUOTA_EXCEEDED' || err?.code === 'GMAIL_QUOTA_EXHAUSTED') {
            skipped++;
            continue;
          }
          errors++;
          console.warn(
            `[Mailbox Sync Worker] Failed to sync mailbox ${account.emailAddress}:`,
            err?.message || err
          );
        }
      }
    } catch (err: any) {
      console.error('[Mailbox Sync Worker] Loop error:', err?.message || err);
    } finally {
      this.running = false;
    }

    return { synced, errors, skipped };
  }
}

export const mailboxSyncWorkerService = new MailboxSyncWorkerService();

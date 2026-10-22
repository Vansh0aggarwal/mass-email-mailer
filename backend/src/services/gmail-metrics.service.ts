/**
 * Operational metrics for Gmail API usage.
 *
 * Every counter is safe to log: no access tokens, no refresh tokens, no
 * message bodies, no recipient addresses — only the mailbox address, the
 * Gmail method name and numeric counters.
 *
 * Counters are kept in-process for cheap increments and are periodically
 * flushed to MongoDB so the numbers survive a restart and can be read by any
 * worker.
 */
import { Schema, model, models } from 'mongoose';

export interface GmailMethodMetric {
  calls: number;
  failures: number;
  quotaErrors: number;
  units: number;
  retries: number;
}

export interface GmailMailboxMetric {
  mailboxKey: string;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  quotaErrors: number;
  retries: number;
  deferredCalls: number;
  waitMs: number;
  unitsConsumed: number;
  lastCallAt?: number;
  lastQuotaErrorAt?: number;
  lastError?: string;
  byMethod: Record<string, GmailMethodMetric>;
  updatedAt: Date;
}

const GmailApiMetricsSchema = new Schema({
  mailboxKey: { type: String, required: true, unique: true, index: true },
  totalCalls: { type: Number, default: 0 },
  successCalls: { type: Number, default: 0 },
  failedCalls: { type: Number, default: 0 },
  quotaErrors: { type: Number, default: 0 },
  retries: { type: Number, default: 0 },
  deferredCalls: { type: Number, default: 0 },
  waitMs: { type: Number, default: 0 },
  unitsConsumed: { type: Number, default: 0 },
  lastCallAt: { type: Number },
  lastQuotaErrorAt: { type: Number },
  lastError: { type: String },
  byMethod: { type: Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: () => new Date() },
});

export const GmailApiMetricsModel =
  (models.GmailApiMetrics as any) ||
  model('GmailApiMetrics', GmailApiMetricsSchema);

const emptyMethodMetric = (): GmailMethodMetric => ({
  calls: 0,
  failures: 0,
  quotaErrors: 0,
  units: 0,
  retries: 0,
});

export class GmailApiMetricsService {
  private metrics = new Map<string, GmailMailboxMetric>();
  private flushTimer: NodeJS.Timeout | null = null;

  private ensure(mailboxKey: string): GmailMailboxMetric {
    let metric = this.metrics.get(mailboxKey);
    if (!metric) {
      metric = {
        mailboxKey,
        totalCalls: 0,
        successCalls: 0,
        failedCalls: 0,
        quotaErrors: 0,
        retries: 0,
        deferredCalls: 0,
        waitMs: 0,
        unitsConsumed: 0,
        byMethod: {},
        updatedAt: new Date(),
      };
      this.metrics.set(mailboxKey, metric);
    }
    return metric;
  }

  private method(mailboxKey: string, method: string): GmailMethodMetric {
    const metric = this.ensure(mailboxKey);
    if (!metric.byMethod[method]) metric.byMethod[method] = emptyMethodMetric();
    return metric.byMethod[method];
  }

  recordCall(mailboxKey: string, method: string, units: number): void {
    const metric = this.ensure(mailboxKey);
    const byMethod = this.method(mailboxKey, method);
    metric.totalCalls += 1;
    metric.unitsConsumed += units;
    metric.lastCallAt = Date.now();
    byMethod.calls += 1;
    byMethod.units += units;
    metric.updatedAt = new Date();
  }

  recordSuccess(mailboxKey: string, method: string): void {
    this.ensure(mailboxKey).successCalls += 1;
    this.method(mailboxKey, method);
  }

  recordFailure(mailboxKey: string, method: string, message: string): void {
    const metric = this.ensure(mailboxKey);
    metric.failedCalls += 1;
    metric.lastError = message.slice(0, 300);
    this.method(mailboxKey, method).failures += 1;
    metric.updatedAt = new Date();
  }

  recordQuotaError(mailboxKey: string, method: string): void {
    const metric = this.ensure(mailboxKey);
    metric.quotaErrors += 1;
    metric.lastQuotaErrorAt = Date.now();
    this.method(mailboxKey, method).quotaErrors += 1;
    metric.updatedAt = new Date();
  }

  recordRetry(mailboxKey: string, method: string): void {
    this.ensure(mailboxKey).retries += 1;
    this.method(mailboxKey, method).retries += 1;
  }

  recordDeferred(mailboxKey: string, waitMs: number): void {
    const metric = this.ensure(mailboxKey);
    metric.deferredCalls += 1;
    metric.waitMs += waitMs;
    metric.updatedAt = new Date();
  }

  recordWait(mailboxKey: string, waitMs: number): void {
    const metric = this.ensure(mailboxKey);
    metric.waitMs += waitMs;
    metric.updatedAt = new Date();
  }

  get(mailboxKey: string): GmailMailboxMetric | undefined {
    return this.metrics.get(mailboxKey);
  }

  snapshot(): GmailMailboxMetric[] {
    return Array.from(this.metrics.values()).map((m) => ({
      ...m,
      byMethod: JSON.parse(JSON.stringify(m.byMethod)),
    }));
  }

  reset(): void {
    this.metrics.clear();
  }

  /** Persists the current counters so any worker (or a later boot) can read them. */
  async flush(): Promise<void> {
    for (const metric of this.metrics.values()) {
      await GmailApiMetricsModel.updateOne(
        { mailboxKey: metric.mailboxKey },
        {
          $set: {
            totalCalls: metric.totalCalls,
            successCalls: metric.successCalls,
            failedCalls: metric.failedCalls,
            quotaErrors: metric.quotaErrors,
            retries: metric.retries,
            deferredCalls: metric.deferredCalls,
            waitMs: metric.waitMs,
            unitsConsumed: metric.unitsConsumed,
            lastCallAt: metric.lastCallAt,
            lastQuotaErrorAt: metric.lastQuotaErrorAt,
            lastError: metric.lastError,
            byMethod: metric.byMethod,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      ).catch(() => undefined);
    }
  }

  startAutoFlush(intervalMs = 60000): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, intervalMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export const gmailApiMetrics = new GmailApiMetricsService();

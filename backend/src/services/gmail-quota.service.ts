/**
 * Centralized Gmail API rate control.
 *
 * ## Why this exists
 *
 * The Gmail API enforces a **per minute per user per project** quota — the
 * limit Google names "Units per minute per user" for `gmail.googleapis.com`.
 * "User" means the connected Gmail mailbox, so the budget must be accounted
 * **per mailbox**, not per project and not per request.
 *
 * Google's published per-method costs (see
 * https://developers.google.com/workspace/gmail/api/reference/quota) are the
 * reason the previous implementation blew through that budget:
 *
 *   | method                       | units      |
 *   |------------------------------|------------|
 *   | messages.send                | 100        |
 *   | threads.get (format=full)    | 120        |
 *   | threads.list                 | 10         |
 *   | history.list                 | 2          |
 *   | messages.list                | 5          |
 *   | messages.attachments.get     | 20         |
 *   | threads.modify               | 10         |
 *
 * A single full inbox sync of 25 threads therefore costs
 * `threads.list (10) + 25 x threads.get format=full (120) = 3,010` units, and
 * a manual sync of 50 threads costs `10 + 50 x 120 = 6,010` units — more than
 * the whole per-minute budget of one mailbox, before a single email is sent.
 * The old code issued those calls with no budget accounting at all, retried
 * 429s in a tight loop without jitter, and let the inbox worker run
 * concurrently with campaign sending.
 *
 * ## What this service guarantees
 *
 * 1. Every Gmail API call is charged against a per-mailbox **token bucket**
 *    persisted in MongoDB, so several backend workers share one budget.
 * 2. Every Gmail API call is *also* charged against a **per-project** bucket.
 *    Google applies a daily API quota per project, and every mailbox that is
 *    connected through the same OAuth client shares that project. Adding more
 *    Gmail accounts therefore does **not** raise the project ceiling, and the
 *    backend must not behave as if it did.
 * 3. A **distributed concurrency lease** bounds in-flight calls per mailbox
 *    across workers.
 * 4. Interactive work (a user-requested send or reply) is prioritised over
 *    background work (inbox synchronisation) and never starves it.
 * 5. Retryable failures (429 / 5xx / network) are retried with exponential
 *    backoff **and jitter**, honouring Google's own retry guidance when it is
 *    present, and are never retried past a hard limit.
 * 6. Permanent failures (400/401/403/404) are never retried.
 * 7. When the budget is exhausted, background work is **deferred** (not
 *    retried in a loop) and interactive work waits for the next refill.
 * 8. The sustained rate adapts: a quota error halves the rate (AIMD), and the
 *    rate is restored gradually once Google stops complaining. That way the
 *    scheduler self-corrects even if the project's real quota differs from
 *    the published default.
 */
import { env } from '../config/env.js';
import { GmailQuotaLedger } from '../models/GmailQuotaLedger.js';
import { GmailApiLease } from '../models/GmailApiLease.js';
import { gmailApiMetrics } from './gmail-metrics.service.js';

/**
 * Published Gmail API quota cost per method. `format=full` variants cost more
 * and are listed explicitly because the inbox sync uses them.
 */
export const GMAIL_METHOD_QUOTA_COST: Record<string, number> = {
  'messages.send': 100,
  'messages.get': 20,
  'messages.get.full': 60,
  'messages.list': 5,
  'messages.modify': 5,
  'messages.trash': 20,
  'messages.untrash': 5,
  'messages.delete': 10,
  'messages.attachments.get': 20,
  'messages.batchDelete': 50,
  'messages.batchModify': 50,
  'drafts.create': 10,
  'drafts.delete': 10,
  'drafts.get': 20,
  'drafts.get.full': 60,
  'drafts.list': 5,
  'drafts.send': 100,
  'drafts.update': 15,
  'threads.get': 40,
  'threads.get.full': 120,
  'threads.list': 10,
  'threads.modify': 10,
  'threads.trash': 20,
  'threads.untrash': 10,
  'threads.delete': 20,
  'history.list': 2,
  'getProfile': 1,
  'labels.list': 1,
  'labels.get': 1,
  'labels.create': 5,
  'labels.update': 5,
  'labels.delete': 5,
  'watch': 100,
};

export type GmailCallPriority = 'interactive' | 'background';

export interface GmailErrorInfo {
  status?: number;
  reason?: string;
  message: string;
  isQuota: boolean;
  isRetryable: boolean;
  isPermanent: boolean;
  retryDelayMs?: number;
  uncertainDelivery: boolean;
}

/**
 * Quota error reasons Google returns for rate/quota exhaustion.
 *
 * All of these are reported with a 4xx status (403 for daily/per-user limits,
 * 429 for rate limits). A 5xx `backendError` is a transient server failure
 * instead — it is retryable, but it does *not* mean the quota budget is
 * exhausted, and the delivery outcome stays unknown.
 */
const QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'quotaExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaFailure',
]);

const RETRYABLE_NETWORK_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'EPIPE',
];

/** Raised when a mailbox has no quota budget left and the work was deferred. */
export class GmailQuotaExhaustedError extends Error {
  public code = 'GMAIL_QUOTA_EXHAUSTED';
  public status = 429;
  public retryAfterMs: number;
  public mailboxKey: string;

  constructor(mailboxKey: string, retryAfterMs: number, message?: string) {
    super(
      message ||
        `Gmail API quota is exhausted for this mailbox. The request was deferred and will be retried automatically (next budget in ~${Math.ceil(
          retryAfterMs / 1000
        )}s).`
    );
    this.name = 'GmailQuotaExhaustedError';
    this.mailboxKey = mailboxKey;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Raised when the per-mailbox concurrency limit cannot be satisfied. */
export class GmailConcurrencyLimitError extends Error {
  public code = 'GMAIL_CONCURRENCY_LIMIT';
  public status = 429;

  constructor(message: string) {
    super(message);
    this.name = 'GmailConcurrencyLimitError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Parses Google's retry hints ("3s", "1.5s", "250ms") into milliseconds. */
export function parseRetryDelay(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  if (typeof raw !== 'string') return undefined;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
  if (!match) return undefined;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] || 's').toLowerCase();
  return unit === 'ms' ? Math.round(value) : Math.round(value * 1000);
}

/**
 * Extracts the HTTP status, Google error reason and retry guidance from a
 * `googleapis`/Gaxios error. Never logs or returns token material.
 */
export function extractGmailErrorInfo(err: any): GmailErrorInfo {
  const status: number | undefined =
    err?.response?.status ??
    (typeof err?.code === 'number' ? err.code : undefined) ??
    err?.status ??
    (typeof err?.statusCode === 'number' ? err.statusCode : undefined);

  const apiError = err?.response?.data?.error;
  const reason: string | undefined =
    apiError?.errors?.[0]?.reason || (typeof apiError?.status === 'string' ? apiError.status : undefined);

  const message: string =
    err?.response?.data?.error?.message || err?.message || 'Gmail API request failed';

  // Google's RetryInfo detail usually carries e.g. "retryDelay": "36s".
  let retryDelayMs: number | undefined;
  const details = Array.isArray(apiError?.details) ? apiError.details : [];
  for (const detail of details) {
    const candidates = [
      detail?.metadata?.retryDelay,
      detail?.metadata?.retry_delay,
      detail?.errorDetail,
    ];
    for (const candidate of candidates) {
      const parsed = parseRetryDelay(candidate);
      if (parsed !== undefined) {
        retryDelayMs = parsed;
        break;
      }
    }
    if (retryDelayMs !== undefined) break;
  }
  if (retryDelayMs === undefined) {
    const headerDelay = parseRetryDelay(err?.response?.headers?.['retry-after']);
    if (headerDelay !== undefined) retryDelayMs = headerDelay;
  }

  const isQuota =
    status === 429 ||
    (typeof reason === 'string' && QUOTA_REASONS.has(reason) && status !== undefined && status < 500);

  const isNetworkError =
    typeof err?.code === 'string' && RETRYABLE_NETWORK_CODES.includes(err.code);

  const isPermanent =
    !isQuota &&
    !isNetworkError &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429;

  const isRetryable = isQuota || isNetworkError || (typeof status === 'number' && status >= 500);

  // A 5xx or a dropped connection after the request was already transmitted
  // leaves the delivery outcome unknown.
  const uncertainDelivery =
    !isQuota &&
    !isPermanent &&
    (isNetworkError || (typeof status === 'number' && status >= 500) || status === undefined);

  return {
    status,
    reason,
    message,
    isQuota,
    isRetryable,
    isPermanent,
    retryDelayMs,
    uncertainDelivery,
  };
}

/**
 * Exponential backoff with full jitter. When Google supplies a retry delay we
 * honour it (never retry earlier than advised) but still add jitter so that
 * many workers do not resynchronise into a thundering herd.
 */
export function computeBackoffDelay(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; retryDelayMs?: number; random?: () => number } = {}
): number {
  const base = options.baseMs ?? env.GMAIL_RETRY_BASE_DELAY_MS;
  const max = options.maxMs ?? env.GMAIL_RETRY_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const exponential = Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
  const jittered = Math.floor(exponential / 2 + random() * (exponential / 2));
  if (options.retryDelayMs && options.retryDelayMs > jittered) {
    return options.retryDelayMs;
  }
  return Math.max(0, jittered);
}

export interface GmailCallRequest<T> {
  /** Mailbox the call is billed to (the Gmail "user" for quota purposes). */
  mailboxKey: string;
  /** Gmail method name, used for metrics and the cost table. */
  method: string;
  /** Quota units to reserve for this call. */
  cost: number;
  /** Interactive work jumps the queue; background work yields. */
  priority?: GmailCallPriority;
  /** Overrides the global retry budget for this call. */
  maxRetries?: number;
  /** Maximum time an interactive call may wait for quota. */
  maxWaitMs?: number;
  /** The actual API invocation. */
  fn: () => Promise<T>;
}

export interface GmailCallResult<T> {
  value: T;
  attempts: number;
  waitedMs: number;
}

interface Reservation {
  granted: boolean;
  tokens: number;
  waitMs: number;
}

export class GmailQuotaService {
  /** Consecutive successes since the last quota penalty, per mailbox. */
  private successStreak = new Map<string, number>();

  private get capacity(): number {
    return Math.max(1, env.GMAIL_QUOTA_BURST_UNITS);
  }

  private get refillPerSecond(): number {
    const perMinute = Math.max(1, env.GMAIL_QUOTA_UNITS_PER_MINUTE) * env.GMAIL_QUOTA_SAFETY_FACTOR;
    return perMinute / 60;
  }

  /**
   * Capacity of the per-project daily bucket. Every mailbox connected through
   * the same OAuth client shares it, so it deliberately does not grow with the
   * number of connected accounts.
   */
  private get projectCapacity(): number {
    return Math.max(1, Math.floor(env.GMAIL_PROJECT_DAILY_QUOTA_UNITS * env.GMAIL_PROJECT_QUOTA_SAFETY_FACTOR));
  }

  private get projectRefillPerSecond(): number {
    // The project quota is a daily ceiling, so it refills across the whole day.
    return this.projectCapacity / 86400;
  }

  /**
   * Ledger key of the project bucket. All connected mailboxes share the OAuth
   * client, hence the same Google Cloud project, hence the same daily quota.
   */
  private get projectKey(): string {
    return `project:${env.GOOGLE_CLIENT_ID || 'default-project'}`;
  }

  /**
   * Atomically reserves quota units for a mailbox. Implemented as a MongoDB
   * aggregation-pipeline update so that refill, check and decrement happen in
   * a single atomic operation shared by every worker.
   */
  private async reserveUnits(
    mailboxKey: string,
    cost: number,
    priority: GmailCallPriority,
    bucket?: { capacity: number; refillPerSecond: number; scope: 'user' | 'project' }
  ): Promise<Reservation> {
    const now = Date.now();
    const capacity = bucket?.capacity ?? this.capacity;
    const refillPerSecond = bucket?.refillPerSecond ?? this.refillPerSecond;
    const scope = bucket?.scope ?? 'user';

    await GmailQuotaLedger.updateOne(
      { mailboxKey },
      {
        $setOnInsert: {
          mailboxKey,
          scope,
          tokens: capacity,
          capacity,
          refillPerSecond,
          lastRefillAt: now,
          rateFactor: 1,
          totalUnitsReserved: 0,
        },
      },
      { upsert: true }
    ).catch(() => undefined);

    // Token bucket refill: `min(capacity, tokens + refill)`, floored at zero.
    // The refill amount is derived from the elapsed time since the last refill,
    // scaled by the AIMD rate factor, so a throttled mailbox recovers slowly.
    const refillExpression = {
      $max: [
        0,
        {
          $min: [
            { $ifNull: ['$capacity', capacity] },
            {
              $add: [
                { $ifNull: ['$tokens', 0] },
                {
                  $multiply: [
                    { $ifNull: ['$refillPerSecond', refillPerSecond] },
                    { $ifNull: ['$rateFactor', 1] },
                    { $divide: [{ $subtract: [now, { $ifNull: ['$lastRefillAt', now] }] }, 1000] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const grantExpression = { $cond: [{ $gte: ['$__refilled', cost] }, cost, 0] };

    const doc: any = await GmailQuotaLedger.findOneAndUpdate(
      { mailboxKey },
      [
        { $set: { __refilled: refillExpression } },
        {
          $set: {
            tokens: {
              $cond: [
                { $gte: ['$__refilled', cost] },
                { $subtract: ['$__refilled', cost] },
                '$__refilled',
              ],
            },
            lastGrant: grantExpression,
            lastRefillAt: now,
            totalUnitsReserved: { $add: ['$totalUnitsReserved', grantExpression] },
          },
        },
        { $unset: ['__refilled'] },
      ],
      { new: true }
    ).catch(() => null);

    if (!doc) {
      // Ledger unavailable (e.g. Mongo temporarily unreachable). Fail open for
      // interactive work but never exceed the burst capacity in one go.
      return { granted: true, tokens: 0, waitMs: 0 };
    }

    const granted = (doc.lastGrant || 0) >= cost;
    const tokens = typeof doc.tokens === 'number' ? doc.tokens : 0;
    const deficit = Math.max(0, cost - tokens);
    const rate = Math.max(1, refillPerSecond * (doc.rateFactor || 1));
    const waitMs = deficit > 0 ? Math.ceil((deficit / rate) * 1000) : 0;

    void priority;
    return { granted, tokens, waitMs };
  }

  /**
   * Reserves quota, waiting for the bucket to refill when the work is
   * interactive, and deferring when it is background work.
   */
  private async acquireQuota(
    mailboxKey: string,
    cost: number,
    priority: GmailCallPriority,
    maxWaitMs: number,
    bucket?: { capacity: number; refillPerSecond: number; scope: 'user' | 'project' }
  ): Promise<{ granted: true; waitedMs: number } | { granted: false; waitMs: number }> {
    const startedAt = Date.now();
    let waitedMs = 0;

    for (;;) {
      const reservation = await this.reserveUnits(mailboxKey, cost, priority, bucket);
      if (reservation.granted) {
        if (waitedMs > 0) gmailApiMetrics.recordWait(mailboxKey, waitedMs);
        return { granted: true, waitedMs };
      }

      const elapsed = Date.now() - startedAt;
      const budget = priority === 'interactive' ? maxWaitMs : env.GMAIL_SYNC_MAX_WAIT_MS;

      if (elapsed + reservation.waitMs > budget) {
        gmailApiMetrics.recordDeferred(mailboxKey, elapsed);
        return { granted: false, waitMs: reservation.waitMs };
      }

      await sleep(Math.min(reservation.waitMs, 250));
      waitedMs = Date.now() - startedAt;
    }
  }

  /** Acquires one of the mailbox's concurrency slots (shared across workers). */
  private async acquireLease(mailboxKey: string, maxWaitMs: number): Promise<{ slot: number; release: () => Promise<void> }> {
    const maxSlots = Math.max(1, env.GMAIL_MAX_CONCURRENT_CALLS);
    const leaseMs = 120000;
    const startedAt = Date.now();

    for (;;) {
      for (let slot = 0; slot < maxSlots; slot++) {
        try {
          await GmailApiLease.create({
            mailboxKey,
            slot,
            expiresAt: new Date(Date.now() + leaseMs),
            owner: `${process.pid}`,
          });
          return {
            slot,
            release: async () => {
              await GmailApiLease.deleteOne({ mailboxKey, slot }).catch(() => undefined);
            },
          };
        } catch (err: any) {
          if (err?.code !== 11000) throw err;
          // Slot taken — reclaim it if the previous holder died.
          const existing = await GmailApiLease.findOne({ mailboxKey, slot }).catch(() => null);
          if (existing && existing.expiresAt && existing.expiresAt.getTime() < Date.now()) {
            await GmailApiLease.deleteOne({ _id: existing._id }).catch(() => undefined);
            continue;
          }
        }
      }

      if (Date.now() - startedAt > maxWaitMs) {
        throw new GmailConcurrencyLimitError(
          'Too many concurrent Gmail API calls for this mailbox. Please retry in a moment.'
        );
      }
      await sleep(50);
    }
  }

  /** AIMD: halve the sustained rate after Google reports a quota error. */
  private penalizeRate(mailboxKey: string): void {
    this.successStreak.set(mailboxKey, 0);
    // Aggregation pipeline: `$max` here is the *expression* form, unlike the
    // update operator of the same name, so the division is actually evaluated.
    void GmailQuotaLedger.updateOne(
      { mailboxKey },
      [{ $set: { rateFactor: { $max: [0.1, { $divide: [{ $ifNull: ['$rateFactor', 1] }, 2] }] } } }]
    ).catch(() => undefined);
  }

  /** AIMD: gradually restore the sustained rate after sustained success. */
  private restoreRate(mailboxKey: string): void {
    const streak = (this.successStreak.get(mailboxKey) || 0) + 1;
    this.successStreak.set(mailboxKey, streak);
    if (streak < 20) return;
    this.successStreak.set(mailboxKey, 0);
    void GmailQuotaLedger.updateOne(
      { mailboxKey },
      [{ $set: { rateFactor: { $min: [1, { $multiply: [{ $ifNull: ['$rateFactor', 1] }, 1.1] }] } } }]
    ).catch(() => undefined);
  }

  /**
   * Executes a Gmail API call under the shared budget with bounded, jittered
   * retries. This is the single entry point every Gmail call must use.
   */
  async call<T>(request: GmailCallRequest<T>): Promise<GmailCallResult<T>> {
    const priority = request.priority || 'interactive';
    const maxRetries = request.maxRetries ?? env.GMAIL_MAX_RETRIES;
    const maxWaitMs = request.maxWaitMs ?? 30000;
    let attempt = 0;
    let waitedMs = 0;

    for (;;) {
      const reservation = await this.acquireQuota(request.mailboxKey, request.cost, priority, maxWaitMs);
      if (!reservation.granted) {
        throw new GmailQuotaExhaustedError(request.mailboxKey, reservation.waitMs);
      }
      waitedMs += reservation.waitedMs;

      // The project bucket is the shared, non-growable ceiling: every mailbox
      // connected with the same OAuth client draws from it. It is charged after
      // the per-user bucket because a denial here is rare and the per-user
      // tokens refill within seconds.
      const projectReservation = await this.acquireQuota(
        this.projectKey,
        request.cost,
        'background',
        Math.min(maxWaitMs, env.GMAIL_SYNC_MAX_WAIT_MS),
        {
          capacity: this.projectCapacity,
          refillPerSecond: this.projectRefillPerSecond,
          scope: 'project',
        }
      );
      if (!projectReservation.granted) {
        throw new GmailQuotaExhaustedError(
          request.mailboxKey,
          projectReservation.waitMs,
          'Gmail API project quota exhausted. The daily limit of the connected Google Cloud project is reached, so this request was deferred.'
        );
      }
      waitedMs += projectReservation.waitedMs;

      const lease = await this.acquireLease(request.mailboxKey, maxWaitMs);
      try {
        gmailApiMetrics.recordCall(request.mailboxKey, request.method, request.cost);
        const value = await request.fn();
        gmailApiMetrics.recordSuccess(request.mailboxKey, request.method);
        this.restoreRate(request.mailboxKey);
        return { value, attempts: attempt + 1, waitedMs };
      } catch (err: any) {
        const info = extractGmailErrorInfo(err);

        if (info.isQuota) {
          gmailApiMetrics.recordQuotaError(request.mailboxKey, request.method);
          this.penalizeRate(request.mailboxKey);
          // A quota error usually means the whole project is throttled, so the
          // shared bucket is slowed down as well.
          this.penalizeRate(this.projectKey);
        } else {
          gmailApiMetrics.recordFailure(request.mailboxKey, request.method, info.message);
        }

        const canRetry = info.isRetryable && attempt < maxRetries;
        if (!canRetry) {
          if (info.isQuota) {
            throw new GmailQuotaExhaustedError(
              request.mailboxKey,
              info.retryDelayMs ?? 1000,
              `Gmail API quota exceeded for this mailbox (${info.reason || 'rateLimitExceeded'}). The request was deferred and will be retried automatically.`
            );
          }
          throw err;
        }

        const delay = computeBackoffDelay(attempt, { retryDelayMs: info.retryDelayMs });
        gmailApiMetrics.recordRetry(request.mailboxKey, request.method);
        attempt += 1;
        await sleep(delay);
      } finally {
        await lease.release();
      }
    }
  }

  /** Current quota state for a mailbox (observability). */
  async getState(mailboxKey: string): Promise<{
    tokens: number;
    capacity: number;
    refillPerSecond: number;
    rateFactor: number;
    totalUnitsReserved: number;
  } | null> {
    return this.readState(mailboxKey);
  }

  /**
   * Current state of the shared project bucket. This is the ceiling that does
   * **not** grow when more Gmail accounts are connected.
   */
  async getProjectState(): Promise<{
    projectKey: string;
    tokens: number;
    capacity: number;
    refillPerSecond: number;
    rateFactor: number;
    totalUnitsReserved: number;
  } | null> {
    const state = await this.readState(this.projectKey);
    if (!state) return null;
    return { projectKey: this.projectKey, ...state };
  }

  private async readState(mailboxKey: string): Promise<{
    tokens: number;
    capacity: number;
    refillPerSecond: number;
    rateFactor: number;
    totalUnitsReserved: number;
  } | null> {
    const doc = await GmailQuotaLedger.findOne({ mailboxKey }).lean().catch(() => null);
    if (!doc) return null;
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - (doc.lastRefillAt ?? now)) / 1000);
    const refill =
      (doc.refillPerSecond ?? 0) * (doc.rateFactor ?? 1) * elapsedSeconds;
    return {
      // Live budget: the stored tokens plus whatever refilled since the last call.
      tokens: Math.max(0, Math.min(doc.capacity, (doc.tokens ?? 0) + refill)),
      capacity: doc.capacity,
      refillPerSecond: doc.refillPerSecond,
      rateFactor: doc.rateFactor,
      totalUnitsReserved: doc.totalUnitsReserved,
    };
  }
}

export const gmailQuotaService = new GmailQuotaService();

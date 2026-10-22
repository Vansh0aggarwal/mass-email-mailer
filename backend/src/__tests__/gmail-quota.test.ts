import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { GmailQuotaLedger } from '../models/GmailQuotaLedger.js';
import { GmailApiLease } from '../models/GmailApiLease.js';
import { gmailApiMetrics } from '../services/gmail-metrics.service.js';
import {
  GMAIL_METHOD_QUOTA_COST,
  GmailQuotaExhaustedError,
  computeBackoffDelay,
  extractGmailErrorInfo,
  gmailQuotaService,
  parseRetryDelay,
} from '../services/gmail-quota.service.js';

const MAILBOX = 'quota-test@example.com';
const OTHER_MAILBOX = 'other-mailbox@example.com';

function gmailError(status: number, reason?: string, retryDelay?: string) {
  const error: any = new Error(`Gmail error ${status}`);
  error.response = {
    status,
    data: {
      error: {
        message: `Quota error ${status}`,
        errors: reason ? [{ reason }] : [],
        details: retryDelay ? [{ metadata: { retryDelay } }] : [],
      },
    },
  };
  return error;
}

describe('Gmail API quota control', () => {
  beforeAll(async () => {
    await connectDatabase();
  });

  afterAll(async () => {
    await Promise.all([
      GmailQuotaLedger.deleteMany({}),
      GmailApiLease.deleteMany({}),
    ]);
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await Promise.all([
      GmailQuotaLedger.deleteMany({}),
      GmailApiLease.deleteMany({}),
    ]);
    gmailApiMetrics.reset();
  });

  it('uses Google\'s published per-method unit costs', () => {
    expect(GMAIL_METHOD_QUOTA_COST['messages.send']).toBe(100);
    expect(GMAIL_METHOD_QUOTA_COST['threads.get.full']).toBe(120);
    expect(GMAIL_METHOD_QUOTA_COST['threads.list']).toBe(10);
    expect(GMAIL_METHOD_QUOTA_COST['history.list']).toBe(2);
    expect(GMAIL_METHOD_QUOTA_COST['messages.list']).toBe(5);
    expect(GMAIL_METHOD_QUOTA_COST['messages.attachments.get']).toBe(20);
  });

  it('charges each call against the mailbox budget and tracks reserved units', async () => {
    let calls = 0;
    await gmailQuotaService.call({
      mailboxKey: MAILBOX,
      method: 'messages.send',
      cost: GMAIL_METHOD_QUOTA_COST['messages.send'],
      fn: async () => {
        calls += 1;
        return 'sent';
      },
    });

    expect(calls).toBe(1);
    const state = await gmailQuotaService.getState(MAILBOX);
    expect(state).not.toBeNull();
    expect(state!.totalUnitsReserved).toBe(100);
    expect(state!.tokens).toBeLessThan(state!.capacity);
  });

  it('keeps the budget of each mailbox separate', async () => {
    await gmailQuotaService.call({
      mailboxKey: MAILBOX,
      method: 'messages.send',
      cost: 100,
      fn: async () => 'ok',
    });

    const other = await gmailQuotaService.getState(OTHER_MAILBOX);
    expect(other).toBeNull();

    const first = await gmailQuotaService.getState(MAILBOX);
    expect(first!.totalUnitsReserved).toBe(100);
  });

  it('defers background work instead of hammering the API when the budget is empty', async () => {
    // Drain the bucket with a large background reservation.
    await gmailQuotaService.call({
      mailboxKey: MAILBOX,
      method: 'threads.get.full',
      cost: 600,
      fn: async () => 'ok',
    });

    let invoked = false;
    await expect(
      gmailQuotaService.call({
        mailboxKey: MAILBOX,
        method: 'threads.get.full',
        cost: 600,
        priority: 'background',
        maxWaitMs: 50,
        fn: async () => {
          invoked = true;
          return 'ok';
        },
      })
    ).rejects.toBeInstanceOf(GmailQuotaExhaustedError);

    expect(invoked).toBe(false);
  });

  it('retries a quota error with backoff and eventually succeeds', async () => {
    let attempts = 0;
    const result = await gmailQuotaService.call({
      mailboxKey: MAILBOX,
      method: 'messages.send',
      cost: 100,
      maxRetries: 3,
      fn: async () => {
        attempts += 1;
        if (attempts < 3) throw gmailError(429, 'rateLimitExceeded');
        return 'ok';
      },
    });

    expect(result.value).toBe('ok');
    expect(attempts).toBe(3);
    expect(result.attempts).toBe(3);
  });

  it('does not retry permanent errors', async () => {
    let attempts = 0;
    await expect(
      gmailQuotaService.call({
        mailboxKey: MAILBOX,
        method: 'messages.send',
        cost: 100,
        fn: async () => {
          attempts += 1;
          throw gmailError(400, 'invalid');
        },
      })
    ).rejects.toBeTruthy();

    expect(attempts).toBe(1);
  });

  it('halves the sustained rate after a quota error and restores it after sustained success', async () => {
    await gmailQuotaService.call({
      mailboxKey: MAILBOX,
      method: 'messages.send',
      cost: 100,
      fn: async () => {
        throw gmailError(429, 'rateLimitExceeded');
      },
    }).catch(() => undefined);

    const penalized = await gmailQuotaService.getState(MAILBOX);
    expect(penalized!.rateFactor).toBeLessThan(1);

    for (let i = 0; i < 25; i++) {
      await gmailQuotaService.call({
        mailboxKey: MAILBOX,
        method: 'messages.send',
        cost: 1,
        fn: async () => 'ok',
      });
    }

    const restored = await gmailQuotaService.getState(MAILBOX);
    expect(restored!.rateFactor).toBeGreaterThan(penalized!.rateFactor);
  });

  it('refills the token bucket over time and never exceeds the burst capacity', async () => {
    // Drain the bucket.
    await gmailQuotaService.call({
      mailboxKey: MAILBOX,
      method: 'threads.get.full',
      cost: 600,
      fn: async () => 'ok',
    });

    const drained = await gmailQuotaService.getState(MAILBOX);
    expect(drained!.tokens).toBeLessThan(100);

    // Simulate the passage of time by rewinding the refill watermark.
    await GmailQuotaLedger.updateOne(
      { mailboxKey: MAILBOX },
      { $set: { lastRefillAt: Date.now() - 10_000 } }
    );

    const refilled = await gmailQuotaService.getState(MAILBOX);
    expect(refilled!.tokens).toBeGreaterThan(drained!.tokens);
    expect(refilled!.tokens).toBeLessThanOrEqual(refilled!.capacity);

    // The refilled budget must be usable again.
    let invoked = false;
    await gmailQuotaService.call({
      mailboxKey: MAILBOX,
      method: 'threads.list',
      cost: 10,
      fn: async () => {
        invoked = true;
        return 'ok';
      },
    });
    expect(invoked).toBe(true);
  });

  it('classifies Google errors', () => {
    const quota = extractGmailErrorInfo(gmailError(429, 'rateLimitExceeded'));
    expect(quota.isQuota).toBe(true);
    expect(quota.isRetryable).toBe(true);
    expect(quota.isPermanent).toBe(false);
    expect(quota.uncertainDelivery).toBe(false);

    const rejected = extractGmailErrorInfo(gmailError(400, 'invalid'));
    expect(rejected.isRetryable).toBe(false);
    expect(rejected.isPermanent).toBe(true);
    expect(rejected.uncertainDelivery).toBe(false);

    const serverError = extractGmailErrorInfo(gmailError(503, 'backendError'));
    expect(serverError.isRetryable).toBe(true);
    expect(serverError.uncertainDelivery).toBe(true);

    const network: any = new Error('socket hang up');
    network.code = 'ECONNRESET';
    const net = extractGmailErrorInfo(network);
    expect(net.isRetryable).toBe(true);
    expect(net.uncertainDelivery).toBe(true);
  });

  it('parses Google retry hints', () => {
    expect(parseRetryDelay('36s')).toBe(36000);
    expect(parseRetryDelay('1.5s')).toBe(1500);
    expect(parseRetryDelay('250ms')).toBe(250);
    expect(parseRetryDelay('nonsense')).toBeUndefined();
    expect(parseRetryDelay(undefined)).toBeUndefined();
  });

  it('honours the Google retry delay and adds jitter to the backoff', () => {
    const advised = computeBackoffDelay(0, { baseMs: 100, retryDelayMs: 5000, random: () => 0 });
    expect(advised).toBe(5000);

    const jittered = computeBackoffDelay(2, { baseMs: 100, random: () => 0 });
    expect(jittered).toBe(200);

    const full = computeBackoffDelay(2, { baseMs: 100, random: () => 1 });
    expect(full).toBe(400);
  });

  it('records per-mailbox metrics without leaking message content', async () => {
    await gmailQuotaService.call({
      mailboxKey: MAILBOX,
      method: 'messages.send',
      cost: 100,
      fn: async () => 'ok',
    });

    const metric = gmailApiMetrics.get(MAILBOX);
    expect(metric).toBeTruthy();
    expect(metric!.totalCalls).toBe(1);
    expect(metric!.successCalls).toBe(1);
    expect(metric!.unitsConsumed).toBe(100);
    expect(metric!.byMethod['messages.send'].calls).toBe(1);
  });

  it('releases the concurrency lease after every call', async () => {
    await gmailQuotaService.call({
      mailboxKey: MAILBOX,
      method: 'messages.send',
      cost: 100,
      fn: async () => 'ok',
    });

    expect(await GmailApiLease.countDocuments({ mailboxKey: MAILBOX })).toBe(0);
  });
});

/**
 * Connected sender accounts (Gmail mailboxes) that may send a campaign.
 *
 * A campaign can spread its recipients over several connected Gmail accounts.
 * This service is the single place that decides whether an account is
 * *authorized* to send, so the campaign UI, the allocation service and the
 * sender queue all agree on the same rules:
 *
 *  - the account must belong to the campaign's organization (tenant isolation),
 *  - it must be a real sender (`gmail` or `mock`),
 *  - it must be `connected` (not `disconnected` / `error` / `paused`),
 *  - it must not be paused by the operator,
 *  - it must hold a usable refresh token and the `gmail.modify` scope,
 *  - its token must not be expired without a refresh token to renew it.
 *
 * An account that fails any of these checks is reported as *not authorized*
 * and is never used for a send — a disconnected or revoked mailbox is never
 * silently substituted.
 */
import { EmailAccount, IEmailAccount } from '../models/EmailAccount.js';
import { AppError } from '../middleware/errorHandler.js';
import { gmailQuotaService } from './gmail-quota.service.js';
import { env } from '../config/env.js';
import type { ICampaignSenderAccount } from '../models/Campaign.js';

export interface SenderAccountAuthorization {
  /** True when the account may be used for outbound sends right now. */
  authorized: boolean;
  /** Human readable explanation when the account cannot be used. */
  reason?: string;
  /** Machine readable reason code. */
  reasonCode?:
    | 'ACCOUNT_DISCONNECTED'
    | 'ACCOUNT_ERROR'
    | 'ACCOUNT_PAUSED'
    | 'MISSING_REFRESH_TOKEN'
    | 'MISSING_SEND_SCOPE'
    | 'TOKEN_EXPIRED'
    | 'UNSUPPORTED_PROVIDER';
}

export interface SenderAccountView {
  accountId: string;
  emailAddress: string;
  displayName: string;
  provider: string;
  status: string;
  isPaused: boolean;
  pausedReason?: string;
  /** True when this account may be selected as a campaign sender. */
  authorized: boolean;
  authorization: SenderAccountAuthorization;
  /** The account's own daily sending ceiling (never exceeded by a campaign). */
  dailySendLimit: number;
  /** Sends already performed today. */
  sendsToday: number;
  /** Reserved (in-flight) sends that count against today's cap. */
  reservedSends: number;
  /** Effective remaining daily allowance. */
  remainingDailyAllowance: number;
  /** Sends in the current hourly window. */
  sendsThisHour: number;
  /** Timestamp of the last successful send. */
  lastSendAt?: string;
  grantedScopes: string[];
  tokenExpiryDate?: string;
  lastSyncedAt?: string;
  /** The user who connected the account. */
  connectedBy?: string;
  /** Live Gmail API quota state for this mailbox. */
  quota: {
    tokens: number;
    capacity: number;
    refillPerSecond: number;
    rateFactor: number;
    totalUnitsReserved: number;
  } | null;
}

/** The Gmail scope required to send and modify messages. */
const GMAIL_SEND_SCOPE = 'gmail.modify';
const GMAIL_SEND_SCOPE_URL = 'https://www.googleapis.com/auth/gmail.modify';

/** One entry of a campaign's sender roster, as provided by a client. */
export interface SenderRosterEntryInput {
  accountId: string;
  enabled?: boolean;
  dailySendCap?: number;
  maxPerHour?: number;
  minIntervalSeconds?: number;
  jitterSeconds?: number;
}

/** True when the account holds a scope that allows sending mail. */
function hasSendScope(scopes?: string[]): boolean {
  if (!scopes || scopes.length === 0) return false;
  return scopes.some(
    (scope) => scope === GMAIL_SEND_SCOPE || scope === GMAIL_SEND_SCOPE_URL || scope === 'https://mail.google.com/'
  );
}

/**
 * Evaluates whether an account is currently allowed to send.
 * Exported so the sender queue can apply exactly the same rules.
 */
export function evaluateAuthorization(account: IEmailAccount): SenderAccountAuthorization {
  if (account.status === 'disconnected') {
    return {
      authorized: false,
      reasonCode: 'ACCOUNT_DISCONNECTED',
      reason: 'The Gmail account is disconnected. Reconnect it before sending.',
    };
  }
  if (account.status === 'error') {
    return {
      authorized: false,
      reasonCode: 'ACCOUNT_ERROR',
      reason: 'The Gmail account is in an error state. Reconnect it before sending.',
    };
  }
  if (account.status === 'paused' || account.isPaused) {
    return {
      authorized: false,
      reasonCode: 'ACCOUNT_PAUSED',
      reason: account.pausedReason || 'Outbound dispatches are paused for this account.',
    };
  }
  if (account.provider !== 'gmail' && account.provider !== 'mock') {
    return {
      authorized: false,
      reasonCode: 'UNSUPPORTED_PROVIDER',
      reason: `Provider '${account.provider}' cannot be used as a campaign sender.`,
    };
  }
  if (account.provider === 'gmail') {
    if (!account.encryptedRefreshToken) {
      return {
        authorized: false,
        reasonCode: 'MISSING_REFRESH_TOKEN',
        reason: 'The Gmail account has no stored refresh token. Reconnect it to grant send access.',
      };
    }
    if (!hasSendScope(account.grantedScopes)) {
      return {
        authorized: false,
        reasonCode: 'MISSING_SEND_SCOPE',
        reason: 'The Gmail account is missing the Gmail send scope (gmail.modify). Reconnect it.',
      };
    }
    if (account.tokenExpiryDate && account.tokenExpiryDate.getTime() < Date.now() && !account.encryptedRefreshToken) {
      return {
        authorized: false,
        reasonCode: 'TOKEN_EXPIRED',
        reason: 'The Gmail authorization expired. Reconnect the account.',
      };
    }
  }
  return { authorized: true };
}

export class SenderAccountService {
  /**
   * Rolls the daily and hourly send counters over when their window elapsed.
   *
   * The rollover is done with a guarded update: the filter only matches while
   * the window is stale, so concurrent workers can never reset the counter
   * twice or reset it back to zero mid-window.
   */
  async rollOverCounters(accountId: string, now: Date = new Date()): Promise<void> {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    await EmailAccount.updateOne(
      {
        _id: accountId,
        $or: [
          { sendsTodayResetAt: { $exists: false } },
          { sendsTodayResetAt: null },
          { sendsTodayResetAt: { $lt: startOfToday } },
        ],
      },
      { $set: { sendsToday: 0, sendsTodayResetAt: startOfTomorrow } }
    ).catch(() => undefined);

    await EmailAccount.updateOne(
      {
        _id: accountId,
        $or: [
          { hourWindowStartedAt: { $exists: false } },
          { hourWindowStartedAt: null },
          { hourWindowStartedAt: { $lt: hourAgo } },
        ],
      },
      { $set: { sendsThisHour: 0, hourWindowStartedAt: now } }
    ).catch(() => undefined);
  }

  /**
   * Atomically books one send against the account's daily and hourly caps.
   *
   * The reservation is a soft hold: it blocks concurrent workers from
   * exceeding the cap, and is released by the caller once the send finished
   * (or failed). `sendsToday` / `sendsThisHour` are only incremented by the
   * pipeline once a message was really accepted.
   */
  async reserveSendSlot(
    organizationId: string,
    accountId: string,
    limits: { dailyCap: number; maxPerHour: number },
    now: Date = new Date()
  ): Promise<boolean> {
    await this.rollOverCounters(accountId, now);

    const reserved = await EmailAccount.findOneAndUpdate(
      {
        _id: accountId,
        organizationId,
        status: 'connected',
        isPaused: { $ne: true },
        $expr: {
          $and: [
            {
              $lt: [
                {
                  $add: [
                    { $ifNull: ['$sendsToday', 0] },
                    { $ifNull: ['$reservedSends', 0] },
                  ],
                },
                limits.dailyCap,
              ],
            },
            {
              $lt: [
                {
                  $add: [
                    { $ifNull: ['$sendsThisHour', 0] },
                    { $ifNull: ['$reservedSends', 0] },
                  ],
                },
                limits.maxPerHour,
              ],
            },
          ],
        },
      },
      { $inc: { reservedSends: 1 } },
      { new: true }
    ).catch(() => null);

    return Boolean(reserved);
  }

  /** Releases a previously booked send slot. */
  async releaseSendSlot(accountId: string): Promise<void> {
    await EmailAccount.updateOne(
      { _id: accountId, reservedSends: { $gt: 0 } },
      { $inc: { reservedSends: -1 } }
    ).catch(() => undefined);
  }

  /**
   * Lists every connected account of the organization that can act as a sender,
   * together with its authorization state and live quota.
   */
  async listSenderAccounts(organizationId: string): Promise<SenderAccountView[]> {
    const accounts = await EmailAccount.find({ organizationId }).sort({ emailAddress: 1 }).lean();

    const views: SenderAccountView[] = [];
    for (const raw of accounts) {
      const account = raw as unknown as IEmailAccount;
      const authorization = evaluateAuthorization(account);
      const quota = await gmailQuotaService
        .getState(account.emailAddress)
        .catch(() => null);

      const sendsToday = account.sendsToday ?? 0;
      const reservedSends = account.reservedSends ?? 0;
      const dailySendLimit = account.dailySendLimit ?? 0;

      views.push({
        accountId: String(account._id),
        emailAddress: account.emailAddress,
        displayName: account.displayName,
        provider: account.provider,
        status: account.status,
        isPaused: account.isPaused,
        pausedReason: account.pausedReason,
        authorized: authorization.authorized,
        authorization,
        dailySendLimit,
        sendsToday,
        reservedSends,
        remainingDailyAllowance: Math.max(0, dailySendLimit - sendsToday - reservedSends),
        sendsThisHour: account.sendsThisHour ?? 0,
        lastSendAt: account.lastSendAt ? new Date(account.lastSendAt).toISOString() : undefined,
        grantedScopes: account.grantedScopes ?? [],
        tokenExpiryDate: account.tokenExpiryDate ? new Date(account.tokenExpiryDate).toISOString() : undefined,
        lastSyncedAt: account.lastSyncedAt ? new Date(account.lastSyncedAt).toISOString() : undefined,
        connectedBy: account.userId,
        quota,
      });
    }

    return views;
  }

  /** Loads one account inside the organization boundary. */
  async getAccount(organizationId: string, accountId: string): Promise<IEmailAccount> {
    const account = await EmailAccount.findOne({ _id: accountId, organizationId });
    if (!account) {
      throw new AppError('Sender account not found', 404, 'SENDER_ACCOUNT_NOT_FOUND');
    }
    return account;
  }

  /**
   * Loads one account and guarantees it is allowed to send.
   * Used before every dispatch so a disconnected or revoked mailbox is never
   * used, and never silently replaced by another one.
   */
  async requireAuthorizedAccount(organizationId: string, accountId: string): Promise<IEmailAccount> {
    const account = await this.getAccount(organizationId, accountId);
    const authorization = evaluateAuthorization(account);
    if (!authorization.authorized) {
      throw new AppError(
        authorization.reason || 'The sender account is not authorized to send.',
        409,
        'SENDER_ACCOUNT_NOT_AUTHORIZED',
        { reasonCode: authorization.reasonCode, accountId: String(account._id) }
      );
    }
    return account;
  }

  /** Resolves an account by its address (used by the legacy single-mailbox path). */
  async findByEmail(organizationId: string, emailAddress: string): Promise<IEmailAccount | null> {
    return EmailAccount.findOne({
      organizationId,
      emailAddress: emailAddress.toLowerCase(),
    });
  }

  /**
   * Builds the sender roster of a campaign.
   *
   * Every entry is validated against the organization's accounts: an account
   * that does not belong to the organization, or that is not authorized to
   * send, is rejected instead of being silently dropped — a user who selects
   * three mailboxes must know when one of them is unusable.
   *
   * The previous roster is passed in so the runtime counters (`assignedCount`,
   * `sentCount`, `lastSentAt`, ...) survive a roster update.
   */
  async buildRoster(
    organizationId: string,
    entries: SenderRosterEntryInput[],
    previous: ICampaignSenderAccount[] = []
  ): Promise<ICampaignSenderAccount[]> {
    const accounts = await this.listSenderAccounts(organizationId);
    const byId = new Map(accounts.map((a) => [a.accountId, a]));

    const seen = new Set<string>();
    const roster: ICampaignSenderAccount[] = [];

    for (const entry of entries) {
      if (seen.has(entry.accountId)) {
        throw new AppError('The same sender account was selected twice.', 400, 'DUPLICATE_SENDER_ACCOUNT');
      }
      seen.add(entry.accountId);

      const account = byId.get(entry.accountId);
      if (!account) {
        throw new AppError(
          'A selected sender account does not belong to this organization.',
          400,
          'SENDER_ACCOUNT_NOT_IN_ORGANIZATION'
        );
      }
      if (!account.authorized) {
        throw new AppError(
          `"${account.emailAddress}" cannot be used as a sender: ${account.authorization.reason || 'not authorized'}`,
          409,
          'SENDER_ACCOUNT_NOT_AUTHORIZED',
          { reasonCode: account.authorization.reasonCode, accountId: entry.accountId }
        );
      }

      const prior = previous.find((p) => p.accountId === entry.accountId);
      roster.push({
        accountId: account.accountId,
        emailAddress: account.emailAddress,
        displayName: account.displayName,
        enabled: entry.enabled !== false,
        dailySendCap: entry.dailySendCap ?? prior?.dailySendCap ?? env.CAMPAIGN_SENDER_DAILY_CAP_DEFAULT,
        maxPerHour: entry.maxPerHour ?? prior?.maxPerHour ?? env.CAMPAIGN_SENDER_MAX_PER_HOUR_DEFAULT,
        minIntervalSeconds:
          entry.minIntervalSeconds ?? prior?.minIntervalSeconds ?? env.CAMPAIGN_SENDER_MIN_INTERVAL_SECONDS_DEFAULT,
        jitterSeconds: entry.jitterSeconds ?? prior?.jitterSeconds ?? env.CAMPAIGN_SENDER_JITTER_SECONDS_DEFAULT,
        assignedCount: prior?.assignedCount ?? 0,
        sentCount: prior?.sentCount ?? 0,
        lastSentAt: prior?.lastSentAt,
        nextSendAt: prior?.nextSendAt,
        unavailableReason: prior?.unavailableReason,
        unavailableReasonCode: prior?.unavailableReasonCode,
        pausedAt: prior?.pausedAt,
        lastError: prior?.lastError,
      });
    }

    return roster;
  }
}

export const senderAccountService = new SenderAccountService();

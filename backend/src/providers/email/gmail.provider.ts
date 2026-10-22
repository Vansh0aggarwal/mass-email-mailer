import { google, gmail_v1 } from 'googleapis';
import { IEmailProvider, SendMessageOptions, ProviderSendResult } from './email-provider.interface.js';
import { EmailAccount } from '../../models/EmailAccount.js';
import { EmailThread, IEmailMessageItem, IEmailAttachment } from '../../models/EmailThread.js';
import { FollowUpTask } from '../../models/FollowUpTask.js';
import { replyAssociationService } from '../../services/reply-association.service.js';
import { decryptToken, encryptToken } from '../../utils/crypto.js';
import { googleOAuthService } from '../../services/google-oauth.service.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  GMAIL_METHOD_QUOTA_COST,
  GmailQuotaExhaustedError,
  computeBackoffDelay,
  extractGmailErrorInfo,
  gmailQuotaService,
  type GmailCallPriority,
} from '../../services/gmail-quota.service.js';
import { gmailApiMetrics } from '../../services/gmail-metrics.service.js';

/**
 * Detects the specific Gmail error returned when a stored `historyId` cursor is
 * too old to page changes from (Gmail answers 404 / notFound). Callers should
 * fall back to a full mailbox sync when this is true.
 */
export function isHistoryExpiredError(err: any): boolean {
  if (!err) return false;
  const status = err.status || err.response?.status || err.code;
  if (status === 404) return true;
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  const responseError =
    typeof err.response?.data?.error?.message === 'string'
      ? err.response.data.error.message.toLowerCase()
      : '';
  return (
    message.includes('history') &&
    (message.includes('expired') || message.includes('not found') || message.includes('too old'))
  ) || responseError.includes('history');
}

export function isInvalidGrantError(err: any): boolean {
  if (!err) return false;
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  const error = typeof err.error === 'string' ? err.error.toLowerCase() : '';
  const responseError = typeof err.response?.data?.error === 'string' ? err.response.data.error.toLowerCase() : '';
  const responseDesc = typeof err.response?.data?.error_description === 'string' ? err.response.data.error_description.toLowerCase() : '';
  const status = err.status || err.response?.status;

  return (
    message.includes('invalid_grant') ||
    message.includes('token has been expired or revoked') ||
    message.includes('no refresh token') ||
    error.includes('invalid_grant') ||
    responseError.includes('invalid_grant') ||
    responseDesc.includes('token has been expired or revoked') ||
    status === 401
  );
}

export interface SyncOptions {
  maxThreads?: number;
  pageSize?: number;
  query?: string;
  pageToken?: string;
}

const RETRYABLE_NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];

/** True for transient Gmail/network failures worth retrying with backoff. */
export function isRetryableGmailError(err: any): boolean {
  if (!err) return false;
  const status = err.status || err.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  const code = typeof err.code === 'string' ? err.code : '';
  return RETRYABLE_NETWORK_CODES.includes(code);
}

/**
 * Executes a Gmail API call, retrying transient failures (429/5xx/network) with
 * exponential backoff **and jitter**, honouring Google's own retry guidance.
 *
 * Prefer {@link GmailProvider.gmailCall}: it additionally charges the call
 * against the shared per-mailbox quota budget and acquires a distributed
 * concurrency lease. This helper remains for callers that only need the retry
 * semantics.
 */
export async function withGmailRetry<T = any>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 300): Promise<T> {
  let lastError: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const info = extractGmailErrorInfo(err);
      if (!info.isRetryable || i === attempts - 1) {
        throw err;
      }
      const delay = computeBackoffDelay(i, { baseMs: baseDelayMs, retryDelayMs: info.retryDelayMs });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Returns the larger of two Gmail historyId cursor values. Gmail encodes them as
 * monotonically increasing numeric strings, so compare numerically with a
 * string fallback for anything that does not parse as a big integer.
 */
export function maxHistoryId(a: string, b: string): string {
  try {
    return BigInt(a) >= BigInt(b) ? a : b;
  } catch {
    return a >= b ? a : b;
  }
}

/** Decodes a Gmail base64url-encoded body/attachment chunk into a UTF-8 string. */
export function decodeBase64Url(data?: string): string {
  if (!data) return '';
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    try {
      return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
}

/** Reads a header value (case-insensitive) from a Gmail message/part payload. */
export function partHeaderValue(part: any, name: string): string {
  const headers = part?.headers;
  if (!Array.isArray(headers)) return '';
  const target = name.toLowerCase();
  const found = headers.find((h: any) => String(h?.name || '').toLowerCase() === target);
  return found?.value || '';
}

/** Converts an HTML string into a readable plain-text fallback. */
export function stripHtmlToText(html?: string): string {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Recursively extracts the plain-text and HTML bodies from a Gmail MIME payload.
 * Inline/attached parts (parts with a filename or Content-ID) are ignored so an
 * inline image's bytes are never mistaken for the message body.
 */
export function extractBodiesFromPayload(payload?: any): { text: string; html: string } {
  let text = '';
  let html = '';

  const walk = (part: any) => {
    if (!part) return;
    const mime = String(part.mimeType || '').toLowerCase();
    const isAttachmentLike = !!part.filename || !!partHeaderValue(part, 'content-id');

    if (!isAttachmentLike) {
      if (mime === 'text/plain' && !text && part.body?.data) {
        text = decodeBase64Url(part.body.data);
      } else if (mime === 'text/html' && !html && part.body?.data) {
        html = decodeBase64Url(part.body.data);
      }
    }

    if (Array.isArray(part.parts) && part.parts.length > 0) {
      part.parts.forEach(walk);
    }
  };

  walk(payload);
  return { text, html };
}

/**
 * Backwards-compatible plain-text extractor built on {@link extractBodiesFromPayload}.
 */
export function extractBodyFromPayload(payload?: any): string {
  const { text, html } = extractBodiesFromPayload(payload);
  return text || (html ? stripHtmlToText(html) : '');
}

/**
 * Robustly parses email header recipients or senders into name + email objects
 */
export function parseHeaderAddress(rawHeader?: string): { name: string; email: string } {
  if (!rawHeader || !rawHeader.trim()) {
    return { name: '', email: '' };
  }
  const str = rawHeader.trim();
  const match = str.match(/^(?:"?([^"]*)"?\s)?(?:<([^>]+)>|([^<>\s]+))$/);
  if (match) {
    const name = (match[1] || '').trim();
    const email = (match[2] || match[3] || '').trim().toLowerCase();
    return { name: name || email.split('@')[0], email };
  }
  const emailMatch = str.match(/<([^>]+)>/);
  const email = (emailMatch ? emailMatch[1] : str).trim().toLowerCase();
  const name = str.replace(/<[^>]+>/, '').replace(/["']/g, '').trim();
  return { name: name || email.split('@')[0], email };
}

/**
 * Parses a comma-separated RFC 5322 address list header (To/Cc/Bcc) into address objects.
 */
export function parseAddressList(rawHeader?: string): { name: string; email: string }[] {
  if (!rawHeader || !rawHeader.trim()) return [];
  return rawHeader
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => parseHeaderAddress(chunk))
    .filter((addr) => !!addr.email);
}

/** Pulls a `filename` value out of a Content-Disposition header, if present. */
export function filenameFromDisposition(disposition?: string): string {
  if (!disposition) return '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?("?)([^";]+)\1/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[2].trim());
  } catch {
    return match[2].trim();
  }
}

/**
 * Extracts attachment and inline-image descriptors from a Gmail MIME payload.
 *
 * Beyond filename/mimeType/size this captures the `attachmentId` required to
 * download the bytes and the `Content-ID` required to resolve inline `cid:`
 * image references — without these, images and attachments can never be shown.
 */
export function extractAttachmentsFromPayload(payload?: any): IEmailAttachment[] {
  const found: IEmailAttachment[] = [];

  const walk = (part: any, path: string) => {
    if (!part) return;
    const mime = String(part.mimeType || '').toLowerCase();

    if (Array.isArray(part.parts) && part.parts.length > 0) {
      part.parts.forEach((child: any, i: number) => walk(child, path ? `${path}.${i}` : String(i)));
      return;
    }

    // Message body text lives in bodyText/bodyHtml, not attachments.
    if (mime === 'text/plain' || mime === 'text/html') return;

    const disposition = partHeaderValue(part, 'content-disposition');
    const contentId = partHeaderValue(part, 'content-id').replace(/^<|>$/g, '').trim();
    const filename = part.filename || filenameFromDisposition(disposition);
    const attachmentId: string | undefined = part.body?.attachmentId;
    const isInlineDisposition = /^\s*inline/i.test(disposition);
    const isAttachmentDisposition = /^\s*attachment/i.test(disposition);
    const isImage = mime.startsWith('image/');

    if (!filename && !contentId && !attachmentId) return;

    const isInline =
      isInlineDisposition || (isImage && !!contentId && !isAttachmentDisposition) || (!!contentId && !isAttachmentDisposition);

    const entry: IEmailAttachment = {
      filename: filename || (contentId ? 'inline-image' : 'attachment'),
      mimeType: part.mimeType,
      size: part.body?.size,
      attachmentId,
      contentId: contentId || undefined,
      partId: part.partId || path || undefined,
      isInline,
    };

    // Small inline parts are sometimes embedded directly in body.data (no
    // attachmentId). Persist those bytes so the reader needs no round-trip.
    if (isInline && !attachmentId && typeof part.body?.data === 'string' && part.body.data.length > 0) {
      entry.inlineData = part.body.data;
    }

    found.push(entry);
  };

  if (payload) walk(payload, '');
  return found;
}

/**
 * Maps Gmail label IDs to a normalized Gmail category name.
 */
export function categoryFromLabels(labelIds: string[] = []): string | undefined {
  const map: Record<string, string> = {
    CATEGORY_PERSONAL: 'primary',
    CATEGORY_PROMOTIONS: 'promotions',
    CATEGORY_SOCIAL: 'social',
    CATEGORY_UPDATES: 'updates',
    CATEGORY_FORUMS: 'forums',
  };
  for (const label of labelIds) {
    if (map[label]) return map[label];
  }
  return undefined;
}

export class GmailProvider implements IEmailProvider {
  public name = 'gmail';

  /**
   * In-flight sync promises keyed by `organizationId:mailboxEmail`.
   * Coalesces overlapping sync requests so a mailbox is never synced twice
   * concurrently (e.g. double-clicked "Sync" buttons or reconnect + manual sync).
   */
  private syncLocks = new Map<string, Promise<number>>();

  /**
   * Short-lived cache of authorized Gmail clients keyed by mailbox.
   *
   * Previously every single Gmail API call re-read the account from MongoDB
   * and built a brand new OAuth2 client, which multiplied token refreshes and
   * database load for no benefit. The cache is invalidated whenever the
   * account state changes (reauth, disconnect, token rotation).
   */
  private clientCache = new Map<string, { oauth2Client: any; account: any; expiresAt: number }>();

  private clientCacheTtlMs = 60000;

  /**
   * Executes a Gmail API call through the centralized rate controller.
   *
   * Every Gmail call MUST go through here so that:
   *  - the call is charged against the mailbox's shared quota budget,
   *  - the per-mailbox concurrency limit is respected across workers,
   *  - retryable errors are retried with jittered backoff, and
   *  - quota exhaustion is reported as a deferral instead of a hard failure.
   */
  private async gmailCall<T>(
    mailboxEmail: string,
    method: string,
    cost: number,
    fn: () => Promise<T>,
    priority: GmailCallPriority = 'interactive',
    maxWaitMs?: number
  ): Promise<T> {
    const mailboxKey = mailboxEmail.toLowerCase();
    try {
      const result = await gmailQuotaService.call({
        mailboxKey,
        method,
        cost,
        priority,
        maxWaitMs,
        fn,
      });
      return result.value;
    } catch (err: any) {
      if (err instanceof GmailQuotaExhaustedError) {
        throw new AppError(
          err.message,
          429,
          'GMAIL_QUOTA_EXCEEDED',
          {
            emailAddress: mailboxKey,
            method,
            retryAfterMs: err.retryAfterMs,
            deferred: true,
            uncertainDelivery: false,
          }
        );
      }
      throw err;
    }
  }

  /** Quota cost helper so call sites never hard-code the unit table. */
  private cost(method: string): number {
    return GMAIL_METHOD_QUOTA_COST[method] ?? 10;
  }

  /**
   * Marks a mailbox as requiring reconnection and pauses active sync to stop retry loops
   */
  public async markMailboxReauthRequired(organizationId: string | undefined, mailboxEmail: string, reason?: string) {
    const filter: any = {
      emailAddress: mailboxEmail.toLowerCase(),
      provider: 'gmail',
    };
    if (organizationId) {
      filter.organizationId = organizationId;
    }

    await EmailAccount.updateMany(filter, {
      $set: {
        status: 'error',
        isPaused: true,
        pausedReason: reason || 'Gmail authorization expired or revoked. Reconnection required.',
      },
    });

    this.invalidateClientCache(mailboxEmail);
  }

  /** Drops any cached authorized client for a mailbox. */
  public invalidateClientCache(mailboxEmail: string): void {
    this.clientCache.delete(mailboxEmail.toLowerCase());
  }

  /**
   * Retrieves an authorized Gmail API client for a connected mailbox,
   * automatically handling token decryption, organization scoping, and refresh persistence.
   */
  public async getAuthorizedGmailClient(
    mailboxEmail: string,
    organizationId?: string
  ): Promise<{ gmail: gmail_v1.Gmail; oauth2Client: any; account: any }> {
    const mailboxKey = mailboxEmail.toLowerCase();
    const cached = this.clientCache.get(mailboxKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (!organizationId || cached.account.organizationId === organizationId) {
        // The OAuth client (and its token refresh handler) is reused, but the
        // API surface is rebuilt so it always reflects the current client.
        const gmail = google.gmail({ version: 'v1', auth: cached.oauth2Client });
        return { gmail, oauth2Client: cached.oauth2Client, account: cached.account };
      }
    }

    const query: any = {
      emailAddress: mailboxKey,
      provider: 'gmail',
    };
    if (organizationId) {
      query.organizationId = organizationId;
    }

    let account = await EmailAccount.findOne(query);

    // If not found with organizationId or organizationId omitted, find active account
    if (!account && !organizationId) {
      account = await EmailAccount.findOne({
        emailAddress: mailboxKey,
        provider: 'gmail',
        status: { $ne: 'disconnected' },
      }).sort({ status: 1, updatedAt: -1 });
    }

    if (!account) {
      throw new AppError(`Gmail account '${mailboxEmail}' not found. Please connect the mailbox first.`, 404, 'GMAIL_ACCOUNT_NOT_FOUND');
    }

    if (account.status === 'disconnected') {
      throw new AppError(`Gmail account '${mailboxEmail}' is disconnected.`, 400, 'GMAIL_ACCOUNT_DISCONNECTED');
    }

    // Suppress repeated retries if account is in error state or requires reconnection
    if (account.status === 'error' || account.pausedReason?.includes('expired or revoked') || account.pausedReason?.includes('Reconnection required')) {
      throw new AppError(
        `Gmail account '${mailboxEmail}' authorization has expired or been revoked. Please reconnect the account.`,
        401,
        'GMAIL_REAUTH_REQUIRED',
        { emailAddress: mailboxEmail, requiresReconnect: true }
      );
    }

    if (!account.encryptedAccessToken && !account.encryptedRefreshToken) {
      throw new AppError(`Gmail account '${mailboxEmail}' has no credentials configured.`, 400, 'GMAIL_NO_CREDENTIALS');
    }

    if (!account.encryptedRefreshToken && (!account.encryptedAccessToken || (account.tokenExpiryDate && account.tokenExpiryDate.getTime() <= Date.now()))) {
      throw new AppError(
        `Gmail account '${mailboxEmail}' has an expired access token and no refresh token. Please reconnect the account.`,
        401,
        'GMAIL_REAUTH_REQUIRED',
        { emailAddress: mailboxEmail, requiresReconnect: true }
      );
    }

    let accessToken = '';
    let refreshToken = '';

    if (account.encryptedAccessToken) {
      try {
        accessToken = decryptToken(account.encryptedAccessToken);
      } catch {
        console.error(`Failed to decrypt access token for ${mailboxEmail}`);
      }
    }

    if (account.encryptedRefreshToken) {
      try {
        refreshToken = decryptToken(account.encryptedRefreshToken);
      } catch {
        console.error(`Failed to decrypt refresh token for ${mailboxEmail}`);
      }
    }

    const oauth2Client = googleOAuthService.createAuthorizedClient({
      accessToken,
      refreshToken,
      expiryDate: account.tokenExpiryDate ? account.tokenExpiryDate.getTime() : undefined,
    });

    // Listen for refreshed tokens and save them back to MongoDB
    oauth2Client.on('tokens', async (newTokens) => {
      try {
        const updateDoc: any = {};
        if (newTokens.access_token) {
          updateDoc.encryptedAccessToken = encryptToken(newTokens.access_token);
        }
        if (newTokens.refresh_token) {
          updateDoc.encryptedRefreshToken = encryptToken(newTokens.refresh_token);
        }
        if (newTokens.expiry_date) {
          updateDoc.tokenExpiryDate = new Date(newTokens.expiry_date);
        }
        if (Object.keys(updateDoc).length > 0) {
          await EmailAccount.updateOne({ _id: account._id }, { $set: updateDoc });
        }
      } catch (saveErr) {
        console.error('Error saving updated tokens for Gmail account:', saveErr);
      }
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    this.clientCache.set(mailboxKey, {
      oauth2Client,
      account,
      expiresAt: Date.now() + this.clientCacheTtlMs,
    });
    return { gmail, oauth2Client, account };
  }

  /**
   * Builds an RFC 2822 compliant MIME message string
   */
  private sanitizeHeaderValue(value: string): string {
    // Prevent header injection via CR/LF in user-supplied values
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
  }

  private buildRfc2822Message(from: string, options: SendMessageOptions): string {
    const headers = [
      `From: ${this.sanitizeHeaderValue(from)}`,
      `To: ${this.sanitizeHeaderValue(options.to)}`,
    ];

    if (options.cc) {
      headers.push(`Cc: ${this.sanitizeHeaderValue(options.cc)}`);
    }
    if (options.bcc) {
      headers.push(`Bcc: ${this.sanitizeHeaderValue(options.bcc)}`);
    }

    headers.push(
      `Subject: ${this.sanitizeHeaderValue(options.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit'
    );

    if (options.inReplyTo) {
      headers.push(`In-Reply-To: ${this.sanitizeHeaderValue(options.inReplyTo)}`);
    }
    if (options.references || options.inReplyTo) {
      headers.push(`References: ${this.sanitizeHeaderValue(options.references || options.inReplyTo || '')}`);
    }

    return `${headers.join('\r\n')}\r\n\r\n${options.body}`;
  }

  /**
   * Sends an email via official Gmail API
   */
  public async sendMessage(mailboxEmail: string, options: SendMessageOptions, organizationId?: string): Promise<ProviderSendResult> {
    let orgId: string | undefined = organizationId;
    try {
      const { gmail, account } = await this.getAuthorizedGmailClient(mailboxEmail, organizationId);
      orgId = account.organizationId;

      const rawMessage = this.buildRfc2822Message(mailboxEmail, options);
      const encodedMessage = Buffer.from(rawMessage).toString('base64url');

      const requestBody: { raw: string; threadId?: string } = {
        raw: encodedMessage,
      };

      if (options.threadId) {
        requestBody.threadId = options.threadId;
      }

      const res = await this.gmailCall(
        mailboxEmail,
        'messages.send',
        this.cost('messages.send'),
        () =>
          gmail.users.messages.send({
            userId: 'me',
            requestBody,
          }),
        'interactive',
        options.maxQuotaWaitMs
      );

      return {
        messageId: res.data.id || `gm_${Date.now()}`,
        threadId: res.data.threadId || options.threadId || `th_${Date.now()}`,
        isSimulated: false,
        acceptedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      if (err.code === 401 || err.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
        await this.markMailboxReauthRequired(orgId, mailboxEmail);
        throw new AppError(
          'Gmail authorization expired or revoked. Please reconnect your account.',
          401,
          'GMAIL_REAUTH_REQUIRED',
          { emailAddress: mailboxEmail, requiresReconnect: true }
        );
      }

      if (err.code === 'GMAIL_QUOTA_EXCEEDED') {
        // Quota exhaustion happens **before** the API call is made, so the
        // message was definitely not sent. The caller should defer, not retry.
        throw err;
      }

      const info = extractGmailErrorInfo(err);
      // A 4xx (other than 429) means Gmail rejected the request outright, so
      // nothing was sent. Network errors and 5xx responses are ambiguous:
      // Gmail may have accepted the message before failing to respond.
      const uncertainDelivery = !info.isPermanent;
      throw new AppError(
        `Gmail send failed: ${err.message || 'Unknown provider error'}`,
        uncertainDelivery ? 502 : 400,
        uncertainDelivery ? 'GMAIL_SEND_ERROR' : 'GMAIL_SEND_REJECTED',
        {
          emailAddress: mailboxEmail,
          uncertainDelivery,
          providerStatus: info.status ?? null,
          retryAfterMs: info.retryDelayMs ?? null,
        }
      );
    }
  }

  /**
   * Looks for a message we already sent to the given recipient, used to
   * reconcile deliveries whose outcome is unknown (e.g. a timeout after
   * `messages.send` was accepted). Prevents duplicate sends.
   */
  public async findSentMessage(
    mailboxEmail: string,
    options: { to: string; subject?: string; after?: Date; organizationId?: string }
  ): Promise<{ messageId: string; threadId?: string; sentAt?: string } | null> {
    try {
      const { gmail } = await this.getAuthorizedGmailClient(mailboxEmail, options.organizationId);
      const parts = ['in:sent', `to:${options.to}`];
      if (options.subject) {
        parts.push(`subject:${options.subject.replace(/[{}"]/g, '').trim()}`);
      }
      if (options.after) {
        parts.push(`after:${Math.floor(options.after.getTime() / 1000)}`);
      }

      const res = await this.gmailCall(
        mailboxEmail,
        'messages.list',
        this.cost('messages.list'),
        () =>
          gmail.users.messages.list({
            userId: 'me',
            q: parts.join(' '),
            maxResults: 5,
          }),
        'interactive'
      );

      const messages = res.data.messages || [];
      if (messages.length === 0) return null;
      const first = messages[0] as any;
      return {
        messageId: first.id,
        threadId: first.threadId,
        sentAt: first.internalDate ? new Date(Number(first.internalDate)).toISOString() : undefined,
      };
    } catch (err: any) {
      if (err.code === 401 || err.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
        throw err;
      }
      // Reconciliation is best-effort: a failure here must not block retries,
      // it only means we could not confirm the delivery.
      gmailApiMetrics.recordFailure(
        mailboxEmail,
        'messages.list',
        extractGmailErrorInfo(err).message || 'Gmail reconciliation lookup failed'
      );
      return null;
    }
  }

  /**
   * Fetches mailbox profile from Gmail
   */
  public async getProfile(mailboxEmail: string, organizationId?: string) {
    let orgId: string | undefined = organizationId;
    try {
      const { gmail, account } = await this.getAuthorizedGmailClient(mailboxEmail, organizationId);
      orgId = account.organizationId;
      const profile = await this.gmailCall(
        mailboxEmail,
        'getProfile',
        this.cost('getProfile'),
        () => gmail.users.getProfile({ userId: 'me' }),
        'interactive'
      );
      return profile.data;
    } catch (err: any) {
      if (err.code === 401 || err.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
        await this.markMailboxReauthRequired(orgId, mailboxEmail);
        throw new AppError(
          'Gmail authorization expired or revoked. Please reconnect your account.',
          401,
          'GMAIL_REAUTH_REQUIRED',
          { emailAddress: mailboxEmail, requiresReconnect: true }
        );
      }
      throw err;
    }
  }

  /**
   * Lists threads from Gmail
   */
  public async listThreads(mailboxEmail: string, maxResults = 25, q?: string, organizationId?: string) {
    let orgId: string | undefined = organizationId;
    try {
      const { gmail, account } = await this.getAuthorizedGmailClient(mailboxEmail, organizationId);
      orgId = account.organizationId;
      const res = await this.gmailCall(
        mailboxEmail,
        'threads.list',
        this.cost('threads.list'),
        () =>
          gmail.users.threads.list({
            userId: 'me',
            maxResults,
            q,
          }),
        'interactive'
      );
      return res.data.threads || [];
    } catch (err: any) {
      if (err.code === 401 || err.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
        await this.markMailboxReauthRequired(orgId, mailboxEmail);
        throw new AppError(
          'Gmail authorization expired or revoked. Please reconnect your account.',
          401,
          'GMAIL_REAUTH_REQUIRED',
          { emailAddress: mailboxEmail, requiresReconnect: true }
        );
      }
      throw err;
    }
  }

  /**
   * Synchronizes recent and historical threads from Gmail into MongoDB.
   * Coalesces concurrent requests, prefers incremental history sync, and falls
   * back to a full paginated sync when no cursor exists or the cursor expired.
   */
  public async syncThreadsToDb(
    organizationId: string,
    mailboxEmail: string,
    optionsOrLimit: number | SyncOptions = 25
  ): Promise<number> {
    const opts: SyncOptions =
      typeof optionsOrLimit === 'number'
        ? { maxThreads: optionsOrLimit }
        : optionsOrLimit || {};

    const lockKey = `${organizationId}:${mailboxEmail.toLowerCase()}`;
    const inFlight = this.syncLocks.get(lockKey);
    if (inFlight) {
      return inFlight;
    }

    const run = this.performSync(organizationId, mailboxEmail, opts);
    this.syncLocks.set(lockKey, run);
    try {
      return await run;
    } finally {
      this.syncLocks.delete(lockKey);
    }
  }

  private async performSync(
    organizationId: string,
    mailboxEmail: string,
    opts: SyncOptions
  ): Promise<number> {
    const maxThreads = opts.maxThreads || 50;
    const pageSize = Math.min(opts.pageSize || 25, maxThreads);

    try {
      const { gmail, account } = await this.getAuthorizedGmailClient(mailboxEmail, organizationId);

      await EmailAccount.updateOne(
        { _id: account._id },
        { $set: { syncStatus: 'syncing' }, $unset: { lastSyncError: '' } }
      ).catch(() => undefined);

      // Incremental sync is only valid once a full baseline has run and a
      // history cursor exists. Explicit queries / page tokens force a full sync.
      const canUseIncremental =
        !opts.query &&
        !opts.pageToken &&
        !!account.historyId &&
        account.initialSyncCompleted === true;

      if (canUseIncremental) {
        try {
          return await this.syncIncremental(gmail, organizationId, mailboxEmail, account);
        } catch (incrErr: any) {
          if (
            incrErr?.code === 401 ||
            incrErr?.code === 'GMAIL_REAUTH_REQUIRED' ||
            isInvalidGrantError(incrErr)
          ) {
            throw incrErr;
          }
          if (isHistoryExpiredError(incrErr)) {
            console.warn(
              `Gmail history cursor expired for ${mailboxEmail}; falling back to a full sync.`
            );
          } else {
            throw incrErr;
          }
        }
      }

      // Full baseline sync (also used as the expired-cursor fallback).
      const threadSummaries: Array<{ id?: string | null; snippet?: string | null }> = [];
      let pageToken: string | undefined = opts.pageToken;

      while (threadSummaries.length < maxThreads) {
        const fetchBatchSize = Math.min(pageSize, maxThreads - threadSummaries.length);
        const listRes = await this.gmailCall<any>(
          mailboxEmail,
          'threads.list',
          this.cost('threads.list'),
          () =>
            gmail.users.threads.list({
              userId: 'me',
              maxResults: fetchBatchSize,
              pageToken,
              q: opts.query,
            }),
          'background'
        );

        const items = listRes?.data?.threads || [];
        if (items.length === 0) {
          break;
        }

        threadSummaries.push(...items);
        pageToken = listRes?.data?.nextPageToken || undefined;

        if (!pageToken) {
          break; // Reached end of Gmail mailbox history
        }
      }

      let syncedCount = 0;

      for (const item of threadSummaries) {
        if (!item.id) continue;
        try {
          const persisted = await this.upsertThreadFromGmail(
            gmail,
            organizationId,
            mailboxEmail,
            item.id,
            item.snippet
          );
          if (persisted) syncedCount++;
        } catch (threadErr: any) {
          if (isInvalidGrantError(threadErr)) {
            throw threadErr; // Halt iteration and bubble up to reauth handler
          }
          console.warn(
            `Failed to sync thread ${item.id} for ${mailboxEmail}:`,
            threadErr?.message || 'Thread sync error'
          );
        }
      }

      // Baseline complete: enable incremental sync and refresh the cursor.
      account.initialSyncCompleted = true;
      await this.refreshHistoryCursor(gmail, account, mailboxEmail);

      // Update sync tracking and health state on EmailAccount
      account.lastSyncedAt = new Date();
      account.status = 'connected';
      account.isPaused = false;
      account.pausedReason = undefined;
      await account.save();
      await EmailAccount.updateOne(
        { _id: account._id },
        { $set: { syncStatus: 'idle' }, $unset: { lastSyncError: '' } }
      ).catch(() => undefined);

      return syncedCount;
    } catch (err: any) {
      if (err.code === 401 || err.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
        await this.markMailboxReauthRequired(organizationId, mailboxEmail);
        throw new AppError(
          'Gmail authorization expired or revoked. Please reconnect the account in Integrations.',
          401,
          'GMAIL_REAUTH_REQUIRED',
          { emailAddress: mailboxEmail, requiresReconnect: true }
        );
      }
      await EmailAccount.updateOne(
        { organizationId, emailAddress: mailboxEmail.toLowerCase(), provider: 'gmail' },
        { $set: { syncStatus: 'error', lastSyncError: err?.message || 'Mailbox sync failed' } }
      ).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Applies the latest Gmail profile historyId to the in-memory account as the
   * resume cursor for future incremental syncs. Best-effort only.
   */
  private async refreshHistoryCursor(gmail: any, account: any, mailboxEmail: string): Promise<void> {
    try {
      if (typeof gmail?.users?.getProfile === 'function') {
        const profile = await this.gmailCall<any>(
          mailboxEmail,
          'getProfile',
          this.cost('getProfile'),
          () => gmail.users.getProfile({ userId: 'me' }),
          'background'
        );
        if (profile?.data?.historyId) {
          account.historyId = String(profile.data.historyId);
        }
      }
    } catch {
      /* profile historyId is optional; keep the previous cursor */
    }
  }

  /**
   * Incremental sync: pages Gmail history since the stored cursor and re-persists
   * only the threads whose messages or labels changed.
   */
  private async syncIncremental(
    gmail: any,
    organizationId: string,
    mailboxEmail: string,
    account: any
  ): Promise<number> {
    const startHistoryId = String(account.historyId);
    const changedThreadIds = new Set<string>();
    let latestHistoryId = startHistoryId;
    let pageToken: string | undefined;
    let guard = 0;

    do {
      const historyRes = await this.gmailCall<any>(
        mailboxEmail,
        'history.list',
        this.cost('history.list'),
        () =>
          gmail.users.history.list({
            userId: 'me',
            startHistoryId,
            maxResults: 100,
            historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
            pageToken,
          }),
        'background'
      );

      const data = historyRes?.data || {};
      if (data.historyId) {
        latestHistoryId = maxHistoryId(latestHistoryId, String(data.historyId));
      }

      for (const record of data.history || []) {
        const collect = (message?: any) => {
          const threadId = message?.threadId;
          if (threadId) changedThreadIds.add(String(threadId));
        };
        (record.messages || []).forEach(collect);
        (record.messagesAdded || []).forEach((e: any) => collect(e?.message));
        (record.messagesDeleted || []).forEach((e: any) => collect(e?.message));
        (record.labelsAdded || []).forEach((e: any) => collect(e?.message));
        (record.labelsRemoved || []).forEach((e: any) => collect(e?.message));
      }

      pageToken = data.nextPageToken || undefined;
      guard++;
    } while (pageToken && guard < 50);

    let syncedCount = 0;
    for (const threadId of changedThreadIds) {
      try {
        const persisted = await this.upsertThreadFromGmail(
          gmail,
          organizationId,
          mailboxEmail,
          threadId
        );
        if (persisted) syncedCount++;
      } catch (threadErr: any) {
        if (isInvalidGrantError(threadErr)) {
          throw threadErr;
        }
        // A changed thread may have been permanently deleted; keep going.
        console.warn(
          `Failed to sync changed thread ${threadId} for ${mailboxEmail}:`,
          threadErr?.message || 'Thread sync error'
        );
      }
    }

    account.historyId = latestHistoryId;
    account.initialSyncCompleted = true;
    account.lastSyncedAt = new Date();
    account.status = 'connected';
    account.isPaused = false;
    account.pausedReason = undefined;
    await account.save();
    await EmailAccount.updateOne(
      { _id: account._id },
      { $set: { syncStatus: 'idle' }, $unset: { lastSyncError: '' } }
    ).catch(() => undefined);

    return syncedCount;
  }

  /**
   * Fetches a single Gmail thread, normalizes it and upserts it into MongoDB.
   * Shared by both full and incremental sync. Returns true when persisted.
   */
  private async upsertThreadFromGmail(
    gmail: any,
    organizationId: string,
    mailboxEmail: string,
    threadId: string,
    fallbackSnippet?: string | null
  ): Promise<boolean> {
    const fullThread = await this.gmailCall<any>(
      mailboxEmail,
      'threads.get.full',
      this.cost('threads.get.full'),
      () =>
        gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        }),
      'background'
    );

    const messages = fullThread.data.messages || [];
    if (messages.length === 0) return false;

    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];

    // Extract subject and snippet
    const subjectHeader = firstMessage.payload?.headers?.find(
      (h: any) => h.name?.toLowerCase() === 'subject'
    );
    const subject = subjectHeader?.value || fallbackSnippet?.slice(0, 50) || '(No Subject)';
    const snippet = lastMessage.snippet || fallbackSnippet || '';

    const headerValue = (m: any, name: string) =>
      m.payload?.headers?.find((h: any) => h.name?.toLowerCase() === name)?.value || '';

    const normalizedMessages: IEmailMessageItem[] = messages.map((m: any) => {
      const fromParsed = parseHeaderAddress(headerValue(m, 'from'));
      const toList = parseAddressList(headerValue(m, 'to'));
      const ccList = parseAddressList(headerValue(m, 'cc'));
      const bccList = parseAddressList(headerValue(m, 'bcc'));
      const replyToParsed = parseHeaderAddress(headerValue(m, 'reply-to'));
      const dateHeader = headerValue(m, 'date');
      const msgSubject = headerValue(m, 'subject') || subject;
      const messageIdHeader = headerValue(m, 'message-id');
      const inReplyTo = headerValue(m, 'in-reply-to');
      const references = headerValue(m, 'references');

      // Extract both body representations + attachments/inline images from MIME.
      const { text, html } = extractBodiesFromPayload(m.payload);
      const attachments = extractAttachmentsFromPayload(m.payload);
      const bodyText = text || (html ? stripHtmlToText(html) : '') || m.snippet || '';
      const hasFileAttachments = attachments.some((a) => !a.isInline);

      const isRead = !(m.labelIds?.includes('UNREAD'));
      const isStarred = !!(m.labelIds?.includes('STARRED'));

      return {
        id: m.id || '',
        from: fromParsed,
        to: toList,
        cc: ccList,
        bcc: bccList,
        replyTo: replyToParsed.email ? replyToParsed : undefined,
        subject: msgSubject,
        bodyText,
        bodyHtml: html || undefined,
        snippet: m.snippet || '',
        date: dateHeader ? new Date(dateHeader) : new Date(parseInt(m.internalDate)),
        isRead,
        isStarred,
        hasAttachments: hasFileAttachments,
        attachments,
        messageIdHeader: messageIdHeader || undefined,
        inReplyTo: inReplyTo || undefined,
        references: references || undefined,
      };
    });

    const lastDate = normalizedMessages[normalizedMessages.length - 1]?.date || new Date();
    const hasUnread = normalizedMessages.some((m) => !m.isRead);
    const hasStarred = normalizedMessages.some((m) => m.isStarred);
    const unreadCount = normalizedMessages.filter((m) => !m.isRead).length;

    // Labels from the most recent message (Gmail labels are per-message; thread view uses latest).
    // If Gmail omits label data, assume INBOX so persisted threads remain visible.
    const threadLabels: string[] =
      lastMessage.labelIds && lastMessage.labelIds.length > 0 ? lastMessage.labelIds : ['INBOX'];
    const inInbox = threadLabels.includes('INBOX');
    const isSpam = threadLabels.includes('SPAM');
    const isTrash = threadLabels.includes('TRASH');
    const isSnoozed = threadLabels.includes('SNOOZED');
    const isArchived = !inInbox && !isSpam && !isTrash;

    const uniqueParticipants = Array.from(
      new Set(
        normalizedMessages.flatMap((m) => [
          m.from?.email,
          ...(m.to || []).map((t) => t.email),
          ...(m.cc || []).map((t) => t.email),
        ])
      )
    ).filter(Boolean) as string[];

    const last = normalizedMessages[normalizedMessages.length - 1];

    await EmailThread.findOneAndUpdate(
      { organizationId, mailboxEmail: mailboxEmail.toLowerCase(), threadId },
      {
        $set: {
          subject,
          snippet,
          lastMessageDate: lastDate,
          messageCount: normalizedMessages.length,
          isRead: !hasUnread,
          isStarred: hasStarred,
          isArchived,
          isSpam,
          isTrash,
          isSnoozed,
          inInbox,
          unreadCount,
          hasAttachments: normalizedMessages.some((m) => m.hasAttachments),
          labels: threadLabels,
          category: categoryFromLabels(threadLabels),
          lastFromName: last?.from?.name || '',
          lastFromEmail: last?.from?.email || '',
          participants: uniqueParticipants,
          messages: normalizedMessages,
        },
      },
      { upsert: true, new: true }
    );

    // Detect any genuine inbound messages (authored by someone other than the mailbox owner)
    const inboundMessages = normalizedMessages.filter(
      (m) => m.from?.email && m.from.email.toLowerCase() !== mailboxEmail.toLowerCase()
    );

    if (inboundMessages.length > 0) {
      const lastInbound = inboundMessages[inboundMessages.length - 1];

      await FollowUpTask.updateMany(
        {
          organizationId,
          status: 'pending',
          $or: [{ threadId }, { contactEmail: lastInbound.from.email.toLowerCase() }],
        },
        { $set: { status: 'cancelled', notes: 'Auto-cancelled: reply received' } }
      );

      // Associate the reply with a campaign recipient (conservative multi-tiered matching).
      // Automatically halts pending sequence steps for a contact who replied.
      try {
        await replyAssociationService.handleInboundReply({
          organizationId,
          mailboxEmail,
          threadId,
          messageId: lastInbound.id,
          fromEmail: lastInbound.from.email,
          fromName: lastInbound.from.name,
          subject: lastInbound.subject,
          bodySnippet: lastInbound.snippet || (lastInbound.bodyText ? lastInbound.bodyText.slice(0, 500) : ''),
          inReplyTo: lastInbound.inReplyTo,
          references: lastInbound.references,
          receivedAt: lastInbound.date,
        });
      } catch (err: any) {
        console.error('[Reply Association] failed:', err?.message || err);
      }
    }

    return true;
  }

  /**
   * Applies or removes Gmail labels on a thread (best-effort, org-scoped).
   * Used to mirror local read/star/archive/spam/trash state to Gmail.
   */
  public async modifyThread(
    mailboxEmail: string,
    threadId: string,
    addLabelIds: string[] = [],
    removeLabelIds: string[] = [],
    organizationId?: string
  ): Promise<boolean> {
    let orgId: string | undefined = organizationId;
    try {
      if (!threadId || (addLabelIds.length === 0 && removeLabelIds.length === 0)) return false;
      const { gmail, account } = await this.getAuthorizedGmailClient(mailboxEmail, organizationId);
      orgId = account.organizationId;
      await this.gmailCall(
        mailboxEmail,
        'threads.modify',
        this.cost('threads.modify'),
        () =>
          gmail.users.threads.modify({
            userId: 'me',
            id: threadId,
            requestBody: { addLabelIds, removeLabelIds },
          }),
        'interactive'
      );
      return true;
    } catch (err: any) {
      if (isInvalidGrantError(err) || err.code === 401) {
        await this.markMailboxReauthRequired(orgId, mailboxEmail);
        throw new AppError(
          'Gmail authorization expired or revoked. Please reconnect your account.',
          401,
          'GMAIL_REAUTH_REQUIRED',
          { emailAddress: mailboxEmail, requiresReconnect: true }
        );
      }
      // Label operations are best-effort; surface non-auth failures softly.
      console.warn(`Gmail modifyThread failed for ${threadId}:`, err?.message || err);
      return false;
    }
  }

  /**
   * Moves a thread to Gmail trash (best-effort).
   */
  public async trashThread(mailboxEmail: string, threadId: string, organizationId?: string): Promise<boolean> {
    let orgId: string | undefined = organizationId;
    try {
      const { gmail, account } = await this.getAuthorizedGmailClient(mailboxEmail, organizationId);
      orgId = account.organizationId;
      await this.gmailCall(
        mailboxEmail,
        'threads.trash',
        this.cost('threads.trash'),
        () => gmail.users.threads.trash({ userId: 'me', id: threadId }),
        'interactive'
      );
      return true;
    } catch (err: any) {
      if (isInvalidGrantError(err) || err.code === 401) {
        await this.markMailboxReauthRequired(orgId, mailboxEmail);
        throw new AppError('Gmail authorization expired or revoked.', 401, 'GMAIL_REAUTH_REQUIRED', {
          emailAddress: mailboxEmail,
          requiresReconnect: true,
        });
      }
      console.warn(`Gmail trashThread failed for ${threadId}:`, err?.message || err);
      return false;
    }
  }

  /**
   * Fetches raw attachment (or inline-image) bytes from Gmail as a Buffer.
   *
   * Organization-scoped: a token belonging to one mailbox can never be used to
   * read another mailbox's attachment. Callers must pass the Gmail message id
   * and the part's `attachmentId` captured during sync.
   */
  public async getAttachmentBytes(
    mailboxEmail: string,
    messageId: string,
    attachmentId: string,
    organizationId?: string
  ): Promise<{ data: Buffer; size: number }> {
    let orgId: string | undefined = organizationId;
    try {
      const { gmail, account } = await this.getAuthorizedGmailClient(mailboxEmail, organizationId);
      orgId = account.organizationId;
      const res = await this.gmailCall<any>(
        mailboxEmail,
        'messages.attachments.get',
        this.cost('messages.attachments.get'),
        () =>
          gmail.users.messages.attachments.get({
            userId: 'me',
            messageId,
            id: attachmentId,
          }),
        'interactive'
      );
      const raw: string = res?.data?.data || '';
      const data = Buffer.from(raw, 'base64url');
      return { data, size: data.length };
    } catch (err: any) {
      if (err.code === 401 || err.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
        await this.markMailboxReauthRequired(orgId, mailboxEmail);
        throw new AppError(
          'Gmail authorization expired or revoked. Please reconnect the account in Integrations.',
          401,
          'GMAIL_REAUTH_REQUIRED',
          { emailAddress: mailboxEmail, requiresReconnect: true }
        );
      }
      throw new AppError(
        `Failed to fetch Gmail attachment: ${err?.message || 'Unknown provider error'}`,
        502,
        'GMAIL_ATTACHMENT_ERROR'
      );
    }
  }

  /**
   * Permanently deletes a thread from Gmail (respects org isolation).
   */
  public async deleteThread(mailboxEmail: string, threadId: string, organizationId?: string): Promise<boolean> {
    let orgId: string | undefined = organizationId;
    try {
      const { gmail, account } = await this.getAuthorizedGmailClient(mailboxEmail, organizationId);
      orgId = account.organizationId;
      await this.gmailCall(
        mailboxEmail,
        'threads.delete',
        this.cost('threads.delete'),
        () => gmail.users.threads.delete({ userId: 'me', id: threadId }),
        'interactive'
      );
      return true;
    } catch (err: any) {
      if (isInvalidGrantError(err) || err.code === 401) {
        await this.markMailboxReauthRequired(orgId, mailboxEmail);
        throw new AppError('Gmail authorization expired or revoked.', 401, 'GMAIL_REAUTH_REQUIRED', {
          emailAddress: mailboxEmail,
          requiresReconnect: true,
        });
      }
      console.warn(`Gmail deleteThread failed for ${threadId}:`, err?.message || err);
      return false;
    }
  }
}

export const gmailProvider = new GmailProvider();

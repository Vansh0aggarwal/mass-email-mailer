import { Router, Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { googleOAuthService } from '../services/google-oauth.service.js';
import { gmailProvider, isInvalidGrantError } from '../providers/email/gmail.provider.js';
import { gmailQuotaService, GMAIL_METHOD_QUOTA_COST } from '../services/gmail-quota.service.js';
import { gmailApiMetrics } from '../services/gmail-metrics.service.js';
import { encryptToken } from '../utils/crypto.js';
import { disconnectGmailMailbox } from '../services/mailbox-cleanup.service.js';
import {
  GMAIL_STATE_COOKIE_NAME,
  getStateCookieOptions,
  requireAuth,
} from '../middleware/session.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

/**
 * Only allow same-origin relative paths so a crafted `returnTo` (or a tampered
 * OAuth state) cannot turn the callback into an open redirect.
 */
function sanitizeInternalPath(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//')) return fallback;
  return path;
}

/** Best-effort recovery of the return path from the OAuth state (used on error redirects). */
function returnToFromState(state: unknown, fallback: string): string {
  if (typeof state !== 'string') return fallback;
  try {
    const { returnTo } = googleOAuthService.parseAndValidateState(state);
    return sanitizeInternalPath(returnTo, fallback);
  } catch {
    return fallback;
  }
}

/** Maps raw Google OAuth error codes to user-facing copy. */
function friendlyGmailAuthError(error: string): string {
  const normalized = error.toLowerCase();
  if (normalized.includes('access_denied')) {
    return 'Gmail connection was cancelled or permission was denied. No account was connected.';
  }
  if (normalized.includes('admin_policy_enforced')) {
    return 'Your Google Workspace administrator has blocked this app. Ask your admin to allow Gmail access.';
  }
  if (normalized.includes('invalid_client') || normalized.includes('invalid_client')) {
    return 'Google OAuth credentials are misconfigured. Check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.';
  }
  return `Gmail authorization failed: ${error}`;
}

/**
 * GET /api/v1/integrations/google/gmail/connect-url
 *
 * Returns the Gmail OAuth authorization URL as JSON instead of redirecting.
 *
 * WHY THIS EXISTS:
 * The `/connect` endpoint requires authentication but is reached via raw browser
 * navigation (`window.location.href`), which cannot attach custom headers.  The
 * session cookie is scoped to the Render domain and is therefore not sent when
 * the request is proxied through Vercel.  Fetching this endpoint with the
 * standard API client (which sends `Authorization: Bearer <token>`) lets
 * `requireAuth` pass, and the frontend then navigates the browser to the
 * returned Google URL.
 */
router.get('/connect-url', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError(
        'Google credentials are not configured in environment. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
        503,
        'GMAIL_NOT_CONFIGURED'
      );
    }

    const returnTo = sanitizeInternalPath(req.query.returnTo, '/email');
    const loginHint = typeof req.query.email === 'string' ? req.query.email : undefined;
    const state = googleOAuthService.generateSecureState({
      organizationId: req.organizationId,
      userId: req.userId,
      returnTo,
    });

    // Set the state cookie so cookie-capable flows still get double-submit
    // verification.  The cookie is best-effort here: if the callback arrives
    // without it (cross-domain Vercel/Render architecture), the HMAC signature
    // on the state parameter is the authoritative CSRF protection.
    res.cookie(GMAIL_STATE_COOKIE_NAME, state, getStateCookieOptions());

    const url = googleOAuthService.getGmailConnectUrl(state, loginHint);

    res.json({ success: true, data: { url } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/integrations/google/gmail/connect
 * Initiates the Gmail OAuth flow (decoupled from Sign-In)
 */
router.get('/connect', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError(
        'Google credentials are not configured in environment. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env',
        503,
        'GMAIL_NOT_CONFIGURED'
      );
    }

    const returnTo = sanitizeInternalPath(req.query.returnTo, '/email');
    const loginHint = typeof req.query.email === 'string' ? req.query.email : undefined;
    const state = googleOAuthService.generateSecureState({
      organizationId: req.organizationId,
      userId: req.userId,
      returnTo,
    });

    res.cookie(GMAIL_STATE_COOKIE_NAME, state, getStateCookieOptions());

    const connectUrl = googleOAuthService.getGmailConnectUrl(state, loginHint);
    res.redirect(connectUrl);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/integrations/google/gmail/callback
 * Exchanges code for Gmail tokens, encrypts credentials, stores EmailAccount and runs initial sync
 */
router.get('/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      throw new AppError(`Gmail authorization was rejected or failed: ${error}`, 400, 'GMAIL_AUTH_FAILED');
    }

    if (!code || typeof code !== 'string') {
      throw new AppError('Authorization code missing from Google callback', 400, 'MISSING_AUTH_CODE');
    }

    const stateCookie = req.cookies?.[GMAIL_STATE_COOKIE_NAME];
    // When the state is HMAC-signed (new format) the signature is the primary
    // CSRF protection.  The cookie double-submit check is retained as an
    // additional layer where the cookie is available, but it is NOT required:
    // in the Vercel-proxied / Render-callback architecture the cookie domain
    // differs so the browser may not send it.
    if (!state || typeof state !== 'string') {
      throw new AppError('Invalid or expired Gmail OAuth state parameter.', 400, 'STATE_MISMATCH');
    }
    if (stateCookie && state !== stateCookie) {
      throw new AppError('Gmail OAuth state cookie mismatch. Please try connecting again.', 400, 'STATE_MISMATCH');
    }

    const stateData = googleOAuthService.parseAndValidateState(state);
    const organizationId = stateData.organizationId || env.DEV_MOCK_ORG_ID;
    const userId = stateData.userId || env.DEV_MOCK_USER_ID;
    const returnTo = stateData.returnTo || '/email';

    // Clear state cookie
    res.clearCookie(GMAIL_STATE_COOKIE_NAME, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    const { tokens, emailAddress, displayName, googleSub, historyId } =
      await googleOAuthService.handleGmailCallback(code);

    if (!emailAddress) {
      throw new AppError('Failed to retrieve email address from authorized Gmail account', 400, 'NO_EMAIL_FOUND');
    }

    // Encrypt sensitive tokens with AES-256-GCM
    const encryptedAccessToken = tokens.access_token ? encryptToken(tokens.access_token) : undefined;
    const encryptedRefreshToken = tokens.refresh_token ? encryptToken(tokens.refresh_token) : undefined;
    const tokenExpiryDate = tokens.expiry_date ? new Date(tokens.expiry_date) : undefined;
    const grantedScopes = tokens.scope ? tokens.scope.split(' ') : ['https://www.googleapis.com/auth/gmail.modify'];

    // Upsert EmailAccount
    const existing = await EmailAccount.findOne({
      organizationId,
      emailAddress: emailAddress.toLowerCase(),
    });

    // Handle refresh token persistence safely:
    // If a new refresh token was returned by Google, encrypt and persist it.
    // If Google omits refresh_token (standard behavior when reconnecting an already-authorized account),
    // do not overwrite the existing valid refresh token with an absent or empty value.
    const finalEncryptedRefreshToken = encryptedRefreshToken || existing?.encryptedRefreshToken;

    const setFields: Record<string, any> = {
      userId,
      displayName: displayName || emailAddress,
      provider: 'gmail',
      status: 'connected',
      googleSub,
      encryptedAccessToken,
      tokenExpiryDate,
      grantedScopes,
      historyId,
      isPaused: false,
      lastSyncedAt: new Date(),
    };

    const unsetFields: Record<string, any> = {
      pausedReason: '',
    };

    if (finalEncryptedRefreshToken) {
      setFields.encryptedRefreshToken = finalEncryptedRefreshToken;
    } else {
      unsetFields.encryptedRefreshToken = '';
    }

    const account = await EmailAccount.findOneAndUpdate(
      { organizationId, emailAddress: emailAddress.toLowerCase() },
      {
        $set: setFields,
        $unset: unsetFields,
      },
      { upsert: true, new: true }
    );

    // A (re)connection replaces the credentials, so any cached OAuth client
    // for this mailbox must be dropped.
    gmailProvider.invalidateClientCache(account.emailAddress);

    // Run initial inbox synchronization in background safely
    try {
      await gmailProvider.syncThreadsToDb(organizationId, account.emailAddress, 15);
    } catch (syncErr: any) {
      if (isInvalidGrantError(syncErr) || syncErr.code === 'GMAIL_REAUTH_REQUIRED') {
        await gmailProvider.markMailboxReauthRequired(organizationId, account.emailAddress);
        console.warn(`Initial thread sync encountered auth failure for ${account.emailAddress}: Reconnection required.`);
      } else {
        console.warn('Initial thread sync encountered an issue (will retry on demand):', syncErr?.message || 'Sync error');
      }
    }

    const targetUrl = new URL(sanitizeInternalPath(returnTo, '/email'), env.CLIENT_URL);
    targetUrl.searchParams.set('gmail_connected', 'true');
    targetUrl.searchParams.set('email', account.emailAddress);

    res.redirect(targetUrl.toString());
  } catch (err: any) {
    console.error('Gmail OAuth callback error:', err?.message || 'Gmail connection failed');

    // Send the user back to the page they started from (falling back to
    // Integrations) with a human-readable reason instead of always dumping
    // them on /integrations.
    const requestedReturnTo = returnToFromState(req.query.state, '/integrations');
    const reason =
      typeof req.query.error === 'string'
        ? friendlyGmailAuthError(req.query.error)
        : err?.message || 'Gmail connection failed';

    const redirectUrl = new URL(requestedReturnTo, env.CLIENT_URL);
    redirectUrl.searchParams.set('error', reason);
    res.redirect(redirectUrl.toString());
  }
});

/**
 * POST /api/v1/integrations/google/gmail/:emailAddress/disconnect
 * Safely disconnects the Gmail mailbox, revokes OAuth tokens, and stops synchronization
 */
router.post('/:emailAddress/disconnect', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxEmail = decodeURIComponent(req.params.emailAddress).trim().toLowerCase();
    const account = await EmailAccount.findOne({
      organizationId: req.organizationId,
      emailAddress: mailboxEmail,
      provider: 'gmail',
    });

    // Scoping check: Only the connection owner or an org admin/owner may disconnect.
    if (account && account.userId && account.userId !== req.userId && req.userRole !== 'owner' && req.userRole !== 'admin') {
      throw new AppError('You do not have permission to disconnect this mailbox connection.', 403, 'FORBIDDEN');
    }

    // Idempotent: allow repeated requests. If the record is already gone we still
    // purge any orphaned synced data for this address.
    const result = await disconnectGmailMailbox(req.organizationId, mailboxEmail);

    res.status(200).json({
      success: true,
      message: reportDisconnectMessage(mailboxEmail, result),
      data: {
        emailAddress: mailboxEmail,
        status: 'disconnected',
        alreadyDisconnected: !account,
        googleRevoked: result.googleRevoked,
        revocationWarning: result.revocationWarning,
        threadsDeleted: result.threadsDeleted,
        messagesDeleted: result.messagesDeleted,
        sendAttemptsDeleted: result.sendAttemptsDeleted,
        followUpsDeleted: result.followUpsDeleted,
        accountRemoved: result.accountRemoved,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Builds an accurate, non-misleading summary of the disconnect outcome. */
function reportDisconnectMessage(
  mailboxEmail: string,
  result: { wasConnected: boolean; accountRemoved: boolean; googleRevoked: boolean; revocationWarning?: string }
): string {
  if (!result.wasConnected && !result.accountRemoved) {
    return `No connected mailbox '${mailboxEmail}' was found. Any locally synced data for this address was removed.`;
  }
  if (result.googleRevoked) {
    return `Gmail account ${mailboxEmail} was disconnected, its Google OAuth grant was revoked, and synced mail data was deleted.`;
  }
  return `Gmail account ${mailboxEmail} was disconnected and its synced mail data was deleted. Google grant revocation note: ${
    result.revocationWarning || 'No refresh token stored'
  }.`;
}

/**
 * POST /api/v1/integrations/google/gmail/:emailAddress/sync
 * Manually trigger live inbox thread synchronization
 */
router.post('/:emailAddress/sync', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxEmail = req.params.emailAddress.toLowerCase();
    const account = await EmailAccount.findOne({
      organizationId: req.organizationId,
      emailAddress: mailboxEmail,
      provider: 'gmail',
    });

    if (!account) {
      throw new AppError(`Gmail account '${mailboxEmail}' not found.`, 404, 'ACCOUNT_NOT_FOUND');
    }

    if (account.status === 'error' || account.isPaused) {
      throw new AppError(
        'Gmail authorization expired or revoked. Please reconnect the account in Integrations.',
        401,
        'GMAIL_REAUTH_REQUIRED',
        { requiresReconnect: true, emailAddress: mailboxEmail }
      );
    }

    const threadCost = GMAIL_METHOD_QUOTA_COST['threads.get.full'] ?? 120;
    const state = await gmailQuotaService.getState(mailboxEmail).catch(() => null);
    const affordable = state ? Math.max(1, Math.floor(Math.max(0, state.tokens - 200) / threadCost)) : 25;
    const maxThreads = Math.min(50, Math.max(1, affordable));

    const syncedCount = await gmailProvider.syncThreadsToDb(req.organizationId, mailboxEmail, { maxThreads });

    res.status(200).json({
      success: true,
      data: {
        syncedCount,
        lastSyncedAt: new Date(),
      },
    });
  } catch (err: any) {
    if (err.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
      await gmailProvider.markMailboxReauthRequired(req.organizationId, req.params.emailAddress);
      return res.status(401).json({
        success: false,
        error: {
          message: 'Gmail authorization expired or revoked. Please reconnect the account in Integrations.',
          code: 'GMAIL_REAUTH_REQUIRED',
          requiresReconnect: true,
          emailAddress: req.params.emailAddress.toLowerCase(),
        },
      });
    }
    next(err);
  }
});

/**
 * GET /api/v1/integrations/google/gmail/:emailAddress/quota
 *
 * Observability for the Gmail API rate controller: the mailbox's remaining
 * budget, the sustained rate, and the call counters that show where the
 * quota is being spent.
 */
router.get('/:emailAddress/quota', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxEmail = req.params.emailAddress.toLowerCase();
    const account = await EmailAccount.findOne({
      organizationId: req.organizationId,
      emailAddress: mailboxEmail,
      provider: 'gmail',
    });

    if (!account) {
      throw new AppError(`Gmail account '${mailboxEmail}' not found.`, 404, 'ACCOUNT_NOT_FOUND');
    }

    const state = await gmailQuotaService.getState(mailboxEmail).catch(() => null);
    const metrics = gmailApiMetrics.get(mailboxEmail) || null;

    res.status(200).json({
      success: true,
      data: {
        emailAddress: mailboxEmail,
        quota: state,
        // The daily Gmail API quota is granted per Google Cloud project, so
        // every connected mailbox of the organization shares it. Connecting
        // more accounts therefore does not raise the project ceiling.
        projectQuota: await gmailQuotaService.getProjectState().catch(() => null),
        metrics: metrics
          ? {
              totalCalls: metrics.totalCalls,
              successCalls: metrics.successCalls,
              failedCalls: metrics.failedCalls,
              quotaErrors: metrics.quotaErrors,
              retries: metrics.retries,
              deferredCalls: metrics.deferredCalls,
              waitMs: metrics.waitMs,
              unitsConsumed: metrics.unitsConsumed,
              byMethod: metrics.byMethod,
              lastQuotaErrorAt: metrics.lastQuotaErrorAt,
            }
          : null,
      },
    });
  } catch (err: any) {
    next(err);
  }
});

export default router;
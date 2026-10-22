import { google } from 'googleapis';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { GMAIL_METHOD_QUOTA_COST, gmailQuotaService } from './gmail-quota.service.js';

export function resolveGoogleFullName(params: {
  name?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
}): string {
  const trimmedName = (params.name || '').trim();
  if (trimmedName.length > 0) {
    return trimmedName;
  }

  const nameFromParts = [params.givenName, params.familyName]
    .map((part) => (part || '').trim())
    .filter((part) => part.length > 0)
    .join(' ');
  if (nameFromParts.length > 0) {
    return nameFromParts;
  }

  const emailPart = (params.email || '').trim().split('@')[0]?.trim();
  if (emailPart && emailPart.length > 0) {
    return emailPart;
  }

  return 'Google User';
}

/**
 * Normalizes a Google profile photo claim into a safe, persistable URL.
 * Returns `undefined` for empty/invalid values so a valid avatar is never
 * overwritten with an empty string, and rejects non-http(s) schemes.
 */
export function resolveGoogleAvatarUrl(picture?: string | null): string | undefined {
  const trimmed = (picture || '').trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return trimmed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface GoogleUserProfile {
  sub: string;
  email: string;
  name: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  emailVerified: boolean;
}

export class GoogleOAuthService {
  private getAuthClient() {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError(
        'Google OAuth credentials not configured in environment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env.',
        500,
        'OAUTH_NOT_CONFIGURED'
      );
    }

    return new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_AUTH_REDIRECT_URI
    );
  }

  private getGmailClient() {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError(
        'Google OAuth credentials not configured in environment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env.',
        500,
        'OAUTH_NOT_CONFIGURED'
      );
    }

    return new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_GMAIL_REDIRECT_URI
    );
  }

  /**
   * Generates a cryptographically secure random state string.
   *
   * The state is HMAC-signed with `JWT_SECRET` so the `/callback` route can
   * verify integrity without relying on a same-domain state cookie (which is
   * unreliable when the connect initiation is proxied through Vercel but the
   * OAuth callback goes directly to the Render backend).
   *
   * Format (base64url-encoded JSON):
   *   { p: "<payload JSON string>", h: "<sha256-hmac-hex>" }
   */
  public generateSecureState(customMetadata: Record<string, any> = {}): string {
    const payload: Record<string, any> = {
      nonce: crypto.randomBytes(16).toString('hex'),
      createdAt: Date.now(),
      ...customMetadata,
    };
    const payloadStr = JSON.stringify(payload);
    const hmac = crypto
      .createHmac('sha256', env.JWT_SECRET)
      .update(payloadStr)
      .digest('hex');
    return Buffer.from(JSON.stringify({ p: payloadStr, h: hmac })).toString('base64url');
  }

  /**
   * Validates state parameter to protect against CSRF attacks and replay.
   *
   * Supports two formats for backward compatibility:
   *  - New:    base64url({ p: payloadJsonString, h: hmacHex })  → HMAC verified
   *  - Legacy: base64url(payloadJson)                          → timestamp-only check
   */
  public parseAndValidateState(stateStr: string, maxAgeMs = 15 * 60 * 1000): Record<string, any> {
    try {
      const decoded = Buffer.from(stateStr, 'base64url').toString('utf8');
      const outer = JSON.parse(decoded);

      let data: Record<string, any>;

      if (typeof outer.p === 'string' && typeof outer.h === 'string') {
        // New HMAC-signed format
        const expectedHmac = crypto
          .createHmac('sha256', env.JWT_SECRET)
          .update(outer.p)
          .digest('hex');
        const hBuf = Buffer.from(outer.h, 'hex');
        const eBuf = Buffer.from(expectedHmac, 'hex');
        if (hBuf.length !== eBuf.length || !crypto.timingSafeEqual(hBuf, eBuf)) {
          throw new AppError('OAuth state signature is invalid.', 400, 'INVALID_STATE');
        }
        data = JSON.parse(outer.p);
      } else {
        // Legacy plain JSON format — timestamp check still applies
        data = outer;
      }

      if (!data.createdAt || Date.now() - data.createdAt > maxAgeMs) {
        throw new AppError('OAuth state has expired. Please try again.', 400, 'STATE_EXPIRED');
      }
      return data;
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      throw new AppError('Invalid or corrupted OAuth state parameter.', 400, 'INVALID_STATE');
    }
  }

  /**
   * Generates the Google Sign-In URL (Identity flow ONLY - OpenID Connect)
   */
  public getGoogleSignInUrl(state: string): string {
    const client = this.getAuthClient();
    return client.generateAuthUrl({
      access_type: 'online',
      scope: [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      prompt: 'select_account',
      state,
    });
  }

  /**
   * Verifies Google Sign-In authorization code and validates ID token
   */
  public async handleSignInCallback(code: string): Promise<GoogleUserProfile> {
    const client = this.getAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      throw new AppError('Google did not return an ID token for user verification', 400, 'ID_TOKEN_MISSING');
    }

    // Strictly verify OpenID Connect ID token
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      throw new AppError('Google ID token verification failed: missing subject or email claim', 400, 'INVALID_ID_TOKEN');
    }

    const sub = (payload.sub || '').trim();
    if (!sub) {
      throw new AppError('Google ID token verification failed: missing subject identifier', 400, 'INVALID_ID_TOKEN');
    }

    const email = (payload.email || '').trim().toLowerCase();
    if (!email) {
      throw new AppError('Google ID token verification failed: missing email claim', 400, 'INVALID_ID_TOKEN');
    }

    const name = resolveGoogleFullName({
      name: payload.name,
      givenName: payload.given_name,
      familyName: payload.family_name,
      email,
    });

    // Prefer the picture claim from the verified ID token. Some Google
    // responses omit it, so fall back to the OIDC userinfo endpoint.
    let picture = resolveGoogleAvatarUrl(payload.picture);
    if (!picture && tokens.access_token) {
      try {
        client.setCredentials(tokens);
        const oauth2 = google.oauth2({ version: 'v2', auth: client });
        const userInfo = await oauth2.userinfo.get();
        picture = resolveGoogleAvatarUrl(userInfo.data.picture);
      } catch {
        // Profile photo is optional; never fail sign-in over it.
      }
    }

    return {
      sub,
      email,
      name,
      givenName: payload.given_name,
      familyName: payload.family_name,
      picture,
      emailVerified: Boolean(payload.email_verified),
    };
  }

  /**
   * Generates the Gmail integration authorization URL (Decoupled Mailbox flow).
   *
   * `prompt: 'select_account consent'` is required so that:
   *   - `select_account` always shows Google's account chooser, letting the user
   *     authorize a *different* mailbox than the one currently signed in (this is
   *     what makes connecting multiple Gmail accounts possible), and
   *   - `consent` forces the consent screen so Google reliably returns a
   *     refresh_token for offline access.
   *
   * `loginHint` only pre-highlights an account on the chooser; it never forces
   * selection, so it is safe for the reconnect path.
   */
  public getGmailConnectUrl(state: string, loginHint?: string): string {
    const client = this.getGmailClient();
    return client.generateAuthUrl({
      access_type: 'offline', // Required to obtain refresh_token
      prompt: 'select_account consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      login_hint: loginHint,
      state,
    });
  }

  /**
   * Exchanges Gmail authorization code for access and refresh tokens
   */
  public async handleGmailCallback(code: string) {
    const client = this.getGmailClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.access_token) {
      throw new AppError('Google failed to provide an access token for Gmail', 400, 'ACCESS_TOKEN_MISSING');
    }

    // Set credentials on client to inspect user profile
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userInfo = await oauth2.userinfo.get();

    const gmail = google.gmail({ version: 'v1', auth: client });
    // The profile read is billed to the connected mailbox, so it goes through the
    // shared quota controller like every other Gmail call.
    const mailboxKey = (userInfo.data.email || 'gmail-oauth-setup').toLowerCase();
    const profileResult = await gmailQuotaService.call({
      mailboxKey,
      method: 'getProfile',
      cost: GMAIL_METHOD_QUOTA_COST['getProfile'] ?? 1,
      fn: () => gmail.users.getProfile({ userId: 'me' }),
    });
    const profile = profileResult.value;

    return {
      tokens,
      emailAddress: (profile.data.emailAddress || userInfo.data.email || '').toLowerCase(),
      googleSub: userInfo.data.id || '',
      displayName: userInfo.data.name || profile.data.emailAddress || 'Gmail Account',
      historyId: profile.data.historyId,
    };
  }

  /**
   * Returns an authorized Google OAuth2 client with auto-refresh capabilities
   */
  public createAuthorizedClient(credentials: {
    accessToken: string;
    refreshToken?: string;
    expiryDate?: number;
  }) {
    const client = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID || 'client-id',
      env.GOOGLE_CLIENT_SECRET || 'client-secret',
      env.GOOGLE_GMAIL_REDIRECT_URI
    );

    client.setCredentials({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      expiry_date: credentials.expiryDate,
    });

    return client;
  }
}

export const googleOAuthService = new GoogleOAuthService();

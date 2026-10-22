import { Request, Response, NextFunction, CookieOptions } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { UserRole } from './tenantContext.js';
import { AppError } from './errorHandler.js';

export const SESSION_COOKIE_NAME = 'swaniki_session';
export const OAUTH_STATE_COOKIE_NAME = 'swaniki_oauth_state';
export const GMAIL_STATE_COOKIE_NAME = 'swaniki_gmail_state';

export interface SessionPayload {
  userId: string;
  email: string;
  organizationId: string;
  role: UserRole;
  sessionId: string;
}

export const getSessionCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax', // Needed for Google OAuth top-level redirects
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
});

export const getStateCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 10 * 60 * 1000, // 10 minutes
});

/**
 * Server-side session revocation registry.
 *
 * The session token is a stateless JWT, so it cannot be "un-signed". To make
 * sign-out meaningful we keep a denylist of revoked `sessionId`s and reject any
 * token that references one, until its natural expiry. This is process-local;
 * multi-instance deployments should back it with a shared store (Redis/Mongo).
 */
const revokedSessions = new Map<string, number>();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function revokeSession(sessionId?: string, expiresAtMs?: number): void {
  if (!sessionId) return;
  const expiry =
    typeof expiresAtMs === 'number' && expiresAtMs > Date.now()
      ? expiresAtMs
      : Date.now() + SESSION_TTL_MS;
  revokedSessions.set(sessionId, expiry);
}

export function isSessionRevoked(sessionId?: string): boolean {
  if (!sessionId) return false;
  const expiry = revokedSessions.get(sessionId);
  if (expiry === undefined) return false;
  if (expiry <= Date.now()) {
    revokedSessions.delete(sessionId);
    return false;
  }
  return true;
}

/** Test helper: clears the in-memory revocation denylist. */
export function clearRevokedSessions(): void {
  revokedSessions.clear();
}

export function signSessionToken(payload: SessionPayload): string {
  return jwt.sign(payload, env.SESSION_SECRET, { expiresIn: '7d' });
}

export function verifySessionToken(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, env.SESSION_SECRET) as SessionPayload;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, payload: SessionPayload): void {
  const token = signSessionToken(payload);
  res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Clears every authentication-related cookie (session + OAuth handshake state)
 * so a signed-out browser cannot resume a half-finished OAuth flow.
 */
export function clearAllAuthCookies(res: Response): void {
  const base: CookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
  clearSessionCookie(res);
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, base);
  res.clearCookie(GMAIL_STATE_COOKIE_NAME, base);
}

/**
 * Middleware that extracts user session from HttpOnly cookie or Authorization Bearer header.
 * Falls back to dev headers or mock user in development.
 */
export function sessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.substring(7).trim()
    : undefined;
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  const queryToken = typeof req.query.token === 'string' && req.query.token.trim()
    ? req.query.token.trim()
    : undefined;

  const tokensToTry = [bearerToken, cookieToken, queryToken].filter(Boolean) as string[];

  for (const token of tokensToTry) {
    const decoded = verifySessionToken(token);
    if (decoded) {
      if (isSessionRevoked(decoded.sessionId)) {
        // Token is structurally valid but its session was explicitly revoked
        // (e.g. the user signed out). Treat it as an expired session.
        req.sessionExpired = true;
        continue;
      }
      req.userId = decoded.userId;
      req.organizationId = decoded.organizationId;
      req.userRole = decoded.role;
      req.sessionId = decoded.sessionId;
      req.hasValidSession = true;
      req.isDevMock = false;
      return next();
    }
  }

  if (tokensToTry.length > 0) {
    // Tokens were supplied but all failed verification (expired or invalid signature)
    req.sessionExpired = true;
  }

  // Fallback to headers (for backward compatibility, automated API tests, or dev mock)
  const headerOrgId = req.headers['x-organization-id'] as string | undefined;
  const headerUserId = req.headers['x-user-id'] as string | undefined;
  const headerUserRole = req.headers['x-user-role'] as UserRole | undefined;

  const validRoles: UserRole[] = ['owner', 'admin', 'manager', 'sales_rep', 'viewer'];

  req.organizationId = headerOrgId?.trim() || env.DEV_MOCK_ORG_ID;
  req.userId = headerUserId?.trim() || env.DEV_MOCK_USER_ID;
  req.userRole = headerUserRole && validRoles.includes(headerUserRole) ? headerUserRole : 'owner';
  req.isDevMock = !headerOrgId || !headerUserId;

  next();
}

/**
 * Strict auth guard middleware for protected endpoints
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  // Reject explicitly expired or invalid session tokens
  if (req.sessionExpired) {
    throw new AppError('Your session has expired. Please sign in with Google.', 401, 'UNAUTHORIZED');
  }

  // If request has a valid session or is explicit authenticated user
  if (req.userId && !req.isDevMock) {
    return next();
  }

  // In test or non-production environment, allow fallback only if no invalid session cookie was provided
  if (env.NODE_ENV !== 'production' && req.userId && !req.cookies?.[SESSION_COOKIE_NAME]) {
    return next();
  }

  throw new AppError('Authentication required. Please sign in with Google.', 401, 'UNAUTHORIZED');
}

/**
 * Strict guard for sensitive, account-level operations (e.g. clearing mailbox
 * data). Unlike `requireAuth`, this does NOT accept the dev/header identity
 * fallback: a real, non-revoked session token must be present.
 */
export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (req.sessionExpired || !req.hasValidSession) {
    throw new AppError('Authentication required. Please sign in with Google.', 401, 'UNAUTHORIZED');
  }
  next();
}

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { User, IUser, normalizeUserStatus } from '../models/User.js';
import { Organization } from '../models/Organization.js';
import {
  googleOAuthService,
  resolveGoogleFullName,
  resolveGoogleAvatarUrl,
} from '../services/google-oauth.service.js';
import {
  setSessionCookie,
  clearAllAuthCookies,
  revokeSession,
  OAUTH_STATE_COOKIE_NAME,
  getStateCookieOptions,
  requireAuth,
  signSessionToken,
} from '../middleware/session.js';
import { AppError } from '../middleware/errorHandler.js';
import { clearUserMailData, ClearMailDataResult } from '../services/mailbox-cleanup.service.js';

const router = Router();

/**
 * GET /api/v1/auth/google
 * Initiates the Google Sign-In (OpenID Connect) flow
 */
router.get('/google', (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError(
        'Google Sign-In is not configured yet. Please configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env, or use Quick Dev Login for local development.',
        503,
        'GOOGLE_OAUTH_NOT_CONFIGURED'
      );
    }

    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/dashboard';
    const state = googleOAuthService.generateSecureState({ returnTo });

    // Store state in an HttpOnly cookie to verify in callback (CSRF mitigation)
    res.cookie(OAUTH_STATE_COOKIE_NAME, state, getStateCookieOptions());

    const authUrl = googleOAuthService.getGoogleSignInUrl(state);
    res.redirect(authUrl);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/auth/google/callback
 * Handles Google OAuth callback, verifies ID token, provisions user and session
 */
router.get('/google/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      throw new AppError(`Google authentication failed: ${error}`, 400, 'GOOGLE_AUTH_FAILED');
    }

    if (!code || typeof code !== 'string') {
      throw new AppError('Authorization code missing from Google callback', 400, 'MISSING_AUTH_CODE');
    }

    // Verify state against cookie if present, and cryptographically validate
    const stateCookie = req.cookies?.[OAUTH_STATE_COOKIE_NAME];
    if (!state || typeof state !== 'string' || (stateCookie && state !== stateCookie)) {
      throw new AppError('Invalid or expired OAuth state parameter. Request rejected.', 400, 'STATE_MISMATCH');
    }

    const stateData = googleOAuthService.parseAndValidateState(state);
    const returnTo = stateData.returnTo || '/dashboard';

    // Clear state cookie
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    // Exchange code and verify OpenID Connect token
    const profile = await googleOAuthService.handleSignInCallback(code);

    const googleSub = (profile.sub || '').trim();
    if (!googleSub) {
      throw new AppError('Google authentication failed: missing subject identifier', 400, 'INVALID_GOOGLE_SUB');
    }

    const normalizedEmail = (profile.email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      throw new AppError('Google authentication failed: missing email claim', 400, 'INVALID_GOOGLE_EMAIL');
    }

    const fullName = resolveGoogleFullName({
      name: profile.name,
      givenName: profile.givenName,
      familyName: profile.familyName,
      email: normalizedEmail,
    });

    // 1. Look up existing user by Google subject first
    let user = await User.findOne({ googleSub });

    if (user) {
      // Security check: Never reactivate or log in a disabled user through Google OAuth
      const currentStatus = normalizeUserStatus(user.status);
      if (currentStatus === 'disabled') {
        throw new AppError('This user account has been disabled. Please contact your administrator.', 403, 'ACCOUNT_DISABLED');
      }

      let isDirty = false;

      // Reconcile status to actual lowercase schema enum
      if (user.status !== currentStatus) {
        user.status = currentStatus;
        isDirty = true;
      }

      // If user was invited, activate upon successful Google authentication
      if (user.status === 'invited') {
        user.status = 'active';
        isDirty = true;
      }

      // Ensure valid fullName
      if (!user.fullName || !user.fullName.trim()) {
        user.fullName = fullName;
        isDirty = true;
      }

      // Persist avatar: update only when Google provides a safe, non-empty URL
      const googleAvatar = resolveGoogleAvatarUrl(profile.picture);
      if (googleAvatar && user.avatarUrl !== googleAvatar) {
        user.avatarUrl = googleAvatar;
        isDirty = true;
      }

      if (isDirty) {
        await user.save();
      }
    } else {
      // 2. Check if user exists by email to link account safely
      const existingUserByEmail = await User.findOne({ email: normalizedEmail });

      if (existingUserByEmail) {
        // Security check: Do not automatically link accounts based only on an unverified email
        if (!profile.emailVerified) {
          throw new AppError(
            'Cannot link Google account because the email address is not verified by Google.',
            400,
            'UNVERIFIED_EMAIL'
          );
        }

        // Security check: Never reactivate a disabled user through Google OAuth
        const existingStatus = normalizeUserStatus(existingUserByEmail.status);
        if (existingStatus === 'disabled') {
          throw new AppError(
            'This user account has been disabled. Please contact your administrator.',
            403,
            'ACCOUNT_DISABLED'
          );
        }

        // Security check: If already linked to a different Google account, prevent takeover
        if (existingUserByEmail.googleSub && existingUserByEmail.googleSub !== googleSub) {
          throw new AppError(
            'This email account is already associated with a different Google account.',
            409,
            'ACCOUNT_ALREADY_LINKED'
          );
        }

        // Link the Google account
        existingUserByEmail.googleSub = googleSub;

        // If invited, activate upon login; otherwise reconcile status
        if (existingUserByEmail.status === 'invited') {
          existingUserByEmail.status = 'active';
        } else {
          existingUserByEmail.status = existingStatus;
        }

        // Ensure valid fullName
        if (!existingUserByEmail.fullName || !existingUserByEmail.fullName.trim()) {
          existingUserByEmail.fullName = fullName;
        }

        // Persist avatar: update only when Google provides a safe, non-empty URL
        const googleAvatar = resolveGoogleAvatarUrl(profile.picture);
        if (googleAvatar && existingUserByEmail.avatarUrl !== googleAvatar) {
          existingUserByEmail.avatarUrl = googleAvatar;
        }

        // Preserve existing organization memberships and roles without granting unauthorized privileges
        await existingUserByEmail.save();
        user = existingUserByEmail;
      }
    }

    if (!user) {
      // 3. First-time registration (approved onboarding flow)
      // Provision first isolated organization for new user
      const orgSlug = `org-${crypto.randomBytes(4).toString('hex')}`;
      const org = await Organization.create({
        name: `${fullName}'s Organization`,
        slug: orgSlug,
        createdBy: googleSub,
      });

      try {
        user = await User.create({
        email: normalizedEmail,
        fullName,
        avatarUrl: resolveGoogleAvatarUrl(profile.picture),
        googleSub,
        status: 'active',
        defaultOrgId: org._id.toString(),
        organizations: [
          {
            organizationId: org._id.toString(),
            role: 'owner',
          },
        ],
      });
      } catch (createErr: any) {
        if (createErr.code === 11000 || createErr.name === 'MongoServerError') {
          throw new AppError(
            'An account with this email or Google account already exists.',
            409,
            'DUPLICATE_USER'
          );
        }
        throw createErr;
      }
    }

    // Ensure user has at least one valid organization membership
    if (!user.organizations || user.organizations.length === 0) {
      let org = await Organization.findOne({ createdBy: user.googleSub || user._id.toString() });
      if (!org) {
        const orgSlug = `org-${crypto.randomBytes(4).toString('hex')}`;
        org = await Organization.create({
          name: `${user.fullName || 'User'}'s Organization`,
          slug: orgSlug,
          createdBy: user.googleSub || user._id.toString(),
        });
      }
      user.organizations = [{ organizationId: org._id.toString(), role: 'owner' }];
      user.defaultOrgId = org._id.toString();
      await user.save();
    }

    const activeOrgId =
      user.defaultOrgId ||
      user.organizations[0]?.organizationId ||
      env.DEV_MOCK_ORG_ID;

    const matchedMembership =
      user.organizations.find((o) => o.organizationId === activeOrgId) ||
      user.organizations[0];

    const activeRole = matchedMembership?.role || 'owner';

    // Establish secure session cookie
    const sessionId = `sess_${crypto.randomBytes(16).toString('hex')}`;
    const token = signSessionToken({
      userId: user._id.toString(),
      email: user.email,
      organizationId: activeOrgId,
      role: activeRole,
      sessionId,
    });
    setSessionCookie(res, {
      userId: user._id.toString(),
      email: user.email,
      organizationId: activeOrgId,
      role: activeRole,
      sessionId,
    });

    // Redirect to frontend destination with session context
    const targetUrl = new URL(returnTo, env.CLIENT_URL);
    targetUrl.searchParams.set('token', token);
    targetUrl.searchParams.set('uid', user._id.toString());
    targetUrl.searchParams.set('oid', activeOrgId);
    targetUrl.searchParams.set('role', activeRole);
    res.redirect(targetUrl.toString());
  } catch (err: any) {
    console.error('Google Sign-In callback error:', err);
    const redirectUrl = `${env.CLIENT_URL}/login?error=${encodeURIComponent(err.message || 'Authentication failed')}`;
    res.redirect(redirectUrl);
  }
});

/**
 * GET /api/v1/auth/me
 * Returns current authenticated user and organization context
 */
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // A token was supplied but could not be verified (expired or malformed).
    // Surface this as 401 so clients clear their session instead of looping.
    if (req.sessionExpired) {
      throw new AppError('Your session has expired. Please sign in with Google.', 401, 'UNAUTHORIZED');
    }

    // Only query Mongo with a syntactically valid ObjectId. Identity headers
    // (or legacy values persisted in localStorage) may be arbitrary strings;
    // passing one to findById throws a Mongoose CastError that the error
    // handler maps to a 400, so guard against it here.
    const rawUserId = (req.userId || '').trim();
    const isObjectId = /^[a-f0-9]{24}$/i.test(rawUserId);

    let user: any = null;

    if (isObjectId) {
      user = await User.findById(rawUserId).lean();
    }

    // Dev/test-only synthetic identity for the explicit header fallback.
    // Skipped in production and whenever a real tenant is claimed via headers.
    if (!user && env.NODE_ENV !== 'production' && req.isDevMock && req.headers['x-user-id']) {
      user = {
        _id: req.userId,
        email: 'developer@swaniki.dev',
        fullName: 'Swaniki Lead Engineer',
        avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=128&q=80',
        defaultOrgId: env.DEV_MOCK_ORG_ID,
        organizations: [{ organizationId: env.DEV_MOCK_ORG_ID, role: 'owner' }],
        isDevMock: true,
      };
    }

    if (!user) {
      return res.status(200).json({
        success: true,
        data: null,
      });
    }

    // Filter to valid ObjectIds so dev-mock/legacy org identifiers (which are
    // not ObjectIds) cannot trigger a CastError -> 400 in this session probe.
    const orgIds = (user.organizations?.map((o: any) => o.organizationId) || [req.organizationId])
      .filter((id: any): id is string => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id));

    const orgs = orgIds.length
      ? await Organization.find({ _id: { $in: orgIds } }).lean()
      : [];

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user._id,
          email: user.email,
          fullName: user.fullName,
          avatarUrl: resolveGoogleAvatarUrl(user.avatarUrl) || null,
          googleSub: user.googleSub,
          isDevMock: req.isDevMock,
        },
        organizationId: req.organizationId,
        userRole: req.userRole,
        organizations: orgs,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/auth/dev-login
 * Development-only login for testing when Google credentials are not set
 */
router.post('/dev-login', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (env.NODE_ENV === 'production') {
      throw new AppError('Dev login is strictly forbidden in production mode.', 403, 'FORBIDDEN');
    }

    let devOrg = await Organization.findOne({ slug: 'swaniki-dev-org' });
    if (!devOrg) {
      devOrg = await Organization.create({
        name: 'Swaniki Global Outreach (Dev Org)',
        slug: 'swaniki-dev-org',
        createdBy: 'usr_dev_master_001',
      });
    }

    let devUser = await User.findOne({ email: 'developer@swaniki.dev' });
    if (devUser) {
      if (normalizeUserStatus(devUser.status) === 'disabled') {
        throw new AppError('Dev user account has been disabled.', 403, 'ACCOUNT_DISABLED');
      }
      const reconciled = normalizeUserStatus(devUser.status);
      if (devUser.status !== reconciled) {
        devUser.status = reconciled;
        await devUser.save();
      }
    } else {
      devUser = await User.create({
        email: 'developer@swaniki.dev',
        fullName: 'Lead Engineer (Dev Mode)',
        avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=128&q=80',
        status: 'active',
        defaultOrgId: devOrg._id.toString(),
        organizations: [
          {
            organizationId: devOrg._id.toString(),
            role: 'owner',
          },
        ],
      });
    }

    const sessionId = `sess_dev_${crypto.randomBytes(8).toString('hex')}`;
    const token = signSessionToken({
      userId: devUser._id.toString(),
      email: devUser.email,
      organizationId: devOrg._id.toString(),
      role: 'owner',
      sessionId,
    });
    setSessionCookie(res, {
      userId: devUser._id.toString(),
      email: devUser.email,
      organizationId: devOrg._id.toString(),
      role: 'owner',
      sessionId,
    });

    res.status(200).json({
      success: true,
      data: {
        token,
        user: {
          id: devUser._id,
          email: devUser.email,
          fullName: devUser.fullName,
          avatarUrl: devUser.avatarUrl,
        },
        organizationId: devOrg._id.toString(),
        userRole: 'owner',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/auth/logout
 *
 * Ends the current application session. Supports two distinct actions:
 *   - mode "session" (default): revoke the session, clear all auth cookies.
 *   - mode "clear-mail-data": additionally disconnect every Gmail mailbox owned
 *     by the current user and delete all locally synchronized mail data.
 *
 * Account, organization, CRM and campaign records are always preserved.
 */
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestedMode = (req.body?.mode ?? 'session') as string;
    const mode: 'session' | 'clear-mail-data' =
      requestedMode === 'clear-mail-data' ? 'clear-mail-data' : 'session';

    if (mode === 'clear-mail-data' && !req.hasValidSession) {
      throw new AppError(
        'A valid signed-in session is required to clear mailbox data.',
        401,
        'UNAUTHORIZED'
      );
    }

    // Perform the (potentially destructive) cleanup BEFORE revoking the session,
    // so a hard failure leaves the user signed in and able to retry.
    let mailData: ClearMailDataResult | null = null;
    if (mode === 'clear-mail-data') {
      mailData = await clearUserMailData(req.organizationId, req.userId);
    }

    // Revoke the current session (stateless JWT -> denylist by sessionId), then
    // clear every auth-related cookie.
    revokeSession(req.sessionId);
    clearAllAuthCookies(res);

    res.status(200).json({
      success: true,
      message:
        mode === 'clear-mail-data'
          ? 'Signed out and cleared synchronized mail data.'
          : 'Logged out successfully.',
      data: {
        mode,
        ...(mailData ? { mailData } : {}),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;

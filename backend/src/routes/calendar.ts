import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { CalendarAccount } from '../models/CalendarAccount.js';
import { googleOAuthService } from '../services/google-oauth.service.js';
import { googleCalendarService } from '../services/google-calendar.service.js';
import { encryptToken } from '../utils/crypto.js';
import { requireAuth } from '../middleware/session.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

// OAuth initiation
router.get('/google/connect', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError(
        'Google OAuth credentials not configured. Please configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env',
        503,
        'OAUTH_NOT_CONFIGURED'
      );
    }
    const state = googleOAuthService.generateSecureState({
      organizationId: req.organizationId,
      userId: req.userId,
      returnTo: typeof req.query.returnTo === 'string' ? req.query.returnTo : '/integrations',
    });
    const url = googleCalendarService.getCalendarConnectUrl(state);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// OAuth Callback
router.get('/google/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, state, error } = req.query;
    if (error) {
      throw new AppError(`Calendar authorization failed: ${error}`, 400, 'CALENDAR_AUTH_FAILED');
    }
    if (!code || typeof code !== 'string') {
      throw new AppError('Authorization code missing from callback.', 400, 'MISSING_CODE');
    }
    if (!state || typeof state !== 'string') {
      throw new AppError('State parameter missing.', 400, 'INVALID_STATE');
    }

    const stateData = googleOAuthService.parseAndValidateState(state);
    const orgId = stateData.organizationId;
    const userId = stateData.userId;
    const returnTo = stateData.returnTo || '/integrations';

    const accountData = await googleCalendarService.handleCalendarCallback(code);

    await CalendarAccount.findOneAndUpdate(
      { organizationId: orgId, emailAddress: accountData.email },
      {
        $set: {
          organizationId: orgId,
          userId,
          displayName: accountData.name,
          emailAddress: accountData.email,
          provider: 'google',
          status: 'connected',
          encryptedAccessToken: accountData.accessToken ? encryptToken(accountData.accessToken) : undefined,
          encryptedRefreshToken: accountData.refreshToken ? encryptToken(accountData.refreshToken) : undefined,
          tokenExpiryDate: accountData.expiryDate ? new Date(accountData.expiryDate) : undefined,
          grantedScopes: accountData.scopes,
        },
      },
      { upsert: true, new: true }
    );

    res.redirect(`${env.CLIENT_URL}${returnTo}?calendar_connected=${encodeURIComponent(accountData.email)}`);
  } catch (err: any) {
    console.error('Calendar OAuth error:', err);
    res.redirect(`${env.CLIENT_URL}/integrations?error=${encodeURIComponent(err.message || 'Calendar connection failed')}`);
  }
});

// Accounts list
router.get('/accounts', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await CalendarAccount.find({
      organizationId: req.organizationId,
    })
      .select('-encryptedAccessToken -encryptedRefreshToken')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ success: true, data: accounts });
  } catch (err) {
    next(err);
  }
});

// Disconnect
router.delete('/accounts/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await CalendarAccount.findOneAndDelete({
      _id: req.params.id,
      organizationId: req.organizationId,
    });
    if (!account) {
      throw new AppError('Calendar connection not found', 404, 'NOT_FOUND');
    }
    res.status(200).json({ success: true, data: { disconnected: true } });
  } catch (err) {
    next(err);
  }
});

// Ambiguity parser
const parseMeetingSchema = z.object({
  text: z.string().min(1, 'Meeting text or notes are required'),
  timezone: z.string().optional(),
  contactEmail: z.string().optional(),
  contactName: z.string().optional(),
  companyName: z.string().optional(),
});

router.post('/parse-meeting', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = parseMeetingSchema.parse(req.body);
    const result = googleCalendarService.parseNaturalLanguageMeeting(data.text, data);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Event creation
const createEventSchema = z.object({
  calendarAccountId: z.string().optional(),
  summary: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  startTime: z.string().min(1, 'Start time is required'),
  endTime: z.string().min(1, 'End time is required'),
  timezone: z.string().default('Asia/Kolkata'),
  attendees: z.array(z.string().email()).default([]),
  addMeetLink: z.boolean().default(true),
});

router.post('/events', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createEventSchema.parse(req.body);
    const event = await googleCalendarService.createCalendarEvent({
      organizationId: req.organizationId,
      userId: req.userId,
      ...body,
    });
    res.status(201).json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
});

export default router;

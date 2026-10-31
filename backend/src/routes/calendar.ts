import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { CalendarAccount } from '../models/CalendarAccount.js';
import { googleOAuthService } from '../services/google-oauth.service.js';
import { googleCalendarService } from '../services/google-calendar.service.js';
import { googleTasksService } from '../services/google-tasks.service.js';
import { pullGoogleChanges } from '../services/productivity-sync.service.js';
import { encryptToken } from '../utils/crypto.js';
import { requireAuth } from '../middleware/session.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

/** Finds the Google account that belongs to the calling user. */
function findUserGoogleAccount(req: Request) {
  return CalendarAccount.findOne({
    organizationId: req.organizationId,
    userId: req.userId,
    provider: 'google',
  }).sort({ createdAt: -1 });
}

function serializeAccount(account: any) {
  return {
    id: String(account._id),
    connected: account.status === 'connected',
    status: account.status,
    email: account.emailAddress,
    displayName: account.displayName,
    provider: account.provider,
    calendarId: account.calendarId || 'primary',
    taskListId: account.taskListId || '@default',
    taskListName: account.taskListName || null,
    syncTasks: account.syncTasks !== false,
    syncCalendar: account.syncCalendar !== false,
    syncMeet: account.syncMeet !== false,
    autoSync: account.autoSync !== false,
    tasksScopeGranted: (account.grantedScopes || []).includes(TASKS_SCOPE),
    grantedScopes: account.grantedScopes || [],
    lastSyncedAt: account.lastSyncedAt || null,
    lastSyncError: account.lastSyncError || null,
  };
}

/** Prevents a client from hammering the Google APIs through manual sync. */
const lastManualSync = new Map<string, number>();
const MANUAL_SYNC_INTERVAL_MS = 15 * 1000;


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
router.get('/google/callback', async (req: Request, res: Response) => {
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

// Integration settings (per user)
const integrationSettingsSchema = z.object({
  calendarId: z.string().trim().min(1).max(200).optional(),
  taskListId: z.string().trim().min(1).max(200).optional(),
  taskListName: z.string().trim().max(120).optional(),
  syncTasks: z.boolean().optional(),
  syncCalendar: z.boolean().optional(),
  syncMeet: z.boolean().optional(),
  autoSync: z.boolean().optional(),
});

router.get('/integration-settings', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await findUserGoogleAccount(req);
    if (!account) {
      res.status(200).json({
        success: true,
        data: {
          connected: false,
          email: null,
          calendarId: 'primary',
          taskListId: '@default',
          taskListName: null,
          syncTasks: false,
          syncCalendar: false,
          syncMeet: false,
          autoSync: false,
          tasksScopeGranted: false,
          grantedScopes: [],
          lastSyncedAt: null,
          lastSyncError: null,
        },
      });
      return;
    }
    res.status(200).json({ success: true, data: serializeAccount(account) });
  } catch (err) {
    next(err);
  }
});

router.patch('/integration-settings', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = integrationSettingsSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      throw new AppError('No integration settings supplied', 400, 'EMPTY_UPDATE');
    }

    const account = await findUserGoogleAccount(req);
    if (!account) {
      throw new AppError(
        'Connect a Google account before changing synchronization settings.',
        400,
        'GOOGLE_NOT_CONNECTED'
      );
    }

    if (body.calendarId !== undefined) account.calendarId = body.calendarId;
    if (body.taskListId !== undefined) account.taskListId = body.taskListId;
    if (body.taskListName !== undefined) account.taskListName = body.taskListName || undefined;
    if (body.syncTasks !== undefined) account.syncTasks = body.syncTasks;
    if (body.syncCalendar !== undefined) account.syncCalendar = body.syncCalendar;
    if (body.syncMeet !== undefined) account.syncMeet = body.syncMeet;
    if (body.autoSync !== undefined) account.autoSync = body.autoSync;
    await account.save();

    res.status(200).json({ success: true, data: serializeAccount(account) });
  } catch (err) {
    next(err);
  }
});

// Available Google calendars and task lists for the connected account.
router.get('/calendars', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await findUserGoogleAccount(req);
    if (!account) {
      throw new AppError(
        'Connect a Google account before listing calendars.',
        400,
        'GOOGLE_NOT_CONNECTED'
      );
    }
    const calendars = await googleCalendarService.listCalendars({
      organizationId: req.organizationId,
      userId: req.userId,
      calendarAccountId: String(account._id),
    });
    res.status(200).json({ success: true, data: calendars });
  } catch (err) {
    next(err);
  }
});

router.get('/task-lists', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await findUserGoogleAccount(req);
    if (!account) {
      throw new AppError(
        'Connect a Google account before listing task lists.',
        400,
        'GOOGLE_NOT_CONNECTED'
      );
    }
    const taskLists = await googleTasksService.listTaskLists({
      organizationId: req.organizationId,
      userId: req.userId,
      calendarAccountId: String(account._id),
    });
    res.status(200).json({ success: true, data: taskLists });
  } catch (err) {
    next(err);
  }
});

// Manual two-way sync (tasks + calendar time blocks).
router.post('/sync', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await findUserGoogleAccount(req);
    if (!account) {
      throw new AppError(
        'Connect a Google account before synchronizing.',
        400,
        'GOOGLE_NOT_CONNECTED'
      );
    }

    const key = `${req.organizationId}:${req.userId}`;
    const last = lastManualSync.get(key) || 0;
    if (Date.now() - last < MANUAL_SYNC_INTERVAL_MS) {
      throw new AppError('Sync is already running. Try again in a few seconds.', 429, 'SYNC_THROTTLED');
    }
    lastManualSync.set(key, Date.now());

    const result = await pullGoogleChanges(req.organizationId, req.userId);
    res.status(200).json({ success: true, data: result });
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

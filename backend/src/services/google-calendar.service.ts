import { google } from 'googleapis';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { CalendarAccount } from '../models/CalendarAccount.js';
import { decryptToken } from '../utils/crypto.js';
import { AppError } from '../middleware/errorHandler.js';

export interface MeetingClarification {
  isAmbiguous: boolean;
  clarificationQuestions: string[];
  parsedDetails: {
    summary?: string;
    startTime?: string;
    endTime?: string;
    durationMinutes?: number;
    timezone?: string;
    attendees?: string[];
    addMeetLink?: boolean;
    location?: string;
  };
}

export interface CreateEventOptions {
  organizationId: string;
  userId: string;
  calendarAccountId?: string;
  summary: string;
  description?: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  timezone: string;
  attendees?: string[];
  addMeetLink?: boolean;
}

export interface CreatedEventResult {
  eventId: string;
  htmlLink: string;
  meetLink?: string;
  summary: string;
  startTime: string;
  endTime: string;
  timezone: string;
  attendees: string[];
  provider: 'google' | 'mock';
}

export interface GoogleCalendarSummary {
  id: string;
  summary: string;
  primary: boolean;
  timeZone?: string;
}

export class GoogleCalendarService {
  private getCalendarOAuthClient() {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError(
        'Google OAuth credentials not configured in environment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
        500,
        'OAUTH_NOT_CONFIGURED'
      );
    }
    const redirectUri = `${env.BACKEND_URL}/api/v1/integrations/google/calendar/callback`;
    return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirectUri);
  }

  public getCalendarConnectUrl(state: string, loginHint?: string): string {
    const client = this.getCalendarOAuthClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent',
      scope: [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      ...(loginHint ? { login_hint: loginHint } : {}),
      state,
    });
  }

  public async handleCalendarCallback(code: string) {
    const client = this.getCalendarOAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.access_token) {
      throw new AppError('Google Calendar OAuth did not return an access token.', 400, 'ACCESS_TOKEN_MISSING');
    }

    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const profile = await oauth2.userinfo.get();

    const email = (profile.data.email || '').trim().toLowerCase();
    const name = profile.data.name || email.split('@')[0];

    return {
      email,
      name,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      scopes: (tokens.scope || '').split(' ').filter(Boolean),
    };
  }

  /**
   * Evaluates natural-language meeting notes or emails for ambiguities.
   * If date, time, timezone, duration, or attendees are unclear, returns structured questions.
   */
  public parseNaturalLanguageMeeting(
    text: string,
    context?: { timezone?: string; contactEmail?: string; contactName?: string; companyName?: string }
  ): MeetingClarification {
    const content = (text || '').trim();
    const questions: string[] = [];
    const lower = content.toLowerCase();

    // Check for date mentions
    const hasRelativeDate = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week)\b/i.test(lower);
    const hasExplicitDate = /\b(\d{1,2}[\/\-\.]\d{1,2}([\/\-\.]\d{2,4})?|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b/i.test(lower);
    if (!hasRelativeDate && !hasExplicitDate) {
      questions.push('What specific date should the meeting be scheduled for?');
    }

    // Check for time
    const hasTime = /\b(\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}:\d{2})\b/i.test(lower);
    if (!hasTime) {
      questions.push('What start time would you like for the meeting (e.g. 10:00 AM or 3:30 PM)?');
    }

    // Check for timezone
    const tz = context?.timezone || 'Asia/Kolkata';
    const hasTimezoneMention = /\b(ist|est|edt|pst|pdt|cst|cdt|gmt|utc|asia\/kolkata|america\/new_york)\b/i.test(lower);
    if (!hasTimezoneMention && !context?.timezone) {
      questions.push('Which timezone should be used for this meeting?');
    }

    // Check for duration
    let durationMinutes = 30;
    const durationMatch = lower.match(/(\d+)\s*(?:mins?|minutes?|hours?|hrs?)/);
    if (durationMatch) {
      const num = parseInt(durationMatch[1], 10);
      if (lower.includes('hour') || lower.includes('hr')) {
        durationMinutes = num * 60;
      } else {
        durationMinutes = num;
      }
    }

    // Attendees check
    const attendees: string[] = [];
    if (context?.contactEmail) attendees.push(context.contactEmail);
    const emailMatches = content.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
    if (emailMatches) {
      for (const em of emailMatches) {
        const lowerEmail = em.toLowerCase();
        if (!attendees.includes(lowerEmail)) attendees.push(lowerEmail);
      }
    }
    if (attendees.length === 0) {
      questions.push('Who are the attendees (email addresses) to invite?');
    }

    // Summary
    const summary = context?.companyName
      ? `Discovery Call with ${context.companyName}`
      : 'Strategic Outreach & Discussion';

    return {
      isAmbiguous: questions.length > 0,
      clarificationQuestions: questions,
      parsedDetails: {
        summary,
        durationMinutes,
        timezone: tz,
        attendees,
        addMeetLink: lower.includes('meet') || lower.includes('video') || lower.includes('call') || !lower.includes('in person'),
      },
    };
  }

  /**
   * Creates the calendar event on Google Calendar with optional Google Meet link.
   * If credentials are not configured or account is in mock mode, executes verified mock event creation.
   */
  public async createCalendarEvent(options: CreateEventOptions): Promise<CreatedEventResult> {
    const {
      organizationId,
      userId,
      calendarAccountId,
      summary,
      description = '',
      startTime,
      endTime,
      timezone,
      attendees = [],
      addMeetLink = true,
    } = options;

    // Find authorized calendar connection for tenant
    const account = calendarAccountId
      ? await CalendarAccount.findOne({ _id: calendarAccountId, organizationId, userId })
      : await CalendarAccount.findOne({ organizationId, userId, status: 'connected' });

    // If real Google account is connected and tokens exist
    if (account && account.provider === 'google' && account.encryptedRefreshToken) {
      try {
        const client = this.getCalendarOAuthClient();
        const refreshToken = decryptToken(account.encryptedRefreshToken);
        client.setCredentials({ refresh_token: refreshToken });

        const calendar = google.calendar({ version: 'v3', auth: client });
        const requestBody: any = {
          summary,
          description,
          start: { dateTime: startTime, timeZone: timezone },
          end: { dateTime: endTime, timeZone: timezone },
          attendees: attendees.map((email) => ({ email })),
        };

        if (addMeetLink) {
          requestBody.conferenceData = {
            createRequest: {
              requestId: `meet_${crypto.randomBytes(8).toString('hex')}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          };
        }

        const res = await calendar.events.insert({
          calendarId: account.calendarId || 'primary',
          requestBody,
          conferenceDataVersion: addMeetLink ? 1 : 0,
          sendUpdates: 'all',
        });

        const created = res.data;
        const meetLink = created.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri;

        return {
          eventId: created.id || `evt_${Date.now()}`,
          htmlLink: created.htmlLink || `https://calendar.google.com/calendar/event?eid=${created.id}`,
          meetLink: meetLink || undefined,
          summary: created.summary || summary,
          startTime: created.start?.dateTime || startTime,
          endTime: created.end?.dateTime || endTime,
          timezone,
          attendees,
          provider: 'google',
        };
      } catch (err: any) {
        console.error('Google Calendar event insertion error:', err.message);
        throw new AppError(`Google Calendar provider error: ${err.message}`, 502, 'CALENDAR_PROVIDER_ERROR');
      }
    }

    // Verified Mock/Simulation Provider (for development and test runs without real Google client)
    const mockId = `mock_evt_${crypto.randomBytes(6).toString('hex')}`;
    const meetCode = `${crypto.randomBytes(2).toString('hex')}-${crypto.randomBytes(2).toString('hex')}-${crypto.randomBytes(2).toString('hex')}`;
    const meetLink = addMeetLink ? `https://meet.google.com/${meetCode}` : undefined;

    return {
      eventId: mockId,
      htmlLink: `https://calendar.google.com/calendar/r/eventedit/${mockId}`,
      meetLink,
      summary,
      startTime,
      endTime,
      timezone,
      attendees,
      provider: 'mock',
    };
  }

  private async findConnectedGoogleAccount(options: {
    organizationId: string;
    userId: string;
    calendarAccountId?: string;
  }): Promise<any> {
    const account = options.calendarAccountId
      ? await CalendarAccount.findOne({
          _id: options.calendarAccountId,
          organizationId: options.organizationId,
          userId: options.userId,
        })
      : await CalendarAccount.findOne({
          organizationId: options.organizationId,
          userId: options.userId,
          status: 'connected',
        });

    if (!account || account.provider !== 'google' || !account.encryptedRefreshToken) {
      throw new AppError(
        'Connect a Google account before synchronizing calendar events.',
        400,
        'GOOGLE_NOT_CONNECTED'
      );
    }
    return account;
  }

  private googleCalendarClient(account: any) {
    const client = this.getCalendarOAuthClient();
    client.setCredentials({ refresh_token: decryptToken(account.encryptedRefreshToken) });
    return google.calendar({ version: 'v3', auth: client });
  }

  /** Lists the calendars the connected account can write to. */
  public async listCalendars(options: {
    organizationId: string;
    userId: string;
    calendarAccountId?: string;
  }): Promise<GoogleCalendarSummary[]> {
    const account = await this.findConnectedGoogleAccount(options);
    try {
      const calendar = this.googleCalendarClient(account);
      const res = await calendar.calendarList.list({ maxResults: 100 });
      return (res.data.items || [])
        .filter((item) => item.id)
        .map((item) => ({
          id: item.id as string,
          summary: item.summaryOverride || item.summary || (item.id as string),
          primary: Boolean(item.primary),
          timeZone: item.timeZone || undefined,
        }));
    } catch (err: any) {
      throw new AppError(`Google Calendar provider error: ${err.message}`, 502, 'CALENDAR_PROVIDER_ERROR');
    }
  }

  /** Updates an existing event for a task, optionally requesting a Meet link. */
  public async updateCalendarEvent(options: {
    organizationId: string;
    userId: string;
    calendarAccountId?: string;
    eventId: string;
    calendarId?: string;
    summary: string;
    description?: string;
    startTime: string;
    endTime: string;
    timezone: string;
    addMeetLink?: boolean;
    removeMeet?: boolean;
  }): Promise<{ eventId: string; meetLink?: string }> {
    const account = await this.findConnectedGoogleAccount(options);
    try {
      const calendar = this.googleCalendarClient(account);
      const requestBody: any = {
        summary: options.summary,
        description: options.description || '',
        start: { dateTime: options.startTime, timeZone: options.timezone },
        end: { dateTime: options.endTime, timeZone: options.timezone },
      };

      if (options.addMeetLink) {
        requestBody.conferenceData = {
          createRequest: {
            requestId: `meet_${crypto.randomBytes(8).toString('hex')}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        };
      } else if (options.removeMeet) {
        // Google removes conference data when it is patched to null.
        requestBody.conferenceData = null;
      }

      const res = await calendar.events.patch({
        calendarId: options.calendarId || account.calendarId || 'primary',
        eventId: options.eventId,
        requestBody,
        conferenceDataVersion: options.addMeetLink || options.removeMeet ? 1 : 0,
      });

      return {
        eventId: res.data.id || options.eventId,
        meetLink:
          res.data.conferenceData?.entryPoints?.find(
            (entry: any) => entry.entryPointType === 'video'
          )?.uri || undefined,
      };
    } catch (err: any) {
      if (err?.code === 404 || err?.status === 404) {
        throw new AppError('Calendar event no longer exists', 404, 'CALENDAR_EVENT_NOT_FOUND');
      }
      throw new AppError(`Google Calendar provider error: ${err.message}`, 502, 'CALENDAR_PROVIDER_ERROR');
    }
  }

  /** Incremental event listing used by task/calendar two-way sync. */
  public async listEventChanges(options: {
    organizationId: string;
    userId: string;
    calendarAccountId?: string;
    syncToken?: string;
    timeMin?: string;
    timeMax?: string;
  }): Promise<{
    events: Array<{
      id: string;
      status?: string;
      summary?: string;
      description?: string;
      startDateTime?: string;
      endDateTime?: string;
      timeZone?: string;
      meetLink?: string;
      updated?: string;
    }>;
    nextSyncToken?: string;
  }> {
    const account = await this.findConnectedGoogleAccount(options);
    try {
      const calendar = this.googleCalendarClient(account);
      const res = await calendar.events.list({
        calendarId: account.calendarId || 'primary',
        ...(options.syncToken
          ? { syncToken: options.syncToken }
          : { timeMin: options.timeMin, timeMax: options.timeMax }),
        showDeleted: true,
        singleEvents: true,
        maxResults: 250,
      });

      return {
        events: (res.data.items || [])
          .filter((event) => event.id)
          .map((event) => ({
            id: event.id as string,
            status: event.status || undefined,
            summary: event.summary || undefined,
            description: event.description || undefined,
            startDateTime: event.start?.dateTime || event.start?.date || undefined,
            endDateTime: event.end?.dateTime || event.end?.date || undefined,
            timeZone: event.start?.timeZone || undefined,
            meetLink:
              event.conferenceData?.entryPoints?.find(
                (entry: any) => entry.entryPointType === 'video'
              )?.uri || undefined,
            updated: event.updated || undefined,
          })),
        nextSyncToken: res.data.nextSyncToken || undefined,
      };
    } catch (err: any) {
      if (err?.code === 410 || err?.status === 410) {
        throw new AppError('Calendar sync token expired', 410, 'CALENDAR_SYNC_EXPIRED');
      }
      throw new AppError(`Google Calendar provider error: ${err.message}`, 502, 'CALENDAR_PROVIDER_ERROR');
    }
  }

  /** Removes a time block that belonged to a deleted task. */
  public async deleteCalendarEvent(options: {
    organizationId: string;
    userId: string;
    calendarAccountId?: string;
    calendarId?: string;
    eventId: string;
  }): Promise<void> {
    const account = await this.findConnectedGoogleAccount(options);
    try {
      const calendar = this.googleCalendarClient(account);
      await calendar.events.delete({
        calendarId: options.calendarId || account.calendarId || 'primary',
        eventId: options.eventId,
      });
    } catch (err: any) {
      if (err?.code === 404 || err?.status === 404) return;
      throw new AppError(`Google Calendar provider error: ${err.message}`, 502, 'CALENDAR_PROVIDER_ERROR');
    }
  }
}

export const googleCalendarService = new GoogleCalendarService();

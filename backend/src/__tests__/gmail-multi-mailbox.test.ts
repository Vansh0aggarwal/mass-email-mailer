import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { connectDatabase } from '../config/database.js';
import { createApp } from '../app.js';
import { encryptToken, decryptToken } from '../utils/crypto.js';
import { googleOAuthService } from '../services/google-oauth.service.js';
import { gmailProvider } from '../providers/email/gmail.provider.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { GMAIL_STATE_COOKIE_NAME } from '../middleware/session.js';

const ORG_ID = 'org_gmail_multi';
const USER_ID = 'usr_gmail_multi';

describe('Multiple Gmail Mailboxes Per Organization', () => {
  let app: any;

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
    await EmailAccount.deleteMany({ organizationId: ORG_ID });
  });

  afterAll(async () => {
    await EmailAccount.deleteMany({ organizationId: ORG_ID });
  });

  it('requests select_account + consent so a different mailbox can be authorized', () => {
    const captured: Record<string, any> = {};
    const clientSpy = vi
      .spyOn(googleOAuthService as any, 'getGmailClient')
      .mockReturnValueOnce({
        generateAuthUrl: (opts: Record<string, any>) => {
          Object.assign(captured, opts);
          return 'https://accounts.google.com/o/oauth2/v2/auth?mock=1';
        },
      });

    const url = googleOAuthService.getGmailConnectUrl('state-xyz');

    expect(url).toContain('mock=1');
    expect(captured.prompt).toBe('select_account consent');
    expect(captured.access_type).toBe('offline');
    expect(captured.state).toBe('state-xyz');

    clientSpy.mockRestore();
  });

  it('connects a second, different Gmail mailbox for the same org without disturbing the first', async () => {
    await EmailAccount.create({
      organizationId: ORG_ID,
      userId: USER_ID,
      emailAddress: 'first.mailbox@swaniki.dev',
      displayName: 'First Mailbox',
      provider: 'gmail',
      status: 'connected',
      encryptedAccessToken: encryptToken('first_access'),
      encryptedRefreshToken: encryptToken('first_refresh'),
      isPaused: false,
    });

    const state = googleOAuthService.generateSecureState({
      organizationId: ORG_ID,
      userId: USER_ID,
      returnTo: '/email',
    });

    vi.spyOn(googleOAuthService, 'handleGmailCallback').mockResolvedValueOnce({
      tokens: {
        access_token: 'second_access',
        refresh_token: 'second_refresh',
        expiry_date: Date.now() + 3600000,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
      },
      emailAddress: 'second.mailbox@swaniki.dev',
      displayName: 'Second Mailbox',
      googleSub: 'google_sub_second_multi',
      historyId: '2001',
    });
    vi.spyOn(gmailProvider, 'syncThreadsToDb').mockResolvedValueOnce(3);

    const res = await request(app)
      .get('/api/v1/integrations/google/gmail/callback')
      .set('Cookie', [`${GMAIL_STATE_COOKIE_NAME}=${state}`])
      .query({ code: 'second_mailbox_code', state });

    expect(res.status).toBe(302);
    expect(res.header.location).toContain('gmail_connected=true');
    expect(decodeURIComponent(res.header.location)).toContain('email=second.mailbox@swaniki.dev');

    const accounts = await EmailAccount.find({ organizationId: ORG_ID });
    expect(accounts).toHaveLength(2);

    const first = accounts.find((a) => a.emailAddress === 'first.mailbox@swaniki.dev')!;
    const second = accounts.find((a) => a.emailAddress === 'second.mailbox@swaniki.dev')!;

    expect(decryptToken(first.encryptedAccessToken!)).toBe('first_access');
    expect(decryptToken(second.encryptedAccessToken!)).toBe('second_access');
    expect(decryptToken(second.encryptedRefreshToken!)).toBe('second_refresh');
    expect(second.status).toBe('connected');
    expect(second.userId).toBe(USER_ID);
  });

  it('reconnecting an already-connected mailbox updates tokens without creating a duplicate record', async () => {
    await EmailAccount.create({
      organizationId: ORG_ID,
      userId: USER_ID,
      emailAddress: 'reconnect.me@swaniki.dev',
      displayName: 'Reconnect Me',
      provider: 'gmail',
      status: 'error',
      encryptedAccessToken: encryptToken('old_access'),
      encryptedRefreshToken: encryptToken('old_refresh'),
      isPaused: true,
      pausedReason: 'invalid_grant',
    });

    const state = googleOAuthService.generateSecureState({
      organizationId: ORG_ID,
      userId: USER_ID,
      returnTo: '/email',
    });

    vi.spyOn(googleOAuthService, 'handleGmailCallback').mockResolvedValueOnce({
      tokens: {
        access_token: 'new_access',
        refresh_token: 'new_refresh',
        expiry_date: Date.now() + 3600000,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
      },
      emailAddress: 'reconnect.me@swaniki.dev',
      displayName: 'Reconnect Me',
    });
    vi.spyOn(gmailProvider, 'syncThreadsToDb').mockResolvedValueOnce(0);

    const res = await request(app)
      .get('/api/v1/integrations/google/gmail/callback')
      .set('Cookie', [`${GMAIL_STATE_COOKIE_NAME}=${state}`])
      .query({ code: 'reconnect_code', state });

    expect(res.status).toBe(302);
    expect(res.header.location).toContain('gmail_connected=true');

    const accounts = await EmailAccount.find({
      organizationId: ORG_ID,
      emailAddress: 'reconnect.me@swaniki.dev',
    });
    expect(accounts).toHaveLength(1);
    expect(decryptToken(accounts[0].encryptedAccessToken!)).toBe('new_access');
    expect(decryptToken(accounts[0].encryptedRefreshToken!)).toBe('new_refresh');
    expect(accounts[0].status).toBe('connected');
    expect(accounts[0].isPaused).toBe(false);
  });

  it('redirects Gmail OAuth failures back to the originating page with a friendly message', async () => {
    const state = googleOAuthService.generateSecureState({
      organizationId: ORG_ID,
      userId: USER_ID,
      returnTo: '/email',
    });

    const res = await request(app)
      .get('/api/v1/integrations/google/gmail/callback')
      .query({ error: 'access_denied', state });

    expect(res.status).toBe(302);
    expect(res.header.location).toContain('/email?error=');
    expect(decodeURIComponent(res.header.location)).toContain('cancelled');
  });

  it('falls back to /integrations on OAuth failure when the state is missing or invalid', async () => {
    const res = await request(app)
      .get('/api/v1/integrations/google/gmail/callback')
      .query({ error: 'access_denied' });

    expect(res.status).toBe(302);
    expect(res.header.location).toContain('/integrations?error=');
  });

  it('sanitizes a protocol-relative returnTo to prevent open redirects', async () => {
    const state = googleOAuthService.generateSecureState({
      organizationId: ORG_ID,
      userId: USER_ID,
      returnTo: '//evil.com',
    });

    vi.spyOn(googleOAuthService, 'handleGmailCallback').mockResolvedValueOnce({
      tokens: {
        access_token: 'evil_access',
        refresh_token: 'evil_refresh',
        expiry_date: Date.now() + 3600000,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
      },
      emailAddress: 'open.redirect@swaniki.dev',
      displayName: 'Open Redirect Guard',
    });
    vi.spyOn(gmailProvider, 'syncThreadsToDb').mockResolvedValueOnce(0);

    const res = await request(app)
      .get('/api/v1/integrations/google/gmail/callback')
      .set('Cookie', [`${GMAIL_STATE_COOKIE_NAME}=${state}`])
      .query({ code: 'open_redirect_code', state });

    expect(res.status).toBe(302);
    expect(res.header.location.startsWith('http://localhost:5173/email')).toBe(true);
    expect(res.header.location).not.toContain('evil.com');
  });
});

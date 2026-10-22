import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { createApp } from '../app.js';
import { encryptToken } from '../utils/crypto.js';
import { googleOAuthService } from '../services/google-oauth.service.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailThread } from '../models/EmailThread.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { FollowUpTask } from '../models/FollowUpTask.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { User } from '../models/User.js';
import {
  SESSION_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  GMAIL_STATE_COOKIE_NAME,
  signSessionToken,
  clearRevokedSessions,
} from '../middleware/session.js';

const ORG = 'org_logout_cleanup_test';
const OTHER_ORG = 'org_logout_cleanup_other_org';
const OWNER_EMAIL = 'cleanup-owner@swaniki.test';
const OTHER_EMAIL = 'cleanup-other@swaniki.test';

let USER_ID = '';
let OTHER_USER_ID = '';

function makeSession(overrides: Partial<{ userId: string; organizationId: string; role: string; sessionId: string }> = {}) {
  const sessionId = overrides.sessionId || `sess_${Math.random().toString(36).slice(2)}`;
  const payload = {
    userId: overrides.userId || USER_ID,
    email: OWNER_EMAIL,
    organizationId: overrides.organizationId || ORG,
    role: (overrides.role || 'owner') as any,
    sessionId,
  };
  const token = signSessionToken(payload);
  return { token, sessionId, cookie: [`${SESSION_COOKIE_NAME}=${token}`] };
}

async function seedMailbox(options: {
  organizationId: string;
  userId?: string;
  emailAddress: string;
  provider?: 'gmail' | 'mock';
  withThreads?: boolean;
}) {
  const { organizationId, userId, emailAddress, provider = 'gmail', withThreads = true } = options;

  await EmailAccount.create({
    organizationId,
    userId,
    emailAddress,
    displayName: `Mailbox ${emailAddress}`,
    provider,
    status: 'connected',
    encryptedAccessToken: encryptToken('access_token_x'),
    encryptedRefreshToken: encryptToken('refresh_token_x'),
    isPaused: false,
  });

  if (withThreads) {
    await EmailThread.create({
      organizationId,
      mailboxEmail: emailAddress,
      threadId: `thread_${emailAddress}`,
      subject: 'Hello from test',
      messages: [
        {
          id: `m1_${emailAddress}`,
          from: { name: 'A', email: emailAddress },
          to: [{ name: 'B', email: 'prospect@example.com' }],
          subject: 'Hello from test',
          bodyText: 'first body',
          snippet: 'first',
        },
        {
          id: `m2_${emailAddress}`,
          from: { name: 'B', email: 'prospect@example.com' },
          to: [{ name: 'A', email: emailAddress }],
          subject: 'Re: Hello from test',
          bodyText: 'second body',
          snippet: 'second',
        },
      ],
    });

    await EmailSendAttempt.create({
      organizationId,
      mailboxId: emailAddress,
      draftId: new mongoose.Types.ObjectId(),
      actorId: userId || USER_ID,
      idempotencyKey: `idem_${emailAddress}`,
      recipientEmail: 'prospect@example.com',
    });

    await FollowUpTask.create({
      organizationId,
      threadId: `thread_${emailAddress}`,
      contactEmail: 'prospect@example.com',
      dueDate: new Date(Date.now() + 86400000),
      notes: 'follow up',
    });
  }
}

async function cleanupTestData() {
  const orgs = [ORG, OTHER_ORG];
  await Promise.all([
    EmailAccount.deleteMany({ organizationId: { $in: orgs } }),
    EmailThread.deleteMany({ organizationId: { $in: orgs } }),
    EmailSendAttempt.deleteMany({ organizationId: { $in: orgs } }),
    FollowUpTask.deleteMany({ organizationId: { $in: orgs } }),
    EmailDraft.deleteMany({ organizationId: { $in: orgs } }),
    User.deleteMany({ email: { $in: [OWNER_EMAIL, OTHER_EMAIL] } }),
  ]);
}

describe('Sign-Out, Gmail Disconnect & Mail Data Cleanup', () => {
  let app: any;

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
  });

  beforeEach(async () => {
    clearRevokedSessions();
    await cleanupTestData();

    const owner = await User.create({
      email: OWNER_EMAIL,
      fullName: 'Cleanup Owner',
      defaultOrgId: ORG,
      organizations: [{ organizationId: ORG, role: 'owner' }],
    });
    const other = await User.create({
      email: OTHER_EMAIL,
      fullName: 'Cleanup Colleague',
      organizations: [{ organizationId: ORG, role: 'sales_rep' }],
    });
    USER_ID = owner._id.toString();
    OTHER_USER_ID = other._id.toString();
  });

  describe('Plain sign-out (mode "session")', () => {
    it('clears all auth cookies AND revokes the session server-side', async () => {
      const { token, cookie } = makeSession();

      const meBefore = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
      expect(meBefore.status).toBe(200);
      expect(meBefore.body.data.user.email).toBe(OWNER_EMAIL);

      const res = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const cookies = res.header['set-cookie'] || [];
      expect(cookies.find((c: string) => c.includes(`${SESSION_COOKIE_NAME}=;`))).toBeDefined();
      expect(cookies.find((c: string) => c.includes(`${OAUTH_STATE_COOKIE_NAME}=;`))).toBeDefined();
      expect(cookies.find((c: string) => c.includes(`${GMAIL_STATE_COOKIE_NAME}=;`))).toBeDefined();

      const meAfter = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(meAfter.status).toBe(401);
    });

    it('is idempotent when called without any session', async () => {
      const res = await request(app).post('/api/v1/auth/logout');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('preserves connected Gmail mailboxes, threads and CRM data', async () => {
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'keep.me@swaniki.test' });
      await EmailDraft.create({
        organizationId: ORG,
        recipientEmail: 'prospect@example.com',
        subject: 'Kept draft',
        bodyText: 'kept',
      });

      const { cookie } = makeSession();
      const res = await request(app).post('/api/v1/auth/logout').send({ mode: 'session' }).set('Cookie', cookie);
      expect(res.status).toBe(200);

      expect(await EmailAccount.countDocuments({ organizationId: ORG })).toBe(1);
      expect(await EmailThread.countDocuments({ organizationId: ORG })).toBe(1);
      expect(await EmailDraft.countDocuments({ organizationId: ORG })).toBe(1);
    });
  });

  describe('Sign out and clear mail data (mode "clear-mail-data")', () => {
    it('requires an authenticated session', async () => {
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'protected@swaniki.test' });

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('x-organization-id', ORG)
        .set('x-user-id', USER_ID)
        .send({ mode: 'clear-mail-data' });

      expect(res.status).toBe(401);
      expect(await EmailAccount.countDocuments({ organizationId: ORG })).toBe(1);
    });

    it('disconnects all owned Gmail mailboxes and deletes synced mail data', async () => {
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'alpha@swaniki.test' });
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'beta@swaniki.test' });

      const revokeSpy = vi
        .spyOn(googleOAuthService, 'createAuthorizedClient')
        .mockReturnValue({ revokeToken: vi.fn().mockResolvedValue({}) } as any);

      const { cookie, token } = makeSession();
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .send({ mode: 'clear-mail-data' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mailData.gmailAccountsRemoved).toBe(2);
      expect(res.body.data.mailData.threadsDeleted).toBe(2);
      expect(res.body.data.mailData.messagesDeleted).toBe(4);
      expect(res.body.data.mailData.sendAttemptsDeleted).toBe(2);
      expect(res.body.data.mailData.followUpsDeleted).toBe(2);

      expect(await EmailAccount.countDocuments({ organizationId: ORG })).toBe(0);
      expect(await EmailThread.countDocuments({ organizationId: ORG })).toBe(0);
      expect(await EmailSendAttempt.countDocuments({ organizationId: ORG })).toBe(0);
      expect(await FollowUpTask.countDocuments({ organizationId: ORG })).toBe(0);

      const meAfter = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(meAfter.status).toBe(401);

      revokeSpy.mockRestore();
    });

    it("never deletes another user's mailbox, another org's data, or CRM records", async () => {
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'mine@swaniki.test' });
      await seedMailbox({ organizationId: ORG, userId: OTHER_USER_ID, emailAddress: 'colleague@swaniki.test' });
      await seedMailbox({ organizationId: OTHER_ORG, userId: OTHER_USER_ID, emailAddress: 'otherorg@swaniki.test' });

      await EmailDraft.create({
        organizationId: ORG,
        recipientEmail: 'prospect@example.com',
        subject: 'Kept draft',
        bodyText: 'kept',
      });

      const revokeSpy = vi
        .spyOn(googleOAuthService, 'createAuthorizedClient')
        .mockReturnValue({ revokeToken: vi.fn().mockResolvedValue({}) } as any);

      const { cookie } = makeSession();
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .send({ mode: 'clear-mail-data' });

      expect(res.status).toBe(200);

      expect(await EmailAccount.countDocuments({ organizationId: ORG, emailAddress: 'mine@swaniki.test' })).toBe(0);
      expect(await EmailAccount.countDocuments({ organizationId: ORG, emailAddress: 'colleague@swaniki.test' })).toBe(1);
      expect(await EmailAccount.countDocuments({ organizationId: OTHER_ORG })).toBe(1);
      expect(await EmailThread.countDocuments({ organizationId: ORG, mailboxEmail: 'colleague@swaniki.test' })).toBe(1);
      expect(await EmailThread.countDocuments({ organizationId: OTHER_ORG })).toBe(1);
      expect(await EmailDraft.countDocuments({ organizationId: ORG })).toBe(1);

      revokeSpy.mockRestore();
    });

    it('is idempotent: repeating the action reports zero deletions', async () => {
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'once@swaniki.test' });

      const revokeSpy = vi
        .spyOn(googleOAuthService, 'createAuthorizedClient')
        .mockReturnValue({ revokeToken: vi.fn().mockResolvedValue({}) } as any);

      const first = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', makeSession().cookie)
        .send({ mode: 'clear-mail-data' });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', makeSession().cookie)
        .send({ mode: 'clear-mail-data' });
      expect(second.status).toBe(200);
      expect(second.body.data.mailData.gmailAccountsRemoved).toBe(0);
      expect(second.body.data.mailData.threadsDeleted).toBe(0);

      revokeSpy.mockRestore();
    });

    it('still purges local data and reports a warning when Google revocation fails', async () => {
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'revokefail@swaniki.test' });

      const revokeSpy = vi
        .spyOn(googleOAuthService, 'createAuthorizedClient')
        .mockReturnValue({ revokeToken: vi.fn().mockRejectedValue(new Error('Google revocation network timeout')) } as any);

      const { cookie } = makeSession();
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .send({ mode: 'clear-mail-data' });

      expect(res.status).toBe(200);
      expect(res.body.data.mailData.gmailAccountsRemoved).toBe(1);
      expect(res.body.data.mailData.revocationWarnings.length).toBe(1);
      expect(res.body.data.mailData.revocationWarnings[0].warning).toContain('Google revocation network timeout');
      expect(await EmailAccount.countDocuments({ organizationId: ORG })).toBe(0);
      expect(await EmailThread.countDocuments({ organizationId: ORG })).toBe(0);

      revokeSpy.mockRestore();
    });
  });

  describe('Per-mailbox Gmail disconnect', () => {
    it('removes only the targeted mailbox connection and its synced data', async () => {
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'target@swaniki.test' });
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'keep@swaniki.test' });

      const revokeSpy = vi
        .spyOn(googleOAuthService, 'createAuthorizedClient')
        .mockReturnValue({ revokeToken: vi.fn().mockResolvedValue({}) } as any);

      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/target@swaniki.test/disconnect')
        .set('x-organization-id', ORG)
        .set('x-user-id', USER_ID);

      expect(res.status).toBe(200);
      expect(res.body.data.accountRemoved).toBe(true);
      expect(res.body.data.threadsDeleted).toBe(1);

      expect(await EmailAccount.countDocuments({ organizationId: ORG, emailAddress: 'target@swaniki.test' })).toBe(0);
      expect(await EmailThread.countDocuments({ organizationId: ORG, mailboxEmail: 'target@swaniki.test' })).toBe(0);
      expect(await EmailAccount.countDocuments({ organizationId: ORG, emailAddress: 'keep@swaniki.test' })).toBe(1);
      expect(await EmailThread.countDocuments({ organizationId: ORG, mailboxEmail: 'keep@swaniki.test' })).toBe(1);

      revokeSpy.mockRestore();
    });

    it("forbids a non-owner/non-admin from disconnecting another user's mailbox", async () => {
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'guarded@swaniki.test' });

      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/guarded@swaniki.test/disconnect')
        .set('x-organization-id', ORG)
        .set('x-user-id', OTHER_USER_ID)
        .set('x-user-role', 'sales_rep');

      expect(res.status).toBe(403);
      expect(await EmailAccount.countDocuments({ organizationId: ORG, emailAddress: 'guarded@swaniki.test' })).toBe(1);
    });

    it('does not leak tokens in the disconnect response', async () => {
      await seedMailbox({ organizationId: ORG, userId: USER_ID, emailAddress: 'secret@swaniki.test' });

      const revokeSpy = vi
        .spyOn(googleOAuthService, 'createAuthorizedClient')
        .mockReturnValue({ revokeToken: vi.fn().mockResolvedValue({}) } as any);

      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/secret@swaniki.test/disconnect')
        .set('x-organization-id', ORG)
        .set('x-user-id', USER_ID);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('refresh_token_x');
      expect(serialized).not.toContain('access_token_x');
      expect(serialized.toLowerCase()).not.toContain('encrypted');
      expect(serialized.toLowerCase()).not.toContain('bearer');

      revokeSpy.mockRestore();
    });
  });
});

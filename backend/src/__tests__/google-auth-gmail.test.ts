import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { google } from 'googleapis';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { env } from '../config/env.js';
import { encryptToken, decryptToken } from '../utils/crypto.js';
import { googleOAuthService } from '../services/google-oauth.service.js';
import { gmailProvider, isInvalidGrantError } from '../providers/email/gmail.provider.js';
import { User } from '../models/User.js';
import { Organization } from '../models/Organization.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailThread } from '../models/EmailThread.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { GmailQuotaLedger } from '../models/GmailQuotaLedger.js';
import { GmailApiLease } from '../models/GmailApiLease.js';
import { SESSION_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, GMAIL_STATE_COOKIE_NAME, verifySessionToken, signSessionToken } from '../middleware/session.js';

describe('Google Authentication & Decoupled Gmail Integration Suite', () => {
  let app: any;

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
    await EmailAccount.deleteMany({ organizationId: { $in: ['org_test_gmail_flow', 'org_send_safety_gmail', 'org_gmail_reauth_suite'] } });
    await EmailDraft.deleteMany({ organizationId: { $in: ['org_test_gmail_flow', 'org_send_safety_gmail', 'org_gmail_reauth_suite'] } });
    await EmailThread.deleteMany({ organizationId: { $in: ['org_test_gmail_flow', 'org_send_safety_gmail', 'org_gmail_reauth_suite'] } });
    await EmailSendAttempt.deleteMany({ organizationId: { $in: ['org_test_gmail_flow', 'org_send_safety_gmail', 'org_gmail_reauth_suite'] } });
    const testEmails = [
      'founder@acmeinnovations.example.com',
      'firsttime.user@swaniki.dev',
      'returning@swaniki.dev',
      'invited_rep@swaniki.dev',
      'blanknameuser@swaniki.dev',
      'legacy_active@swaniki.dev',
      'disabled_sub@swaniki.dev',
      'disabled_email@swaniki.dev',
      'unverified_target@swaniki.dev',
      'conflict@swaniki.dev',
      'reauth_user_501@swaniki.dev',
      'avatar_backfill@swaniki.dev',
      'avatar_none@swaniki.dev',
      'avatar_preserved@swaniki.dev',
      'avatar_updated@swaniki.dev',
      'avatar_invalid@swaniki.dev',
      'avatar_me@swaniki.dev',
    ];
    await User.deleteMany({
      $or: [
        { googleSub: { $in: [
          'google_sub_user_999',
          'google_sub_mailbox_123',
          'google_sub_first_time_001',
          'google_sub_ret_1',
          'google_sub_inv_2',
          'google_sub_blank_name_1',
          'google_sub_legacy_act',
          'google_sub_dis_1',
          'google_sub_dis_new_try',
          'google_sub_unverified_attacker',
          'google_original_sub',
          'google_intruder_sub',
          'google_sub_reauth_501',
          'google_sub_reconnected_999',
          'google_sub_avatar_backfill',
          'google_sub_avatar_none',
          'google_sub_avatar_preserved',
          'google_sub_avatar_updated',
          'google_sub_avatar_invalid',
          'google_sub_avatar_me',
        ] } },
        { email: { $in: testEmails } },
      ],
    });
    await Organization.deleteMany({
      slug: { $in: ['existing-growth-org-ret', 'acme-sales-org-inv', 'legacy-status-org', 'disabled-org-1', 'disabled-org-2', 'target-org-unverified', 'security-org-dup', 'org_gmail_reauth_suite', 'org-gmail-reauth-suite', 'avatar-me-org'] },
    });
  });

  afterAll(async () => {
    const testEmails = [
      'founder@acmeinnovations.example.com',
      'firsttime.user@swaniki.dev',
      'returning@swaniki.dev',
      'invited_rep@swaniki.dev',
      'blanknameuser@swaniki.dev',
      'legacy_active@swaniki.dev',
      'disabled_sub@swaniki.dev',
      'disabled_email@swaniki.dev',
      'unverified_target@swaniki.dev',
      'conflict@swaniki.dev',
      'reauth_user_501@swaniki.dev',
      'avatar_backfill@swaniki.dev',
      'avatar_none@swaniki.dev',
      'avatar_preserved@swaniki.dev',
      'avatar_updated@swaniki.dev',
      'avatar_invalid@swaniki.dev',
      'avatar_me@swaniki.dev',
    ];
    await User.deleteMany({
      $or: [
        { googleSub: { $in: [
          'google_sub_user_999',
          'google_sub_mailbox_123',
          'google_sub_first_time_001',
          'google_sub_ret_1',
          'google_sub_inv_2',
          'google_sub_blank_name_1',
          'google_sub_legacy_act',
          'google_sub_dis_1',
          'google_sub_dis_new_try',
          'google_sub_unverified_attacker',
          'google_original_sub',
          'google_intruder_sub',
          'google_sub_reauth_501',
          'google_sub_reconnected_999',
          'google_sub_avatar_backfill',
          'google_sub_avatar_none',
          'google_sub_avatar_preserved',
          'google_sub_avatar_updated',
          'google_sub_avatar_invalid',
          'google_sub_avatar_me',
        ] } },
        { email: { $in: testEmails } },
      ],
    });
    await Organization.deleteMany({
      slug: { $in: ['existing-growth-org-ret', 'acme-sales-org-inv', 'legacy-status-org', 'disabled-org-1', 'disabled-org-2', 'target-org-unverified', 'security-org-dup', 'org_gmail_reauth_suite', 'org-gmail-reauth-suite', 'avatar-me-org'] },
    });
    await disconnectDatabase();
  });

  describe('1. AES-256-GCM Token Encryption Security', () => {
    it('should encrypt and decrypt tokens accurately', () => {
      const sensitiveToken = 'ya29.a0AfH6SMD_secret_google_oauth_token_1234567890';
      const encrypted = encryptToken(sensitiveToken);

      expect(encrypted).not.toBe(sensitiveToken);
      expect(encrypted.split(':').length).toBe(3); // iv:ciphertext:tag

      const decrypted = decryptToken(encrypted);
      expect(decrypted).toBe(sensitiveToken);
    });

    it('should generate distinct ciphertexts for identical inputs due to random IVs', () => {
      const plaintext = 'refresh_token_xyz_987654321';
      const enc1 = encryptToken(plaintext);
      const enc2 = encryptToken(plaintext);

      expect(enc1).not.toBe(enc2);
      expect(decryptToken(enc1)).toBe(plaintext);
      expect(decryptToken(enc2)).toBe(plaintext);
    });

    it('should fail securely when decrypting tampered ciphertext', () => {
      const encrypted = encryptToken('safe_token');
      const parts = encrypted.split(':');
      const tampered = `${parts[0]}:corrupted_ciphertext:${parts[2]}`;

      expect(() => decryptToken(tampered)).toThrow();
    });
  });

  describe('2. Google Sign-In Flow & Session Management', () => {
    it('should reject callback when OAuth state parameter is missing or mismatched (CSRF protection)', async () => {
      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .query({ code: 'fake_code_123', state: 'unmatched_state' });

      // Expect redirect to login with error
      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/login?error=');
    });

    it('should exchange code, verify OpenID Connect token, provision user & org, and set HttpOnly session cookie', async () => {
      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });

      // Mock googleOAuthService.handleSignInCallback
      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_user_999',
        email: 'founder@acmeinnovations.example.com',
        name: 'Alex Rivera',
        picture: 'https://example.com/avatar.jpg',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'valid_google_code_123', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/dashboard');

      // Check that HttpOnly cookie was set
      const cookies = res.header['set-cookie'] || [];
      const sessionCookie = cookies.find((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toContain('HttpOnly');

      // Verify user and organization persisted in MongoDB
      const user = await User.findOne({ googleSub: 'google_sub_user_999' });
      expect(user).not.toBeNull();
      expect(user?.email).toBe('founder@acmeinnovations.example.com');
      expect(user?.fullName).toBe('Alex Rivera');
      expect(user?.avatarUrl).toBe('https://example.com/avatar.jpg');
      expect(user?.organizations.length).toBeGreaterThan(0);
      expect(user?.organizations[0].role).toBe('owner');
    });

    it('GET /api/v1/auth/me should identify authenticated user via session cookie', async () => {
      // Use dev login to get a valid session
      const loginRes = await request(app).post('/api/v1/auth/dev-login');
      expect(loginRes.status).toBe(200);

      const cookieHeader = loginRes.header['set-cookie'];

      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', cookieHeader);

      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.data.user.email).toBe('developer@swaniki.dev');
      expect(meRes.body.data.userRole).toBe('owner');
    });

    it('POST /api/v1/auth/logout should clear session cookie', async () => {
      const res = await request(app).post('/api/v1/auth/logout');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const cookies = res.header['set-cookie'] || [];
      const cleared = cookies.find((c: string) => c.includes(`${SESSION_COOKIE_NAME}=;`));
      expect(cleared).toBeDefined();
    });

    it('GET /api/v1/auth/me should return data: null when unauthenticated without session cookie or explicit headers', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeNull();
    });

    it('GET /api/v1/auth/me should NOT 400 on a malformed x-user-id header (the reported regression)', async () => {
      // Mimics the browser sending a legacy/non-ObjectId id from localStorage.
      // Previously User.findById('usr_dev_master_001') threw a CastError -> 400.
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('x-user-id', 'usr_dev_master_001')
        .set('x-organization-id', 'org_dev_swaniki_001')
        .set('x-user-role', 'owner');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeNull();
    });

    it('GET /api/v1/auth/me should NOT 400 on an arbitrary non-ObjectId identity header', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('x-user-id', 'stale-session-id')
        .set('x-organization-id', 'org_dev_swaniki_001');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeNull();
    });

    it('GET /api/v1/auth/me should return 401 for a malformed/expired session cookie', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=not.a.valid.jwt`]);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('GET /api/v1/auth/me should return 401 for a malformed Authorization bearer token', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not.a.valid.jwt');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('GET /api/v1/auth/me should resolve a valid ObjectId that does not exist to data: null (no 400)', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('x-user-id', '64b7f9c2e1a2b3c4d5e6f7a8')
        .set('x-organization-id', 'org_dev_swaniki_001');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it('GET /api/v1/auth/me should still resolve a valid session cookie to the authenticated user', async () => {
      const loginRes = await request(app).post('/api/v1/auth/dev-login');
      expect(loginRes.status).toBe(200);

      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', loginRes.header['set-cookie']);

      expect(meRes.status).toBe(200);
      expect(meRes.body.data.user.email).toBe('developer@swaniki.dev');
      expect(meRes.body.data.organizationId).toBeTruthy();
    });
  });

  describe('2b. Google OAuth User Validation, Role Security & Error Recovery Suite', () => {
    it('First-time login: should supply valid fullName, lowercase email, googleSub, status: "active", and role "owner" on newly created org', async () => {
      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });

      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_first_time_001',
        email: 'FirstTime.User@Swaniki.Dev',
        name: '  First-Time Founder  ',
        picture: 'https://example.com/first.png',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'first_time_code_1', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/dashboard');

      const cookies = res.header['set-cookie'] || [];
      const sessionCookie = cookies.find((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      expect(sessionCookie).toBeDefined();

      const user = await User.findOne({ googleSub: 'google_sub_first_time_001' });
      expect(user).not.toBeNull();
      expect(user?.email).toBe('firsttime.user@swaniki.dev');
      expect(user?.fullName).toBe('First-Time Founder');
      expect(user?.status).toBe('active');
      expect(user?.organizations.length).toBe(1);
      expect(user?.organizations[0].role).toBe('owner');
      expect(user?.defaultOrgId).toBe(user?.organizations[0].organizationId);
    });

    it('Returning user by googleSub: should authenticate, preserve existing role and not create duplicate organizations', async () => {
      const existingOrg = await Organization.create({
        name: 'Existing Growth Org',
        slug: 'existing-growth-org-ret',
        createdBy: 'admin_creator',
      });

      const existingUser = await User.create({
        email: 'returning@swaniki.dev',
        fullName: 'Returning Senior Manager',
        googleSub: 'google_sub_ret_1',
        status: 'active',
        defaultOrgId: existingOrg._id.toString(),
        organizations: [{ organizationId: existingOrg._id.toString(), role: 'manager' }],
      });

      const orgCountBefore = await Organization.countDocuments();

      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });
      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_ret_1',
        email: 'returning@swaniki.dev',
        name: 'Returning Senior Manager',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'returning_code_1', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/dashboard');

      // Verify no extra organization was provisioned
      const orgCountAfter = await Organization.countDocuments();
      expect(orgCountAfter).toBe(orgCountBefore);

      // Verify user organizations and role are preserved (NOT overwritten to owner)
      const user = await User.findById(existingUser._id);
      expect(user?.organizations[0].role).toBe('manager');

      // Verify session cookie reflects the actual manager role
      const cookies = res.header['set-cookie'] || [];
      const sessionCookie = cookies.find((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      const token = sessionCookie.split(';')[0].split('=')[1];
      const payload = verifySessionToken(token);
      expect(payload?.role).toBe('manager');
    });

    it('Returning invited user by email: should link googleSub, transition status from "invited" to "active", and preserve assigned role without privilege escalation', async () => {
      const invitedOrg = await Organization.create({
        name: 'Acme Sales Org',
        slug: 'acme-sales-org-inv',
        createdBy: 'owner_123',
      });

      const invitedUser = await User.create({
        email: 'invited_rep@swaniki.dev',
        fullName: 'Invited Sales Rep',
        status: 'invited',
        defaultOrgId: invitedOrg._id.toString(),
        organizations: [{ organizationId: invitedOrg._id.toString(), role: 'sales_rep' }],
      });

      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });
      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_inv_2',
        email: 'invited_rep@swaniki.dev',
        name: 'Invited Sales Rep',
        picture: 'https://example.com/avatar_rep.png',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'invited_code_1', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/dashboard');

      const updatedUser = await User.findById(invitedUser._id);
      expect(updatedUser?.googleSub).toBe('google_sub_inv_2');
      expect(updatedUser?.status).toBe('active');
      expect(updatedUser?.organizations[0].role).toBe('sales_rep'); // Kept sales_rep, NOT escalated
      expect(updatedUser?.avatarUrl).toBe('https://example.com/avatar_rep.png');

      const cookies = res.header['set-cookie'] || [];
      const sessionCookie = cookies.find((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      const token = sessionCookie.split(';')[0].split('=')[1];
      const payload = verifySessionToken(token);
      expect(payload?.role).toBe('sales_rep');
    });

    it('Missing or whitespace name in Google profile: should fallback to email prefix and satisfy fullName requirement', async () => {
      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });

      // Profile with whitespace-only name
      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_blank_name_1',
        email: 'blanknameuser@swaniki.dev',
        name: '   ',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'blank_name_code', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/dashboard');

      const user = await User.findOne({ googleSub: 'google_sub_blank_name_1' });
      expect(user).not.toBeNull();
      expect(user?.fullName).toBe('blanknameuser');
      expect(user?.status).toBe('active');
    });

    it('Missing or invalid email from Google callback: should reject callback with error redirect', async () => {
      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });

      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_no_email',
        email: '',
        name: 'No Email User',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'no_email_code', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/login?error=');
    });

    it('Missing Google account identifier (sub): should reject callback with error redirect', async () => {
      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });

      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: '   ',
        email: 'nosub@swaniki.dev',
        name: 'No Sub User',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'no_sub_code', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/login?error=');
    });

    it('Invalid status handling: should reconcile uppercase status ("ACTIVE") to lowercase "active" without Mongoose validation failure', async () => {
      // Simulate existing user with legacy uppercase ACTIVE status stored directly
      const org = await Organization.create({
        name: 'Legacy Status Org',
        slug: 'legacy-status-org',
        createdBy: 'admin',
      });

      // Insert directly via MongoDB collection to simulate pre-existing unvalidated record
      await User.collection.insertOne({
        email: 'legacy_active@swaniki.dev',
        fullName: 'Legacy User',
        googleSub: 'google_sub_legacy_act',
        status: 'ACTIVE', // Uppercase value that violates schema
        organizations: [{ organizationId: org._id.toString(), role: 'owner' }],
        defaultOrgId: org._id.toString(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });
      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_legacy_act',
        email: 'legacy_active@swaniki.dev',
        name: 'Legacy User',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'legacy_act_code', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/dashboard');

      // Verify status was reconciled to lowercase 'active'
      const user = await User.findOne({ googleSub: 'google_sub_legacy_act' });
      expect(user?.status).toBe('active');
    });

    it('Disabled user by googleSub: should never allow login or reactivate user', async () => {
      const org = await Organization.create({
        name: 'Disabled Org',
        slug: 'disabled-org-1',
        createdBy: 'admin',
      });

      await User.create({
        email: 'disabled_sub@swaniki.dev',
        fullName: 'Disabled Employee',
        googleSub: 'google_sub_dis_1',
        status: 'disabled',
        organizations: [{ organizationId: org._id.toString(), role: 'viewer' }],
      });

      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });
      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_dis_1',
        email: 'disabled_sub@swaniki.dev',
        name: 'Disabled Employee',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'disabled_sub_code', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/login?error=');
      expect(decodeURIComponent(res.header.location)).toMatch(/disabled/i);

      // Verify user remains disabled in DB
      const user = await User.findOne({ googleSub: 'google_sub_dis_1' });
      expect(user?.status).toBe('disabled');
    });

    it('Disabled user by email match: should never link or reactivate user through Google OAuth', async () => {
      const org = await Organization.create({
        name: 'Disabled Org 2',
        slug: 'disabled-org-2',
        createdBy: 'admin',
      });

      await User.create({
        email: 'disabled_email@swaniki.dev',
        fullName: 'Disabled By Email',
        status: 'disabled',
        organizations: [{ organizationId: org._id.toString(), role: 'viewer' }],
      });

      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });
      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_dis_new_try',
        email: 'disabled_email@swaniki.dev',
        name: 'Disabled By Email',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'disabled_email_code', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/login?error=');
      expect(decodeURIComponent(res.header.location)).toMatch(/disabled/i);

      // Verify user was NOT linked and remains disabled
      const user = await User.findOne({ email: 'disabled_email@swaniki.dev' });
      expect(user?.status).toBe('disabled');
      expect(user?.googleSub).toBeUndefined();
    });

    it('Unverified email: should refuse to link account based on unverified email', async () => {
      const org = await Organization.create({
        name: 'Target Org',
        slug: 'target-org-unverified',
        createdBy: 'admin',
      });

      await User.create({
        email: 'unverified_target@swaniki.dev',
        fullName: 'Target Victim',
        status: 'active',
        organizations: [{ organizationId: org._id.toString(), role: 'sales_rep' }],
      });

      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });
      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_sub_unverified_attacker',
        email: 'unverified_target@swaniki.dev',
        name: 'Attacker Impersonator',
        emailVerified: false, // NOT VERIFIED
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'unverified_code', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/login?error=');
      expect(decodeURIComponent(res.header.location)).toMatch(/not verified/i);

      // Verify target user was NOT compromised or linked
      const victim = await User.findOne({ email: 'unverified_target@swaniki.dev' });
      expect(victim?.googleSub).toBeUndefined();
    });

    it('Duplicate-email handling: should prevent linking when email is already linked to another Google account', async () => {
      const org = await Organization.create({
        name: 'Security Org',
        slug: 'security-org-dup',
        createdBy: 'admin',
      });

      await User.create({
        email: 'conflict@swaniki.dev',
        fullName: 'Original Google User',
        googleSub: 'google_original_sub',
        status: 'active',
        organizations: [{ organizationId: org._id.toString(), role: 'manager' }],
      });

      const state = googleOAuthService.generateSecureState({ returnTo: '/dashboard' });
      vi.spyOn(googleOAuthService, 'handleSignInCallback').mockResolvedValueOnce({
        sub: 'google_intruder_sub',
        email: 'conflict@swaniki.dev',
        name: 'Conflicting Account',
        emailVerified: true,
      });

      const res = await request(app)
        .get('/api/v1/auth/google/callback')
        .set('Cookie', [`${OAUTH_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'conflict_code', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/login?error=');
      expect(decodeURIComponent(res.header.location)).toMatch(/already (linked|associated)/i);

      // Verify original account was not overwritten
      const user = await User.findOne({ email: 'conflict@swaniki.dev' });
      expect(user?.googleSub).toBe('google_original_sub');
    });
  });

  describe('3. Decoupled Gmail Integration Flow', () => {
    const testOrgId = 'org_test_gmail_flow';
    const testUserId = 'usr_test_gmail_flow';

    it('should reject Gmail callback on state mismatch', async () => {
      const res = await request(app)
        .get('/api/v1/integrations/google/gmail/callback')
        .query({ code: 'fake_code', state: 'bad_state' });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/integrations?error=');
    });

    it('should complete Gmail connection: encrypt tokens, store EmailAccount, and set connected status', async () => {
      const state = googleOAuthService.generateSecureState({
        organizationId: testOrgId,
        userId: testUserId,
        returnTo: '/email',
      });

      // Mock googleOAuthService.handleGmailCallback
      vi.spyOn(googleOAuthService, 'handleGmailCallback').mockResolvedValueOnce({
        tokens: {
          access_token: 'live_access_token_123',
          refresh_token: 'live_refresh_token_456',
          expiry_date: Date.now() + 3600000,
          scope: 'https://www.googleapis.com/auth/gmail.modify',
        },
        emailAddress: 'outreach@swanikicorp.com',
        displayName: 'Swaniki Outreach Team',
        googleSub: 'google_sub_mailbox_123',
        historyId: '100234',
      });

      // Mock syncThreadsToDb to avoid external calls during test
      vi.spyOn(gmailProvider, 'syncThreadsToDb').mockResolvedValueOnce(5);

      const res = await request(app)
        .get('/api/v1/integrations/google/gmail/callback')
        .set('Cookie', [`${GMAIL_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'valid_gmail_code_xyz', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('gmail_connected=true');

      // Verify encrypted storage in DB
      const account = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'outreach@swanikicorp.com',
      });

      expect(account).not.toBeNull();
      expect(account?.provider).toBe('gmail');
      expect(account?.status).toBe('connected');
      expect(account?.encryptedAccessToken).toBeDefined();
      expect(account?.encryptedRefreshToken).toBeDefined();
      // Tokens must NOT be saved in plaintext!
      expect(account?.encryptedAccessToken).not.toBe('live_access_token_123');
      expect(account?.encryptedRefreshToken).not.toBe('live_refresh_token_456');

      // Verify that decryption produces original tokens
      expect(decryptToken(account!.encryptedAccessToken!)).toBe('live_access_token_123');
      expect(decryptToken(account!.encryptedRefreshToken!)).toBe('live_refresh_token_456');
    });

    it('should safely disconnect Gmail mailbox, purge credentials and remove the connection record', async () => {
      const mockOAuthClient = {
        revokeToken: vi.fn().mockResolvedValue({}),
      };
      vi.spyOn(googleOAuthService, 'createAuthorizedClient').mockReturnValueOnce(mockOAuthClient as any);

      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/outreach@swanikicorp.com/disconnect')
        .set('x-organization-id', testOrgId)
        .set('x-user-id', testUserId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.googleRevoked).toBe(true);
      expect(res.body.data.accountRemoved).toBe(true);

      const account = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'outreach@swanikicorp.com',
      });

      expect(account).toBeNull();
    });

    it('should handle repeated disconnect on an already-removed mailbox idempotently', async () => {
      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/outreach@swanikicorp.com/disconnect')
        .set('x-organization-id', testOrgId)
        .set('x-user-id', testUserId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.alreadyDisconnected).toBe(true);
      expect(res.body.data.status).toBe('disconnected');
      expect(res.body.message).toContain('locally synced data');
    });

    it('should handle Google revocation failure gracefully without failing local disconnection', async () => {
      // Create another connected account
      await EmailAccount.create({
        organizationId: testOrgId,
        userId: testUserId,
        emailAddress: 'revokefail@swanikicorp.com',
        displayName: 'Revocation Fail Mailbox',
        provider: 'gmail',
        status: 'connected',
        encryptedAccessToken: encryptToken('access_token_fail'),
        encryptedRefreshToken: encryptToken('refresh_token_fail'),
        dailySendLimit: 50,
        sendsToday: 0,
        isPaused: false,
      });

      // Mock revokeToken to reject/fail
      const mockOAuthClient = {
        revokeToken: vi.fn().mockRejectedValue(new Error('Google revocation network timeout')),
      };
      vi.spyOn(googleOAuthService, 'createAuthorizedClient').mockReturnValueOnce(mockOAuthClient as any);

      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/revokefail@swanikicorp.com/disconnect')
        .set('x-organization-id', testOrgId)
        .set('x-user-id', testUserId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.googleRevoked).toBe(false);
      expect(res.body.data.revocationWarning).toContain('Google revocation network timeout');

      // Verify the connection record and credentials were removed despite the
      // external revocation failure.
      const account = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'revokefail@swanikicorp.com',
      });
      expect(account).toBeNull();
    });

    it('should forbid unauthorized non-owner non-admin user from disconnecting another user connection', async () => {
      // Create an account owned by testUserId
      await EmailAccount.create({
        organizationId: testOrgId,
        userId: testUserId,
        emailAddress: 'restricted@swanikicorp.com',
        displayName: 'Restricted Mailbox',
        provider: 'gmail',
        status: 'connected',
        encryptedAccessToken: encryptToken('access_token_res'),
        encryptedRefreshToken: encryptToken('refresh_token_res'),
      });

      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/restricted@swanikicorp.com/disconnect')
        .set('x-organization-id', testOrgId)
        .set('x-user-id', 'other_sales_rep_user')
        .set('x-user-role', 'sales_rep');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('4. Dispatch & Send Safety Pipeline Integration with Gmail Provider', () => {
    const testOrgId = 'org_send_safety_gmail';

    it('should route to GmailProvider and enforce strict approval and daily limit checks', async () => {
      // 1. Setup connected Gmail account
      await EmailAccount.create({
        organizationId: testOrgId,
        emailAddress: 'sales@realdeal.com',
        displayName: 'Sales Team',
        provider: 'gmail',
        status: 'connected',
        encryptedAccessToken: encryptToken('mock_access'),
        encryptedRefreshToken: encryptToken('mock_refresh'),
        dailySendLimit: 10,
        sendsToday: 0,
        isPaused: false,
      });

      // 2. Create unapproved draft
      const draft = await EmailDraft.create({
        organizationId: testOrgId,
        recipientEmail: 'client@prospect.example.com',
        recipientName: 'Sarah Jenkins',
        subject: 'Modernizing your logistics digital flow',
        bodyText: 'Hi Sarah, our benchmarks show significant speed improvements.',
        status: 'draft',
        generationMetadata: {
          confidenceScore: 92,
          serviceId: 'srv_1',
          groundingFactsUsed: ['Sub-second latency'],
        },
      });

      // 3. Attempt send while draft is still in unapproved status (must reject)
      const unapprovedRes = await request(app)
        .post('/api/v1/mailboxes/sales@realdeal.com/send')
        .set('x-organization-id', testOrgId)
        .send({
          draftId: draft._id.toString(),
          idempotencyKey: 'idemp_key_unapproved_1',
        });

      expect(unapprovedRes.status).toBe(400);
      expect(unapprovedRes.body.error.code).toBe('UNAPPROVED_DRAFT');

      // 4. Approve draft
      draft.status = 'approved';
      draft.humanApprovedBy = 'reviewer_1';
      await draft.save();

      // 5. Mock gmailProvider.sendMessage to simulate successful Gmail API dispatch
      const sendSpy = vi.spyOn(gmailProvider, 'sendMessage').mockResolvedValueOnce({
        messageId: 'gm_msg_abc_999',
        threadId: 'gm_th_xyz_111',
        isSimulated: false,
        acceptedAt: new Date().toISOString(),
      });

      const approvedRes = await request(app)
        .post('/api/v1/mailboxes/sales@realdeal.com/send')
        .set('x-organization-id', testOrgId)
        .send({
          draftId: draft._id.toString(),
          idempotencyKey: 'idemp_key_approved_1',
        });

      expect(approvedRes.status).toBe(200);
      expect(approvedRes.body.success).toBe(true);
      expect(approvedRes.body.data.status).toBe('accepted');
      expect(sendSpy).toHaveBeenCalledWith(
        'sales@realdeal.com',
        {
          to: 'client@prospect.example.com',
          subject: 'Modernizing your logistics digital flow',
          body: 'Hi Sarah, our benchmarks show significant speed improvements.',
        },
        testOrgId
      );

      // Verify quota count incremented
      const updatedMailbox = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'sales@realdeal.com',
      });
      expect(updatedMailbox?.sendsToday).toBe(1);

      // Verify draft status updated to accepted
      const updatedDraft = await EmailDraft.findById(draft._id);
      expect(updatedDraft?.status).toBe('accepted');
      expect(updatedDraft?.providerMessageId).toBe('gm_msg_abc_999');
    });
  });

  describe('5. Gmail Token Refresh Failure, Retry Suppression & Reconnection Suite', () => {
    let testOrgId: string;
    let testUserId: string;
    let sessionToken: string;

    beforeAll(async () => {
      const org = await Organization.findOneAndUpdate(
        { slug: 'org-gmail-reauth-suite' },
        { name: 'Reauth Suite Org', slug: 'org-gmail-reauth-suite', createdBy: 'admin_test' },
        { upsert: true, new: true }
      );
      testOrgId = org._id.toString();

      const testUser = await User.findOneAndUpdate(
        { email: 'reauth_user_501@swaniki.dev' },
        {
          email: 'reauth_user_501@swaniki.dev',
          fullName: 'Reauth User',
          googleSub: 'google_sub_reauth_501',
          status: 'active',
          organizations: [{ organizationId: testOrgId, role: 'owner' }],
          defaultOrgId: testOrgId,
        },
        { upsert: true, new: true }
      );
      testUserId = testUser!._id.toString();

      await EmailAccount.deleteMany({
        emailAddress: {
          $in: [
            'reauth_sync@swaniki.dev',
            'mb_sync_fail@swaniki.dev',
            'deadtoken@swaniki.dev',
            'healthy_reauth@swaniki.dev',
            'send_fail@swaniki.dev',
            'bg_sync_fail@swaniki.dev',
            'missing_refresh@swaniki.dev',
            'token_refresh@swaniki.dev',
            'sync_success@swaniki.dev',
            'paginated_sync@swaniki.dev',
            'incremental_sync@swaniki.dev',
            'expired_cursor@swaniki.dev',
            'concurrent_sync@swaniki.dev',
          ],
        },
      });
      await EmailThread.deleteMany({
        mailboxEmail: {
          $in: [
            'reauth_sync@swaniki.dev',
            'mb_sync_fail@swaniki.dev',
            'deadtoken@swaniki.dev',
            'healthy_reauth@swaniki.dev',
            'send_fail@swaniki.dev',
            'bg_sync_fail@swaniki.dev',
            'missing_refresh@swaniki.dev',
            'token_refresh@swaniki.dev',
            'sync_success@swaniki.dev',
            'paginated_sync@swaniki.dev',
            'incremental_sync@swaniki.dev',
            'expired_cursor@swaniki.dev',
            'concurrent_sync@swaniki.dev',
          ],
        },
      });
      // The quota ledger is shared state: reset it so the suite starts with a
      // full budget regardless of what earlier suites or runs consumed.
      await GmailQuotaLedger.deleteMany({
        mailboxKey: {
          $in: [
            'reauth_sync@swaniki.dev',
            'mb_sync_fail@swaniki.dev',
            'deadtoken@swaniki.dev',
            'healthy_reauth@swaniki.dev',
            'send_fail@swaniki.dev',
            'bg_sync_fail@swaniki.dev',
            'missing_refresh@swaniki.dev',
            'token_refresh@swaniki.dev',
            'sync_success@swaniki.dev',
            'paginated_sync@swaniki.dev',
            'incremental_sync@swaniki.dev',
            'expired_cursor@swaniki.dev',
            'concurrent_sync@swaniki.dev',
          ],
        },
      });
      await GmailApiLease.deleteMany({
        mailboxKey: {
          $in: [
            'reauth_sync@swaniki.dev',
            'mb_sync_fail@swaniki.dev',
            'deadtoken@swaniki.dev',
            'healthy_reauth@swaniki.dev',
            'send_fail@swaniki.dev',
            'bg_sync_fail@swaniki.dev',
            'missing_refresh@swaniki.dev',
            'token_refresh@swaniki.dev',
            'sync_success@swaniki.dev',
            'paginated_sync@swaniki.dev',
            'incremental_sync@swaniki.dev',
            'expired_cursor@swaniki.dev',
            'concurrent_sync@swaniki.dev',
          ],
        },
      });

      sessionToken = signSessionToken({
        userId: testUserId,
        organizationId: testOrgId,
        email: 'reauth_user_501@swaniki.dev',
        role: 'owner',
      });
    });

    it('should accurately detect invalid_grant and revoked token errors via isInvalidGrantError', () => {
      expect(isInvalidGrantError(new Error('invalid_grant: Token has been expired or revoked.'))).toBe(true);
      expect(isInvalidGrantError({ error: 'invalid_grant' })).toBe(true);
      expect(isInvalidGrantError({ message: 'Token has been expired or revoked.' })).toBe(true);
      expect(isInvalidGrantError({ response: { data: { error: 'invalid_grant' } } })).toBe(true);
      expect(isInvalidGrantError({ response: { data: { error_description: 'Token has been expired or revoked.' } } })).toBe(true);
      expect(isInvalidGrantError({ message: 'Rate limit exceeded: 429' })).toBe(false);
      expect(isInvalidGrantError(null)).toBe(false);
      expect(isInvalidGrantError(undefined)).toBe(false);
    });

    it('should handle invalid_grant during Gmail integration sync: mark mailbox in error/paused state, preserve existing threads, and maintain user session without sign-out', async () => {
      // 1. Setup connected EmailAccount
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'reauth_sync@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Reauth Mailbox',
          provider: 'gmail',
          status: 'connected',
          encryptedAccessToken: encryptToken('expired_access_token'),
          encryptedRefreshToken: encryptToken('revoked_refresh_token'),
          isPaused: false,
        },
        { upsert: true, new: true }
      );

      // 2. Pre-populate an existing thread in MongoDB to verify data preservation
      await EmailThread.findOneAndUpdate(
        { organizationId: testOrgId, mailboxEmail: 'reauth_sync@swaniki.dev', threadId: 'th_preexisting_001' },
        {
          subject: 'Critical Client Contract Discussion',
          snippet: 'Please find attached the signed contract.',
          lastMessageDate: new Date(),
          messageCount: 1,
          messages: [{
            id: 'msg_contract_001',
            from: { name: 'Client Alice', email: 'alice@client.example.com' },
            to: [{ name: 'Swaniki Team', email: 'reauth_sync@swaniki.dev' }],
            subject: 'Critical Client Contract Discussion',
            bodyText: 'Please find attached the signed contract.',
            snippet: 'Please find attached the signed contract.',
            date: new Date(),
            isRead: true,
            isStarred: true,
            hasAttachments: false,
          }],
        },
        { upsert: true }
      );

      // 3. Mock google.gmail threads.list to reject with invalid_grant error
      const mockGmail = {
        users: {
          threads: {
            list: vi.fn().mockRejectedValue(new Error('invalid_grant: Token has been expired or revoked.')),
            get: vi.fn(),
          },
          messages: { send: vi.fn() },
          getProfile: vi.fn(),
        },
      };
      vi.spyOn(google, 'gmail').mockReturnValue(mockGmail as any);

      // 4. Request manual sync endpoint
      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/reauth_sync@swaniki.dev/sync')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=${sessionToken}`])
        .set('x-organization-id', testOrgId);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('GMAIL_REAUTH_REQUIRED');
      expect(res.body.error.requiresReconnect).toBe(true);
      expect(res.body.error.emailAddress).toBe('reauth_sync@swaniki.dev');

      // 5. Verify mailbox status updated in MongoDB to error & paused
      const updatedAccount = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'reauth_sync@swaniki.dev',
      });
      expect(updatedAccount?.status).toBe('error');
      expect(updatedAccount?.isPaused).toBe(true);
      expect(updatedAccount?.pausedReason).toContain('expired or revoked');

      // 6. Verify pre-existing threads were preserved (not dropped or corrupted)
      const preservedThread = await EmailThread.findOne({
        organizationId: testOrgId,
        threadId: 'th_preexisting_001',
      });
      expect(preservedThread).not.toBeNull();
      expect(preservedThread?.subject).toBe('Critical Client Contract Discussion');

      // 7. Verify user session is decoupled and NOT signed out
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=${sessionToken}`]);
      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.data.user.email).toBe('reauth_user_501@swaniki.dev');
    });

    it('should suppress repeated retries on error/paused mailbox without calling Google API', async () => {
      // Ensure mailbox is explicitly in error and paused state
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'reauth_sync@swaniki.dev' },
        {
          status: 'error',
          isPaused: true,
          pausedReason: 'Gmail authorization expired or revoked. Reconnection required.',
        }
      );

      const listSpy = vi.fn().mockResolvedValue({ data: { threads: [] } });
      vi.spyOn(google, 'gmail').mockReturnValue({
        users: { threads: { list: listSpy } },
      } as any);

      // Attempt sync via integration endpoint
      const res1 = await request(app)
        .post('/api/v1/integrations/google/gmail/reauth_sync@swaniki.dev/sync')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=${sessionToken}`])
        .set('x-organization-id', testOrgId);

      expect(res1.status).toBe(401);
      expect(res1.body.error.code).toBe('GMAIL_REAUTH_REQUIRED');

      // Attempt sync via mailbox endpoint
      const res2 = await request(app)
        .post('/api/v1/mailboxes/reauth_sync@swaniki.dev/sync')
        .set('x-organization-id', testOrgId);

      expect(res2.status).toBe(401);
      expect(res2.body.error.code).toBe('GMAIL_REAUTH_REQUIRED');

      // Attempt getAuthorizedGmailClient directly
      await expect(gmailProvider.getAuthorizedGmailClient('reauth_sync@swaniki.dev')).rejects.toMatchObject({
        code: 'GMAIL_REAUTH_REQUIRED',
        statusCode: 401,
      });

      // Verify Google API was never called because retry suppression stopped execution immediately
      expect(listSpy).not.toHaveBeenCalled();
    });

    it('should catch invalid_grant on POST /api/v1/mailboxes/:id/sync, mark mailbox in error state and avoid 500', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'mb_sync_fail@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'MB Sync Fail',
          provider: 'gmail',
          status: 'connected',
          encryptedAccessToken: encryptToken('acc_tok'),
          encryptedRefreshToken: encryptToken('ref_tok'),
          isPaused: false,
        },
        { upsert: true, new: true }
      );

      vi.spyOn(google, 'gmail').mockReturnValue({
        users: {
          threads: {
            list: vi.fn().mockRejectedValue(new Error('invalid_grant: Token has been expired or revoked.')),
          },
        },
      } as any);

      const res = await request(app)
        .post('/api/v1/mailboxes/mb_sync_fail@swaniki.dev/sync')
        .set('x-organization-id', testOrgId);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('GMAIL_REAUTH_REQUIRED');
      expect(res.body.error.requiresReconnect).toBe(true);

      const updated = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'mb_sync_fail@swaniki.dev',
      });
      expect(updated?.status).toBe('error');
      expect(updated?.isPaused).toBe(true);
    });

    it('should successfully reconnect mailbox, restore connected state, update tokens and preserve existing threads', async () => {
      const state = googleOAuthService.generateSecureState({
        organizationId: testOrgId,
        userId: testUserId,
        returnTo: '/integrations',
      });

      vi.spyOn(googleOAuthService, 'handleGmailCallback').mockResolvedValueOnce({
        tokens: {
          access_token: 'new_fresh_access_token_777',
          refresh_token: 'new_fresh_refresh_token_888',
          expiry_date: Date.now() + 3600000,
          scope: 'https://www.googleapis.com/auth/gmail.modify',
        },
        emailAddress: 'reauth_sync@swaniki.dev',
        displayName: 'Reconnected Mailbox',
        googleSub: 'google_sub_reconnected_999',
        historyId: '3001',
      });

      // Mock syncThreadsToDb during reconnect
      vi.spyOn(gmailProvider, 'syncThreadsToDb').mockResolvedValueOnce(4);

      const res = await request(app)
        .get('/api/v1/integrations/google/gmail/callback')
        .set('Cookie', [`${GMAIL_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'fresh_code_reconnect_123', state });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('gmail_connected=true');

      // Verify DB status restored to connected and tokens updated
      const reconnectedAcc = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'reauth_sync@swaniki.dev',
      });
      expect(reconnectedAcc?.status).toBe('connected');
      expect(reconnectedAcc?.isPaused).toBe(false);
      expect(reconnectedAcc?.pausedReason).toBeUndefined();
      expect(decryptToken(reconnectedAcc!.encryptedAccessToken!)).toBe('new_fresh_access_token_777');
      expect(decryptToken(reconnectedAcc!.encryptedRefreshToken!)).toBe('new_fresh_refresh_token_888');

      // Verify preexisting threads were kept safe
      const threadCheck = await EmailThread.findOne({
        organizationId: testOrgId,
        threadId: 'th_preexisting_001',
      });
      expect(threadCheck).not.toBeNull();

      // Verify subsequent sync succeeds now that mailbox is reconnected
      vi.spyOn(gmailProvider, 'syncThreadsToDb').mockResolvedValueOnce(4);
      const syncRes = await request(app)
        .post('/api/v1/integrations/google/gmail/reauth_sync@swaniki.dev/sync')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=${sessionToken}`])
        .set('x-organization-id', testOrgId);

      expect(syncRes.status).toBe(200);
      expect(syncRes.body.success).toBe(true);
      expect(syncRes.body.data.syncedCount).toBe(4);
    });

    it('should preserve existing refresh token if Google omits refresh_token during reconnect, avoiding overwriting with empty value', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'deadtoken@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Dead Token Mailbox',
          provider: 'gmail',
          status: 'error',
          isPaused: true,
          pausedReason: 'Gmail authorization expired or revoked.',
          encryptedAccessToken: encryptToken('old_access'),
          encryptedRefreshToken: encryptToken('existing_token_preserve'),
        },
        { upsert: true, new: true }
      );

      const state = googleOAuthService.generateSecureState({
        organizationId: testOrgId,
        userId: testUserId,
        returnTo: '/integrations',
      });

      // Google returns new access token but NO refresh token
      vi.spyOn(googleOAuthService, 'handleGmailCallback').mockResolvedValueOnce({
        tokens: {
          access_token: 'new_temp_access_token',
          expiry_date: Date.now() + 3600000,
          scope: 'https://www.googleapis.com/auth/gmail.modify',
        },
        emailAddress: 'deadtoken@swaniki.dev',
        displayName: 'Dead Token Mailbox',
      });
      vi.spyOn(gmailProvider, 'syncThreadsToDb').mockResolvedValueOnce(0);

      const res = await request(app)
        .get('/api/v1/integrations/google/gmail/callback')
        .set('Cookie', [`${GMAIL_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'code_no_refresh', state });

      expect(res.status).toBe(302);

      const updated = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'deadtoken@swaniki.dev',
      });
      // Existing refresh token must be preserved when Google omits refresh_token
      expect(updated?.encryptedRefreshToken).toBeDefined();
      expect(decryptToken(updated!.encryptedRefreshToken!)).toBe('existing_token_preserve');
    });

    it('should preserve existing valid refresh token if Google omits refresh_token during re-auth of a healthy account', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'healthy_reauth@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Healthy Reauth Mailbox',
          provider: 'gmail',
          status: 'connected',
          isPaused: false,
          encryptedAccessToken: encryptToken('valid_access'),
          encryptedRefreshToken: encryptToken('valid_live_refresh_token_keep'),
        },
        { upsert: true, new: true }
      );

      const state = googleOAuthService.generateSecureState({
        organizationId: testOrgId,
        userId: testUserId,
        returnTo: '/integrations',
      });

      vi.spyOn(googleOAuthService, 'handleGmailCallback').mockResolvedValueOnce({
        tokens: {
          access_token: 'new_access_token_healthy',
          expiry_date: Date.now() + 3600000,
          scope: 'https://www.googleapis.com/auth/gmail.modify',
        },
        emailAddress: 'healthy_reauth@swaniki.dev',
        displayName: 'Healthy Reauth Mailbox',
      });
      vi.spyOn(gmailProvider, 'syncThreadsToDb').mockResolvedValueOnce(0);

      const res = await request(app)
        .get('/api/v1/integrations/google/gmail/callback')
        .set('Cookie', [`${GMAIL_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'code_healthy', state });

      expect(res.status).toBe(302);

      const updated = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'healthy_reauth@swaniki.dev',
      });
      // Healthy refresh token MUST be preserved
      expect(updated?.encryptedRefreshToken).toBeDefined();
      expect(decryptToken(updated!.encryptedRefreshToken!)).toBe('valid_live_refresh_token_keep');
    });

    it('should catch invalid_grant on sendMessage, mark mailbox in error/paused state and throw GMAIL_REAUTH_REQUIRED', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'send_fail@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Send Fail Mailbox',
          provider: 'gmail',
          status: 'connected',
          isPaused: false,
          encryptedAccessToken: encryptToken('access_1'),
          encryptedRefreshToken: encryptToken('refresh_1'),
        },
        { upsert: true, new: true }
      );

      vi.spyOn(google, 'gmail').mockReturnValue({
        users: {
          messages: {
            send: vi.fn().mockRejectedValue(new Error('invalid_grant: Token has been expired or revoked.')),
          },
        },
      } as any);

      await expect(
        gmailProvider.sendMessage('send_fail@swaniki.dev', {
          to: 'client@example.com',
          subject: 'Test Subject',
          body: 'Test Body',
        })
      ).rejects.toMatchObject({
        code: 'GMAIL_REAUTH_REQUIRED',
        statusCode: 401,
      });

      const updated = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'send_fail@swaniki.dev',
      });
      expect(updated?.status).toBe('error');
      expect(updated?.isPaused).toBe(true);
    });

    it('should catch initial background thread sync failure during OAuth callback without crashing callback redirect', async () => {
      const state = googleOAuthService.generateSecureState({
        organizationId: testOrgId,
        userId: testUserId,
        returnTo: '/integrations',
      });

      vi.spyOn(googleOAuthService, 'handleGmailCallback').mockResolvedValueOnce({
        tokens: {
          access_token: 'bg_sync_fail_acc',
          refresh_token: 'bg_sync_fail_ref',
          expiry_date: Date.now() + 3600000,
          scope: 'https://www.googleapis.com/auth/gmail.modify',
        },
        emailAddress: 'bg_sync_fail@swaniki.dev',
        displayName: 'BG Sync Fail Mailbox',
      });

      vi.spyOn(gmailProvider, 'syncThreadsToDb').mockRejectedValueOnce(
        new Error('invalid_grant: Token has been expired or revoked.')
      );

      const res = await request(app)
        .get('/api/v1/integrations/google/gmail/callback')
        .set('Cookie', [`${GMAIL_STATE_COOKIE_NAME}=${state}`])
        .query({ code: 'bg_fail_code', state });

      // Must complete redirect gracefully without crashing with 500
      expect(res.status).toBe(302);
      expect(res.header.location).toContain('gmail_connected=true');

      const acc = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'bg_sync_fail@swaniki.dev',
      });
      expect(acc?.status).toBe('error');
      expect(acc?.isPaused).toBe(true);
    });

    it('should reject sync requests with 401 UNAUTHORIZED when Swaniki app session is expired, distinguishing it from Gmail OAuth re-auth', async () => {
      // 1. Generate an expired session token
      const expiredSessionToken = jwt.sign(
        {
          userId: testUserId,
          organizationId: testOrgId,
          email: 'reauth_user_501@swaniki.dev',
          role: 'owner',
        },
        env.SESSION_SECRET,
        { expiresIn: '-10s' }
      );

      // 2. Call integration sync with expired session cookie
      const res1 = await request(app)
        .post('/api/v1/integrations/google/gmail/reauth_sync@swaniki.dev/sync')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=${expiredSessionToken}`])
        .set('x-organization-id', testOrgId);

      expect(res1.status).toBe(401);
      expect(res1.body.success).toBe(false);
      expect(res1.body.error.code).toBe('UNAUTHORIZED');
      expect(res1.body.error.message).toContain('session has expired');

      // 3. Call mailbox sync with expired session cookie
      const res2 = await request(app)
        .post('/api/v1/mailboxes/reauth_sync@swaniki.dev/sync')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=${expiredSessionToken}`])
        .set('x-organization-id', testOrgId);

      expect(res2.status).toBe(401);
      expect(res2.body.success).toBe(false);
      expect(res2.body.error.code).toBe('UNAUTHORIZED');
      expect(res2.body.error.message).toContain('session has expired');
    });

    it('should handle missing refresh token when access token is expired: mark mailbox as requiring reconnection and return 401 GMAIL_REAUTH_REQUIRED', async () => {
      // Setup mailbox with expired access token and NO refresh token
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'missing_refresh@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Missing Refresh Mailbox',
          provider: 'gmail',
          status: 'connected',
          isPaused: false,
          encryptedAccessToken: encryptToken('expired_access_token_alone'),
          tokenExpiryDate: new Date(Date.now() - 3600000), // 1 hour ago
        },
        { upsert: true, new: true }
      );

      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/missing_refresh@swaniki.dev/sync')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=${sessionToken}`])
        .set('x-organization-id', testOrgId);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('GMAIL_REAUTH_REQUIRED');
      expect(res.body.error.requiresReconnect).toBe(true);

      const acc = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'missing_refresh@swaniki.dev',
      });
      expect(acc?.status).toBe('error');
      expect(acc?.isPaused).toBe(true);
      expect(acc?.pausedReason).toContain('expired');
    });

    it('should securely persist newly issued access token to MongoDB when Google OAuth client refreshes tokens', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'token_refresh@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Token Refresh Mailbox',
          provider: 'gmail',
          status: 'connected',
          isPaused: false,
          encryptedAccessToken: encryptToken('old_access_token_abc'),
          encryptedRefreshToken: encryptToken('valid_refresh_token_xyz'),
        },
        { upsert: true, new: true }
      );

      // Get client and emit tokens event
      const { oauth2Client } = await gmailProvider.getAuthorizedGmailClient('token_refresh@swaniki.dev');
      const newExpiry = Date.now() + 7200000;
      oauth2Client.emit('tokens', {
        access_token: 'brand_new_refreshed_access_token_999',
        expiry_date: newExpiry,
      });

      // Brief delay to allow async DB update to complete
      await new Promise((r) => setTimeout(r, 100));

      const updated = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'token_refresh@swaniki.dev',
      });
      expect(updated).not.toBeNull();
      expect(decryptToken(updated!.encryptedAccessToken!)).toBe('brand_new_refreshed_access_token_999');
      // Verify refresh token was unchanged
      expect(decryptToken(updated!.encryptedRefreshToken!)).toBe('valid_refresh_token_xyz');
      expect(updated!.tokenExpiryDate?.getTime()).toBe(newExpiry);
    });

    it('should execute successful sync when tokens are valid: persist fetched threads in DB, update lastSyncedAt, and return 200', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'sync_success@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Sync Success Mailbox',
          provider: 'gmail',
          status: 'connected',
          isPaused: false,
          encryptedAccessToken: encryptToken('valid_live_access_token'),
          encryptedRefreshToken: encryptToken('valid_live_refresh_token'),
        },
        { upsert: true, new: true }
      );

      // Mock Gmail API threads.list and threads.get
      const mockThreadsList = vi.fn().mockResolvedValue({
        data: {
          threads: [{ id: 'thread_synced_success_001', snippet: 'Meeting confirmation with prospect' }],
        },
      });

      const mockThreadsGet = vi.fn().mockResolvedValue({
        data: {
          id: 'thread_synced_success_001',
          messages: [
            {
              id: 'msg_synced_001',
              threadId: 'thread_synced_success_001',
              snippet: 'Meeting confirmation with prospect',
              internalDate: String(Date.now()),
              payload: {
                headers: [
                  { name: 'Subject', value: 'Q4 Enterprise Deal Sync' },
                  { name: 'From', value: 'Enterprise Lead <lead@enterprise.com>' },
                  { name: 'To', value: 'sync_success@swaniki.dev' },
                ],
              },
            },
          ],
        },
      });

      vi.spyOn(google, 'gmail').mockReturnValue({
        users: {
          threads: {
            list: mockThreadsList,
            get: mockThreadsGet,
          },
        },
      } as any);

      const res = await request(app)
        .post('/api/v1/integrations/google/gmail/sync_success@swaniki.dev/sync')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=${sessionToken}`])
        .set('x-organization-id', testOrgId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.syncedCount).toBe(1);

      // Verify thread is persisted in MongoDB
      const savedThread = await EmailThread.findOne({
        organizationId: testOrgId,
        mailboxEmail: 'sync_success@swaniki.dev',
        threadId: 'thread_synced_success_001',
      });
      expect(savedThread).not.toBeNull();
      expect(savedThread?.subject).toBe('Q4 Enterprise Deal Sync');
      expect(savedThread?.snippet).toBe('Meeting confirmation with prospect');
      expect(savedThread?.messages.length).toBe(1);
      expect(savedThread?.messages[0].from.email).toBe('lead@enterprise.com');

      // Verify mailbox lastSyncedAt was updated
      const updatedAccount = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'sync_success@swaniki.dev',
      });
      expect(updatedAccount?.lastSyncedAt).toBeDefined();
      expect(Date.now() - updatedAccount!.lastSyncedAt!.getTime()).toBeLessThan(5000);
    });

    it('should paginate across multiple Gmail result pages using nextPageToken and import all threads', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'paginated_sync@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Paginated Mailbox',
          provider: 'gmail',
          status: 'connected',
          isPaused: false,
          encryptedAccessToken: encryptToken('page_access_token'),
          encryptedRefreshToken: encryptToken('page_refresh_token'),
        },
        { upsert: true, new: true }
      );

      // Page 1 returns thread 1 + nextPageToken
      // Page 2 returns thread 2 (end)
      const mockThreadsList = vi.fn()
        .mockResolvedValueOnce({
          data: {
            threads: [{ id: 'th_page_1', snippet: 'Page 1 snippet' }],
            nextPageToken: 'token_for_page_2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            threads: [{ id: 'th_page_2', snippet: 'Page 2 snippet' }],
          },
        });

      const mockThreadsGet = vi.fn().mockImplementation(({ id }: { id: string }) => {
        return Promise.resolve({
          data: {
            id,
            messages: [
              {
                id: `msg_${id}`,
                threadId: id,
                snippet: `Snippet for ${id}`,
                internalDate: String(Date.now()),
                payload: {
                  headers: [
                    { name: 'Subject', value: `Subject for ${id}` },
                    { name: 'From', value: 'sender@example.com' },
                    { name: 'To', value: 'paginated_sync@swaniki.dev' },
                  ],
                },
              },
            ],
          },
        });
      });

      vi.spyOn(google, 'gmail').mockReturnValue({
        users: {
          threads: {
            list: mockThreadsList,
            get: mockThreadsGet,
          },
        },
      } as any);

      const count = await gmailProvider.syncThreadsToDb(testOrgId, 'paginated_sync@swaniki.dev', { maxThreads: 10, pageSize: 1 });
      expect(count).toBe(2);
      expect(mockThreadsList).toHaveBeenCalledTimes(2);

      const savedThreads = await EmailThread.find({
        organizationId: testOrgId,
        mailboxEmail: 'paginated_sync@swaniki.dev',
      });
      expect(savedThreads.length).toBe(2);
    });

    it('should handle repeated sync without creating duplicate threads or messages', async () => {
      // Running sync twice with the same thread IDs must keep exact same count in DB
      const initialCount = await EmailThread.countDocuments({
        organizationId: testOrgId,
        mailboxEmail: 'paginated_sync@swaniki.dev',
      });
      expect(initialCount).toBe(2);

      // Second sync run with identical threads
      const mockThreadsList = vi.fn().mockResolvedValue({
        data: {
          threads: [{ id: 'th_page_1', snippet: 'Page 1 snippet' }, { id: 'th_page_2', snippet: 'Page 2 snippet' }],
        },
      });
      const mockThreadsGet = vi.fn().mockImplementation(({ id }: { id: string }) => {
        return Promise.resolve({
          data: {
            id,
            messages: [
              {
                id: `msg_${id}`,
                threadId: id,
                snippet: `Snippet for ${id}`,
                internalDate: String(Date.now()),
                payload: {
                  headers: [
                    { name: 'Subject', value: `Subject for ${id}` },
                    { name: 'From', value: 'sender@example.com' },
                    { name: 'To', value: 'paginated_sync@swaniki.dev' },
                  ],
                },
              },
            ],
          },
        });
      });
      vi.spyOn(google, 'gmail').mockReturnValue({
        users: {
          threads: {
            list: mockThreadsList,
            get: mockThreadsGet,
          },
        },
      } as any);

      const count = await gmailProvider.syncThreadsToDb(testOrgId, 'paginated_sync@swaniki.dev', { maxThreads: 10 });
      expect(count).toBe(2);

      const afterCount = await EmailThread.countDocuments({
        organizationId: testOrgId,
        mailboxEmail: 'paginated_sync@swaniki.dev',
      });
      // Zero duplicates created
      expect(afterCount).toBe(2);
    });

    it('GET /api/v1/mailboxes/:id/threads should load persisted inbox from MongoDB after page reload', async () => {
      const res = await request(app)
        .get('/api/v1/mailboxes/paginated_sync@swaniki.dev/threads')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=${sessionToken}`])
        .set('x-organization-id', testOrgId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data[0].subject).toContain('Subject for th_page_');
    });

    it('should enforce strict mailbox and thread isolation between different organizations', async () => {
      const otherOrgId = 'org_other_tenant_isolated_999';

      // Other org attempts to query threads of paginated_sync@swaniki.dev
      const res = await request(app)
        .get('/api/v1/mailboxes/paginated_sync@swaniki.dev/threads')
        .set('x-organization-id', otherOrgId);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Other organization gets 0 threads (strict tenant boundary enforced)
      expect(res.body.data.length).toBe(0);
    });

    it('should use incremental history sync when a cursor and baseline exist, persisting only changed threads', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'incremental_sync@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Incremental Mailbox',
          provider: 'gmail',
          status: 'connected',
          isPaused: false,
          initialSyncCompleted: true,
          historyId: '5000',
          encryptedAccessToken: encryptToken('incr_access_token'),
          encryptedRefreshToken: encryptToken('incr_refresh_token'),
        },
        { upsert: true, new: true }
      );

      const mockHistoryList = vi.fn().mockResolvedValue({
        data: {
          historyId: '5123',
          history: [
            {
              messages: [{ id: 'msg_inc_1', threadId: 'th_inc_1' }],
              messagesAdded: [{ message: { id: 'msg_inc_1', threadId: 'th_inc_1' } }],
            },
          ],
        },
      });
      const mockThreadsGet = vi.fn().mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          data: {
            id,
            messages: [
              {
                id: `msg_${id}`,
                threadId: id,
                snippet: `Incremental snippet ${id}`,
                internalDate: String(Date.now()),
                payload: {
                  headers: [
                    { name: 'Subject', value: `Incremental subject ${id}` },
                    { name: 'From', value: 'inbound@example.com' },
                    { name: 'To', value: 'incremental_sync@swaniki.dev' },
                  ],
                },
              },
            ],
          },
        })
      );
      const mockThreadsList = vi.fn();
      const mockGetProfile = vi.fn().mockResolvedValue({ data: { historyId: '5123' } });

      vi.spyOn(google, 'gmail').mockReturnValue({
        users: {
          threads: { list: mockThreadsList, get: mockThreadsGet },
          history: { list: mockHistoryList },
          getProfile: mockGetProfile,
        },
      } as any);

      const count = await gmailProvider.syncThreadsToDb(testOrgId, 'incremental_sync@swaniki.dev');

      expect(count).toBe(1);
      expect(mockHistoryList).toHaveBeenCalledTimes(1);
      // Full pagination must NOT run when incremental sync succeeds
      expect(mockThreadsList).not.toHaveBeenCalled();

      const savedThread = await EmailThread.findOne({
        organizationId: testOrgId,
        mailboxEmail: 'incremental_sync@swaniki.dev',
        threadId: 'th_inc_1',
      });
      expect(savedThread).not.toBeNull();
      expect(savedThread?.subject).toBe('Incremental subject th_inc_1');

      const updatedAccount = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'incremental_sync@swaniki.dev',
      });
      expect(updatedAccount?.historyId).toBe('5123');
      expect(updatedAccount?.syncStatus).toBe('idle');
      expect(updatedAccount?.lastSyncError).toBeUndefined();
    });

    it('should fall back to a full sync when the Gmail history cursor has expired', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'expired_cursor@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Expired Cursor Mailbox',
          provider: 'gmail',
          status: 'connected',
          isPaused: false,
          initialSyncCompleted: true,
          historyId: '1',
          encryptedAccessToken: encryptToken('exp_access_token'),
          encryptedRefreshToken: encryptToken('exp_refresh_token'),
        },
        { upsert: true, new: true }
      );

      const expiredError: any = new Error('Requested history ID is too old or not found');
      expiredError.status = 404;

      const mockHistoryList = vi.fn().mockRejectedValue(expiredError);
      const mockThreadsList = vi.fn().mockResolvedValue({
        data: { threads: [{ id: 'th_full_1', snippet: 'Full fallback snippet' }] },
      });
      const mockThreadsGet = vi.fn().mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          data: {
            id,
            messages: [
              {
                id: `msg_${id}`,
                threadId: id,
                snippet: `Fallback snippet ${id}`,
                internalDate: String(Date.now()),
                payload: {
                  headers: [
                    { name: 'Subject', value: `Fallback subject ${id}` },
                    { name: 'From', value: 'sender@example.com' },
                    { name: 'To', value: 'expired_cursor@swaniki.dev' },
                  ],
                },
              },
            ],
          },
        })
      );
      const mockGetProfile = vi.fn().mockResolvedValue({ data: { historyId: '9999' } });

      vi.spyOn(google, 'gmail').mockReturnValue({
        users: {
          threads: { list: mockThreadsList, get: mockThreadsGet },
          history: { list: mockHistoryList },
          getProfile: mockGetProfile,
        },
      } as any);

      const count = await gmailProvider.syncThreadsToDb(testOrgId, 'expired_cursor@swaniki.dev');

      expect(count).toBe(1);
      expect(mockHistoryList).toHaveBeenCalledTimes(1);
      expect(mockThreadsList).toHaveBeenCalledTimes(1);

      const savedThread = await EmailThread.findOne({
        organizationId: testOrgId,
        mailboxEmail: 'expired_cursor@swaniki.dev',
        threadId: 'th_full_1',
      });
      expect(savedThread).not.toBeNull();

      const updatedAccount = await EmailAccount.findOne({
        organizationId: testOrgId,
        emailAddress: 'expired_cursor@swaniki.dev',
      });
      expect(updatedAccount?.historyId).toBe('9999');
      expect(updatedAccount?.syncStatus).toBe('idle');
    });

    it('should coalesce concurrent syncs for the same mailbox into a single run', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: testOrgId, emailAddress: 'concurrent_sync@swaniki.dev' },
        {
          userId: testUserId,
          displayName: 'Concurrent Mailbox',
          provider: 'gmail',
          status: 'connected',
          isPaused: false,
          encryptedAccessToken: encryptToken('conc_access_token'),
          encryptedRefreshToken: encryptToken('conc_refresh_token'),
        },
        { upsert: true, new: true }
      );

      const mockThreadsGet = vi.fn().mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          data: {
            id,
            messages: [
              {
                id: `msg_${id}`,
                threadId: id,
                snippet: `Concurrent snippet ${id}`,
                internalDate: String(Date.now()),
                payload: {
                  headers: [
                    { name: 'Subject', value: `Concurrent subject ${id}` },
                    { name: 'From', value: 'sender@example.com' },
                    { name: 'To', value: 'concurrent_sync@swaniki.dev' },
                  ],
                },
              },
            ],
          },
        })
      );
      const mockThreadsList = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ data: { threads: [{ id: 'th_conc_1', snippet: 'Concurrent snippet' }] } }),
              50
            )
          )
      );

      vi.spyOn(google, 'gmail').mockReturnValue({
        users: {
          threads: { list: mockThreadsList, get: mockThreadsGet },
        },
      } as any);

      const [first, second] = await Promise.all([
        gmailProvider.syncThreadsToDb(testOrgId, 'concurrent_sync@swaniki.dev'),
        gmailProvider.syncThreadsToDb(testOrgId, 'concurrent_sync@swaniki.dev'),
      ]);

      expect(first).toBe(1);
      expect(second).toBe(1);
      // The second caller must join the in-flight run instead of starting another
      expect(mockThreadsList).toHaveBeenCalledTimes(1);
      expect(mockThreadsGet).toHaveBeenCalledTimes(1);
    });
  });
});

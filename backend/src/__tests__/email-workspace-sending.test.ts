import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailThread } from '../models/EmailThread.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { Suppression } from '../models/Suppression.js';

describe('Stage 5 & 6: Email Workspace & Sending Safety Pipeline Suite', () => {
  let app: any;
  const tenant = 'org_test_email_tenant';
  const mailbox = 'outreach@swaniki.dev';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
    await Suppression.deleteMany({ organizationId: tenant });
    await EmailDraft.deleteMany({ organizationId: tenant });
    await EmailAccount.deleteMany({ organizationId: tenant });
    await EmailThread.deleteMany({ organizationId: tenant });
    await EmailSendAttempt.deleteMany({ organizationId: tenant });
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  describe('Mailbox Workspace & Thread Interaction', () => {
    it('GET /api/v1/mailboxes should seed default sandbox mailbox and sample threads', async () => {
      const res = await request(app)
        .get('/api/v1/mailboxes')
        .set('x-organization-id', tenant);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].emailAddress).toBe(mailbox);
    });

    it('GET /api/v1/mailboxes/:id/threads and POST reply should update chronological thread', async () => {
      const threadsRes = await request(app)
        .get(`/api/v1/mailboxes/${mailbox}/threads`)
        .set('x-organization-id', tenant);

      expect(threadsRes.status).toBe(200);
      expect(threadsRes.body.data.length).toBeGreaterThanOrEqual(1);

      const targetThread = threadsRes.body.data[0];

      // Post reply
      const replyRes = await request(app)
        .post(`/api/v1/mailboxes/${mailbox}/threads/${targetThread.threadId}/reply`)
        .set('x-organization-id', tenant)
        .send({ bodyText: 'Thanks Elena, sending the case study link over.' });

      expect(replyRes.status).toBe(201);
      expect(replyRes.body.data.messageCount).toBe(targetThread.messageCount + 1);
    });
  });

  describe('7 Pre-Flight Verification Checks & Safe Send Pipeline', () => {
    it('PRE-FLIGHT CHECK 1: Should block unapproved draft', async () => {
      const draft = await EmailDraft.create({
        organizationId: tenant,
        recipientEmail: 'client@prospect.example.com',
        subject: 'Pending Draft',
        bodyText: 'Unreviewed body',
        status: 'draft', // Not approved!
      });

      const res = await request(app)
        .post(`/api/v1/mailboxes/${mailbox}/send`)
        .set('x-organization-id', tenant)
        .send({
          draftId: draft._id.toString(),
          idempotencyKey: 'idemp_key_001',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNAPPROVED_DRAFT');
    });

    it('PRE-FLIGHT CHECK 2: Should block suppressed recipient', async () => {
      const suppressedEmail = 'optout@prospect.example.com';
      await Suppression.create({
        organizationId: tenant,
        email: suppressedEmail,
        reason: 'unsubscribed',
      });

      const draft = await EmailDraft.create({
        organizationId: tenant,
        recipientEmail: suppressedEmail,
        subject: 'Approved Outreach',
        bodyText: 'Content',
        status: 'approved',
      });

      const res = await request(app)
        .post(`/api/v1/mailboxes/${mailbox}/send`)
        .set('x-organization-id', tenant)
        .send({
          draftId: draft._id.toString(),
          idempotencyKey: 'idemp_key_002',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RECIPIENT_SUPPRESSED');
    });

    it('PRE-FLIGHT CHECK 3: Should block send when mailbox emergency pause is engaged', async () => {
      await EmailAccount.findOneAndUpdate(
        { organizationId: tenant, emailAddress: mailbox },
        { $set: { isPaused: true, pausedReason: 'Maintenance pause' } }
      );

      const draft = await EmailDraft.create({
        organizationId: tenant,
        recipientEmail: 'active@prospect.example.com',
        subject: 'Approved Note',
        bodyText: 'Content',
        status: 'approved',
      });

      const res = await request(app)
        .post(`/api/v1/mailboxes/${mailbox}/send`)
        .set('x-organization-id', tenant)
        .send({
          draftId: draft._id.toString(),
          idempotencyKey: 'idemp_key_003',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MAILBOX_PAUSED');

      // Unpause mailbox for subsequent tests
      await EmailAccount.findOneAndUpdate(
        { organizationId: tenant, emailAddress: mailbox },
        { $set: { isPaused: false } }
      );
    });

    it('FULL PASS & IDEMPOTENCY: Approved draft dispatches safely and handles duplicate clicks idempotently', async () => {
      const draft = await EmailDraft.create({
        organizationId: tenant,
        recipientEmail: 'verified@prospect.example.com',
        subject: 'Partnership Opportunity',
        bodyText: 'Hello from Swaniki Radar.',
        status: 'approved',
      });

      const idempKey = 'idemp_unique_safe_004';

      // First dispatch: Should succeed and transition status to 'accepted'
      const res1 = await request(app)
        .post(`/api/v1/mailboxes/${mailbox}/send`)
        .set('x-organization-id', tenant)
        .send({
          draftId: draft._id.toString(),
          idempotencyKey: idempKey,
        });

      expect(res1.status).toBe(200);
      expect(res1.body.data.status).toBe('accepted');
      expect(res1.body.data.providerMessageId).toBeDefined();

      const originalMessageId = res1.body.data.providerMessageId;

      // Duplicate double-click dispatch: Must return idempotent accepted outcome without resending
      const res2 = await request(app)
        .post(`/api/v1/mailboxes/${mailbox}/send`)
        .set('x-organization-id', tenant)
        .send({
          draftId: draft._id.toString(),
          idempotencyKey: idempKey,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.data.status).toBe('accepted');
      expect(res2.body.data.providerMessageId).toBe(originalMessageId);
    });
  });
});

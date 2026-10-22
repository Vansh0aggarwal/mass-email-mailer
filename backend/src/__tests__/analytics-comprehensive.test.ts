import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { Suppression } from '../models/Suppression.js';
import { FollowUpTask } from '../models/FollowUpTask.js';
import { Company } from '../models/Company.js';

describe('Analytics & Reporting Subsystem', () => {
  let app: any;
  const tenantA = 'org_analytics_test_a';
  const tenantB = 'org_analytics_test_b';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await Promise.all([
      Campaign.deleteMany({ organizationId: { $in: [tenantA, tenantB] } }),
      CampaignRecipient.deleteMany({ organizationId: { $in: [tenantA, tenantB] } }),
      EmailSendAttempt.deleteMany({ organizationId: { $in: [tenantA, tenantB] } }),
      Suppression.deleteMany({ organizationId: { $in: [tenantA, tenantB] } }),
      FollowUpTask.deleteMany({ organizationId: { $in: [tenantA, tenantB] } }),
      Company.deleteMany({ organizationId: { $in: [tenantA, tenantB] } }),
    ]);
  });

  it('1. Accurately calculates grounded metrics (Sent, Delivered, Replies, Bounces, Rates)', async () => {
    // 1. Create a Campaign for Tenant A
    const campaign = await Campaign.create({
      organizationId: tenantA,
      name: 'Q4 Outbound Radar',
      createdBy: 'usr_test',
      status: 'sending',
      mailboxId: 'sales@swaniki.com',
      stats: { totalRecipients: 10, prepared: 0, sent: 8, failed: 1, skipped: 1, replied: 2 },
    });

    // 2. Create EmailSendAttempt records (6 accepted, 1 failed)
    const now = new Date();
    for (let i = 1; i <= 6; i++) {
      await EmailSendAttempt.create({
        organizationId: tenantA,
        campaignId: campaign._id,
        draftId: new mongoose.Types.ObjectId(),
        mailboxId: 'sales@swaniki.com',
        actorId: 'usr_test',
        recipientEmail: `lead${i}@example.com`,
        idempotencyKey: `send_key_${i}`,
        status: 'accepted',
        createdAt: new Date(now.getTime() - i * 3600000), // Within today
      });
    }
    await EmailSendAttempt.create({
      organizationId: tenantA,
      campaignId: campaign._id,
      draftId: new mongoose.Types.ObjectId(),
      mailboxId: 'sales@swaniki.com',
      actorId: 'usr_test',
      recipientEmail: 'lead_fail@example.com',
      idempotencyKey: 'send_key_fail',
      status: 'failed',
      createdAt: now,
    });

    // 3. Create CampaignRecipients (2 replied)
    for (let i = 1; i <= 6; i++) {
      const isReplied = i <= 2;
      await CampaignRecipient.create({
        organizationId: tenantA,
        campaignId: campaign._id,
        rowNumber: i,
        email: `lead${i}@example.com`,
        status: isReplied ? 'replied' : 'sent',
        replied: isReplied,
        repliedAt: isReplied ? new Date(now.getTime() - 1800000) : undefined,
        stepDrafts: [
          { stepIndex: 0, status: 'sent', sentAt: now },
          { stepIndex: 1, status: 'pending', scheduledAt: new Date(now.getTime() + 86400000 * 2) },
        ],
      });
    }

    // 4. Create Suppression (1 bounced)
    await Suppression.create({
      organizationId: tenantA,
      email: 'lead_bounced@example.com',
      reason: 'bounced',
      createdAt: now,
    });

    // 5. Query Analytics
    const res = await request(app)
      .get('/api/v1/analytics/overview?range=7d')
      .set('x-organization-id', tenantA);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const summary = res.body.data.summary;
    expect(summary.campaignsCount).toBe(1);
    expect(summary.emailsSent).toBe(6);
    expect(summary.bouncesCount).toBe(1);
    expect(summary.emailsDelivered).toBe(5); // 6 sent - 1 bounce
    expect(summary.repliesReceived).toBe(2);
    expect(summary.replyRatePercent).toBe(33.3); // (2 / 6) * 100
    expect(summary.failedSends).toBe(1);

    // Funnel stages
    const funnel = res.body.data.outreachFunnel;
    expect(funnel.length).toBe(5);
    expect(funnel.find((f: any) => f.stage === 'Inbound Replies').count).toBe(2);

    // Activity time series has daily buckets
    const timeSeries = res.body.data.activityTimeSeries;
    expect(Array.isArray(timeSeries)).toBe(true);
    expect(timeSeries.length).toBeGreaterThanOrEqual(7);

    // Step performance
    const steps = res.body.data.stepPerformance;
    expect(steps.length).toBe(3);
    expect(steps[0].stepName).toContain('Step 1');
  });

  it('2. Respects campaignId and status filters', async () => {
    const c1 = await Campaign.create({
      organizationId: tenantA,
      name: 'Campaign Alpha',
      createdBy: 'usr_test',
      status: 'sending',
      mailboxId: 'alpha@swaniki.com',
    });
    const c2 = await Campaign.create({
      organizationId: tenantA,
      name: 'Campaign Beta',
      createdBy: 'usr_test',
      status: 'completed',
      mailboxId: 'beta@swaniki.com',
    });

    await EmailSendAttempt.create({
      organizationId: tenantA,
      campaignId: c1._id,
      draftId: new mongoose.Types.ObjectId(),
      mailboxId: 'alpha@swaniki.com',
      actorId: 'usr_test',
      recipientEmail: 'target1@alpha.com',
      idempotencyKey: 'idemp_alpha',
      status: 'accepted',
    });

    await EmailSendAttempt.create({
      organizationId: tenantA,
      campaignId: c2._id,
      draftId: new mongoose.Types.ObjectId(),
      mailboxId: 'beta@swaniki.com',
      actorId: 'usr_test',
      recipientEmail: 'target2@beta.com',
      idempotencyKey: 'idemp_beta',
      status: 'accepted',
    });

    // Filter by Campaign Alpha specifically
    const resFiltered = await request(app)
      .get(`/api/v1/analytics/overview?campaignId=${c1._id}`)
      .set('x-organization-id', tenantA);

    expect(resFiltered.status).toBe(200);
    expect(resFiltered.body.data.summary.emailsSent).toBe(1);
    expect(resFiltered.body.data.campaignComparison.length).toBe(1);
    expect(resFiltered.body.data.campaignComparison[0].name).toBe('Campaign Alpha');

    // Filter by status: completed
    const resStatus = await request(app)
      .get('/api/v1/analytics/overview?status=completed')
      .set('x-organization-id', tenantA);

    expect(resStatus.status).toBe(200);
    expect(resStatus.body.data.summary.campaignsCount).toBe(1);
    expect(resStatus.body.data.campaignComparison[0].name).toBe('Campaign Beta');
  });

  it('3. Enforces strict multi-tenant data isolation', async () => {
    // Tenant A data
    await Campaign.create({
      organizationId: tenantA,
      name: 'Tenant A Secret Campaign',
      createdBy: 'usr_test',
      status: 'sending',
      mailboxId: 'm1@tenant-a.com',
    });
    await EmailSendAttempt.create({
      organizationId: tenantA,
      draftId: new mongoose.Types.ObjectId(),
      mailboxId: 'm1@tenant-a.com',
      actorId: 'usr_test',
      recipientEmail: 'secret@tenant-a.com',
      idempotencyKey: 'idemp_t_a',
      status: 'accepted',
    });

    // Tenant B queries analytics
    const resB = await request(app)
      .get('/api/v1/analytics/overview')
      .set('x-organization-id', tenantB);

    expect(resB.status).toBe(200);
    expect(resB.body.data.summary.campaignsCount).toBe(0);
    expect(resB.body.data.summary.emailsSent).toBe(0);
    expect(resB.body.data.campaignComparison.length).toBe(0);
  });

  it('4. Generates a well-formatted CSV report on GET /api/v1/analytics/export', async () => {
    await Campaign.create({
      organizationId: tenantA,
      name: 'Exportable Campaign',
      createdBy: 'usr_test',
      status: 'sending',
      mailboxId: 'outreach@domain.com',
      stats: { totalRecipients: 5, prepared: 0, sent: 3, failed: 0, skipped: 2, replied: 1 },
    });

    const exportRes = await request(app)
      .get('/api/v1/analytics/export?range=30d')
      .set('x-organization-id', tenantA);

    expect(exportRes.status).toBe(200);
    expect(exportRes.headers['content-type']).toContain('text/csv');
    expect(exportRes.headers['content-disposition']).toContain('attachment; filename=');
    expect(exportRes.text).toContain('Swaniki New Business Radar - Analytics Report');
    expect(exportRes.text).toContain('Total Campaigns,1');
    expect(exportRes.text).toContain('Exportable Campaign');
    expect(exportRes.text).toContain('DAILY OUTREACH ACTIVITY');
  });
});

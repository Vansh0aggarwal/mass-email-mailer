import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { CampaignImportJob } from '../models/CampaignImportJob.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { Suppression } from '../models/Suppression.js';

const tenant = 'org_live_progress_tenant';
const mailbox = 'outreach@progressradar.com';

function authHeader(org: string = tenant, user: string = 'usr_progress_tester') {
  return {
    'x-organization-id': org,
    'x-user-id': user,
  };
}

describe('Feature: Live Recipient Import Progress During Campaign Creation', () => {
  let app: any;

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await Promise.all([
      Campaign.deleteMany({ organizationId: tenant }),
      CampaignRecipient.deleteMany({ organizationId: tenant }),
      CampaignImportJob.deleteMany({ organizationId: tenant }),
      Company.deleteMany({ organizationId: tenant }),
      CompanyContact.deleteMany({ organizationId: tenant }),
      EmailAccount.deleteMany({ organizationId: tenant }),
      EmailSendAttempt.deleteMany({ organizationId: tenant }),
      Suppression.deleteMany({ organizationId: tenant }),
    ]);

    await EmailAccount.create({
      organizationId: tenant,
      emailAddress: mailbox,
      displayName: 'Progress Mailbox',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 100,
      sendsToday: 0,
      isPaused: false,
    });
  });

  // Helper to generate CSV with N recipients
  function generateCsv(count: number, options: { withSkipped?: boolean; withDuplicates?: boolean } = {}) {
    const lines = [
      'Company Name,Work Email,Director Full Name,Sector,Proposed Deliverable,Step 1 Subject,Step 1 Body',
    ];
    for (let i = 1; i <= count; i++) {
      if (options.withSkipped && i === 2) {
        // Missing email
        lines.push(`Company ${i},,Director ${i},Technology,Website Audit,Subject ${i},Body ${i}`);
      } else if (options.withDuplicates && i === 3) {
        // Duplicate email of row 1
        lines.push(`Company ${i},recipient1@example.com,Director ${i},Technology,Website Audit,Subject ${i},Body ${i}`);
      } else {
        lines.push(`Company ${i},recipient${i}@example.com,Director ${i},Technology,Website Audit,Subject ${i},Body ${i}`);
      }
    }
    return lines.join('\n');
  }

  it('1. Accurately determines actual data rows excluding header for a 5-row CSV and reports live progress', async () => {
    const csv5 = generateCsv(5);

    const res = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send({
        name: '5-Row Test Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1 for {{company_name}}', bodyText: 'Body copy for {{company_name}}' }],
        csvContent: csv5,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          director_full_name: 'Director Full Name',
        },
      });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    const { jobId, campaignId, totalRows } = res.body.data;
    expect(totalRows).toBe(5); // Header excluded!
    expect(jobId).toBeTruthy();
    expect(campaignId).toBeTruthy();

    // Poll until completed
    let job: any;
    const maxRetries = 40;
    for (let i = 0; i < maxRetries; i++) {
      const pollRes = await request(app)
        .get(`/api/v1/campaigns/jobs/${jobId}`)
        .set(authHeader());
      job = pollRes.body.data;
      if (job.status === 'completed' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(job.status).toBe('completed');
    expect(job.totalRows).toBe(5);
    expect(job.processedRows).toBe(5);
    expect(job.importedCount).toBe(5);
    expect(job.skippedCount).toBe(0);
    expect(job.failedRows).toBe(0);
    expect(job.percent).toBe(100);

    // Verify CampaignRecipients created in DB
    const recipients = await CampaignRecipient.find({ campaignId, organizationId: tenant });
    expect(recipients.length).toBe(5);
  });

  it('2. Processes a 50-recipient CSV with live counter progression (Loading recipient X of 50)', async () => {
    const csv50 = generateCsv(50);

    const startRes = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send({
        name: '50-Row Test Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Pitch for {{company_name}}', bodyText: 'Hello {{director_full_name}}' }],
        csvContent: csv50,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          director_full_name: 'Director Full Name',
        },
      });

    expect(startRes.status).toBe(202);
    const { jobId, campaignId, totalRows } = startRes.body.data;
    expect(totalRows).toBe(50);

    // Poll to observe progress progression
    let observedProgressValues: number[] = [];
    let job: any;
    for (let i = 0; i < 120; i++) {
      const pollRes = await request(app)
        .get(`/api/v1/campaigns/jobs/${jobId}`)
        .set(authHeader());
      job = pollRes.body.data;
      observedProgressValues.push(job.processedRows);
      if (job.status === 'completed' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(job.status).toBe('completed');
    expect(job.totalRows).toBe(50);
    expect(job.processedRows).toBe(50);
    expect(job.importedCount).toBe(50);
    expect(job.percent).toBe(100);
    expect(job.message).toBe('Campaign Created Successfully');

    // Confirm that progress values advanced towards 50
    expect(Math.max(...observedProgressValues)).toBe(50);

    // Verify all 50 recipients are stored in MongoDB
    const recipients = await CampaignRecipient.find({ campaignId, organizationId: tenant });
    expect(recipients.length).toBe(50);
  }, 25000);

  it('3. Handles skipped/invalid rows gracefully without failing the entire batch', async () => {
    // 5 recipients: row 2 missing email, row 3 duplicate email
    const csvWithErrors = generateCsv(5, { withSkipped: true, withDuplicates: true });

    const res = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send({
        name: 'Fault-Tolerant Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Greetings', bodyText: 'Proposal' }],
        csvContent: csvWithErrors,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
        },
      });

    const { jobId, campaignId } = res.body.data;

    let job: any;
    for (let i = 0; i < 40; i++) {
      const pollRes = await request(app)
        .get(`/api/v1/campaigns/jobs/${jobId}`)
        .set(authHeader());
      job = pollRes.body.data;
      if (job.status === 'completed' || job.status === 'completed_with_errors' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(job.totalRows).toBe(5);
    expect(job.processedRows).toBe(5);
    expect(job.importedCount).toBe(3); // Rows 1, 4, 5
    expect(job.skippedCount).toBe(2);  // Rows 2 (missing email), 3 (duplicate)
    expect(job.rowErrors.length).toBeGreaterThan(0);

    // All 5 rows persisted (3 pending, 2 skipped)
    const allRecipients = await CampaignRecipient.find({ campaignId, organizationId: tenant });
    expect(allRecipients.length).toBe(5);
    const active = allRecipients.filter((r) => r.status === 'pending');
    const skipped = allRecipients.filter((r) => r.status === 'skipped');
    expect(active.length).toBe(3);
    expect(skipped.length).toBe(2);
  });

  it('4. Prevents duplicate campaign creation on double-click', async () => {
    const csv = generateCsv(10);
    const payload = {
      name: 'Idempotent Campaign',
      mailboxId: mailbox,
      steps: [{ subject: 'Hello', bodyText: 'World' }],
      csvContent: csv,
      columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
    };

    // First click
    const res1 = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send(payload);

    // Immediate second click (simulating double click)
    const res2 = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send(payload);

    // Second request returns the existing in-flight job instead of duplicating
    expect(res2.body.data.jobId).toBe(res1.body.data.jobId);
    expect(res2.body.data.campaignId).toBe(res1.body.data.campaignId);

    // Check DB: exactly one campaign created
    const campaigns = await Campaign.find({ organizationId: tenant, name: 'Idempotent Campaign' });
    expect(campaigns.length).toBe(1);

    // Wait for the background job to finish cleanly
    for (let i = 0; i < 40; i++) {
      const pollRes = await request(app).get(`/api/v1/campaigns/jobs/${res1.body.data.jobId}`).set(authHeader());
      if (pollRes.body.data?.status === 'completed' || pollRes.body.data?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 80));
    }
  }, 15000);

  it('5. Zero-sending verification: confirms NO emails are dispatched during campaign creation', async () => {
    const csv = generateCsv(5);

    const res = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Guaranteed No-Send Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1', bodyText: 'Body' }],
        csvContent: csv,
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    expect(res.status).toBe(201);
    const campaignId = res.body.data.campaignId;

    // Check campaign status: MUST be 'draft'
    const campaign = await Campaign.findById(campaignId);
    expect(campaign?.status).toBe('draft');
    expect(campaign?.stats.sent).toBe(0);

    // Check recipients: ALL must be 'pending'
    const recipients = await CampaignRecipient.find({ campaignId, organizationId: tenant });
    for (const r of recipients) {
      expect(r.status).toBe('pending');
      expect(r.completedSteps).toBe(0);
      for (const sd of r.stepDrafts) {
        expect(sd.status).toBe('pending');
      }
    }

    // Zero EmailSendAttempt records must exist in database!
    const sendAttempts = await EmailSendAttempt.find({ organizationId: tenant });
    expect(sendAttempts.length).toBe(0);
  });

  it('6. Server-Sent Events stream emits real-time progress updates', async () => {
    const csv = generateCsv(4);

    const createRes = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send({
        name: 'SSE Test Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Subject', bodyText: 'Body' }],
        csvContent: csv,
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const { jobId } = createRes.body.data;

    // Connect to SSE stream endpoint
    const streamRes = await request(app)
      .get(`/api/v1/campaigns/jobs/${jobId}/stream`)
      .set(authHeader());

    expect(streamRes.status).toBe(200);
    expect(streamRes.headers['content-type']).toContain('text/event-stream');
    expect(streamRes.text).toContain('data:');
    expect(streamRes.text).toContain('SSE Test Campaign');

    // Wait for the background job to finish cleanly
    for (let i = 0; i < 40; i++) {
      const pollRes = await request(app).get(`/api/v1/campaigns/jobs/${jobId}`).set(authHeader());
      if (pollRes.body.data?.status === 'completed' || pollRes.body.data?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 80));
    }
  }, 15000);

  it('7. Processes larger CSV files (75 rows) efficiently', async () => {
    const csvLarge = generateCsv(75);

    const res = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send({
        name: 'Large Batch Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Scale outreach', bodyText: 'Scaling test' }],
        csvContent: csvLarge,
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const { jobId, campaignId, totalRows } = res.body.data;
    expect(totalRows).toBe(75);

    let job: any;
    for (let i = 0; i < 150; i++) {
      const pollRes = await request(app)
        .get(`/api/v1/campaigns/jobs/${jobId}`)
        .set(authHeader());
      job = pollRes.body.data;
      if (job.status === 'completed' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(job.status).toBe('completed');
    expect(job.totalRows).toBe(75);
    expect(job.processedRows).toBe(75);
    expect(job.importedCount).toBe(75);

    const recipients = await CampaignRecipient.find({ campaignId, organizationId: tenant });
    expect(recipients.length).toBe(75);
  }, 30000);
});

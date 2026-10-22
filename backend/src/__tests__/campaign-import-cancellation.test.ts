import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { CampaignImportJob } from '../models/CampaignImportJob.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { CSVImport } from '../models/CSVImport.js';
import { ensureUploadDir } from '../services/spreadsheet-stream.service.js';

const tenant = 'org_cancellation_test_tenant';
const otherTenant = 'org_other_tenant';
const mailbox = 'outreach@testradar.com';

function authHeader(org: string = tenant, user: string = 'usr_cancel_tester') {
  return {
    'x-organization-id': org,
    'x-user-id': user,
  };
}

describe('Feature: Cancel Import Button & Diagnostics for CSV Imports', () => {
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
      Campaign.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      CampaignRecipient.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      CampaignImportJob.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      Company.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      CompanyContact.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      CompanyAssessment.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      EmailAccount.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      EmailDraft.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      EmailSendAttempt.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      CSVImport.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
    ]);

    await EmailAccount.create({
      organizationId: tenant,
      emailAddress: mailbox,
      displayName: 'Cancel Test Mailbox',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 100,
      sendsToday: 0,
      isPaused: false,
    });
  });

  function generateCsv(count: number): string {
    const lines = [
      'Company Name,Work Email,Director Full Name,Sector,Proposed Deliverable,Step 1 Subject,Step 1 Body',
    ];
    for (let i = 1; i <= count; i++) {
      lines.push(`Cancel Corp ${i},target${i}@canceltest.com,Director ${i},FinTech,Site Audit,Subject ${i},Body ${i}`);
    }
    return lines.join('\n');
  }

  it('1. Cancels active file upload and cleans up chunked upload session directory', async () => {
    // 1. Initialize a chunked upload session
    const initRes = await request(app)
      .post('/api/v1/campaigns/upload/init')
      .set(authHeader())
      .send({
        fileName: 'abort_test.csv',
        fileSize: 20 * 1024 * 1024,
        chunkSize: 10 * 1024 * 1024,
      });

    expect([200, 201]).toContain(initRes.status);
    const uploadId = initRes.body.data.uploadId;
    const sessionDir = path.join(ensureUploadDir(), uploadId);
    expect(fs.existsSync(sessionDir)).toBe(true);

    // 2. Abort the upload via DELETE
    const abortRes = await request(app)
      .delete(`/api/v1/campaigns/upload/${uploadId}`)
      .set(authHeader());

    expect(abortRes.status).toBe(200);
    expect(abortRes.body.success).toBe(true);

    // Verify session folder was removed
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it('2. Cancels an active campaign import job, stops processing, and rolls back partial data', async () => {
    const csvContent = generateCsv(80);

    // 1. Start the campaign creation job
    const startRes = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send({
        name: 'Cancellation Active Job Test',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1 for {{company_name}}', bodyText: 'Body copy for {{company_name}}' }],
        csvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          director_full_name: 'Director Full Name',
        },
      });

    expect(startRes.status).toBe(202);
    const { jobId, campaignId } = startRes.body.data;

    // 2. Request cancellation immediately while job is queued / processing
    const cancelRes = await request(app)
      .post(`/api/v1/campaigns/jobs/${jobId}/cancel`)
      .set(authHeader());

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.success).toBe(true);
    expect(['cancellation_requested', 'cancelling', 'cancelled']).toContain(cancelRes.body.data.status);

    // 3. Poll until job reaches final 'cancelled' state
    let finalJob: any;
    for (let i = 0; i < 30; i++) {
      const pollRes = await request(app)
        .get(`/api/v1/campaigns/jobs/${jobId}`)
        .set(authHeader());
      finalJob = pollRes.body.data;
      if (finalJob.status === 'cancelled') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(finalJob.status).toBe('cancelled');
    expect(finalJob.cancelledAt).toBeTruthy();

    // 4. Verify partial recipients were cleanly rolled back
    const remainingRecipients = await CampaignRecipient.find({ campaignId, organizationId: tenant });
    expect(remainingRecipients.length).toBe(0);

    // 5. Verify the campaign status was updated to cancelled
    const campaign = await Campaign.findById(campaignId);
    expect(campaign?.status).toBe('cancelled');

    // 6. Verify zero-dispatch guarantee: NO drafts or send attempts were queued or sent
    const drafts = await EmailDraft.find({ campaignId });
    expect(drafts.length).toBe(0);
    const sendAttempts = await EmailSendAttempt.find({ campaignId });
    expect(sendAttempts.length).toBe(0);
  });

  it('3. Repeated cancellation requests are idempotent and return 200', async () => {
    const csvContent = generateCsv(20);

    const startRes = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send({
        name: 'Idempotency Test Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1', bodyText: 'Body 1' }],
        csvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
        },
      });

    const { jobId } = startRes.body.data;

    // First cancel
    const cancelRes1 = await request(app)
      .post(`/api/v1/campaigns/jobs/${jobId}/cancel`)
      .set(authHeader());
    expect(cancelRes1.status).toBe(200);

    // Second cancel (repeated)
    const cancelRes2 = await request(app)
      .post(`/api/v1/campaigns/jobs/${jobId}/cancel`)
      .set(authHeader());
    expect(cancelRes2.status).toBe(200);
    expect(cancelRes2.body.success).toBe(true);

    // Third cancel (repeated after finalization)
    await new Promise((r) => setTimeout(r, 300));
    const cancelRes3 = await request(app)
      .post(`/api/v1/campaigns/jobs/${jobId}/cancel`)
      .set(authHeader());
    expect(cancelRes3.status).toBe(200);
    expect(cancelRes3.body.data.status).toBe('cancelled');
  });

  it('4. Rejects cancellation attempts for jobs that already completed', async () => {
    const csvContent = generateCsv(3);

    const startRes = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send({
        name: 'Completed Job Cancel Test',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1', bodyText: 'Body 1' }],
        csvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
        },
      });

    const { jobId } = startRes.body.data;

    // Wait until completed
    for (let i = 0; i < 30; i++) {
      const pollRes = await request(app)
        .get(`/api/v1/campaigns/jobs/${jobId}`)
        .set(authHeader());
      if (pollRes.body.data.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Attempt to cancel completed job
    const cancelRes = await request(app)
      .post(`/api/v1/campaigns/jobs/${jobId}/cancel`)
      .set(authHeader());

    expect(cancelRes.status).toBe(409);
    expect(cancelRes.body.error.code).toBe('JOB_ALREADY_COMPLETED');
  });

  it('5. Prevents cross-tenant cancellation: cannot cancel a job belonging to another organization', async () => {
    const csvContent = generateCsv(5);

    // Create job under otherTenant
    const startRes = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader(otherTenant, 'usr_other_tenant'))
      .send({
        name: 'Other Tenant Campaign',
        mailboxId: 'other@tenant.com',
        steps: [{ subject: 'Step 1', bodyText: 'Body 1' }],
        csvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
        },
      });

    const { jobId } = startRes.body.data;

    // Tenant A attempts to cancel Tenant B's job
    const cancelRes = await request(app)
      .post(`/api/v1/campaigns/jobs/${jobId}/cancel`)
      .set(authHeader(tenant, 'usr_attacker'));

    expect(cancelRes.status).toBe(404);
    expect(cancelRes.body.error.code).toBe('JOB_NOT_FOUND');
  });

  it('6. Preserves shared companies and contacts during cancellation cleanup', async () => {
    // 1. Pre-create a shared company and contact that belongs to this tenant
    const sharedCompany = await Company.create({
      organizationId: tenant,
      name: 'Shared Enterprise Inc',
      domain: 'shared.com',
    });
    const sharedContact = await CompanyContact.create({
      organizationId: tenant,
      companyId: sharedCompany._id,
      email: 'shared_boss@shared.com',
      fullName: 'Shared Boss',
      isPrimary: true,
    });

    // 2. Pre-create another existing campaign that references this shared contact
    const existingCampaign = await Campaign.create({
      organizationId: tenant,
      name: 'Existing Legacy Campaign',
      status: 'draft',
      mailboxId: mailbox,
      steps: [{ stepIndex: 0, subject: 'Hi', bodyText: 'Copy', delayDays: 0 }],
      createdBy: 'usr_cancel_tester',
      stats: { totalRecipients: 1, prepared: 0, sent: 0, failed: 0, skipped: 0 },
    });
    await CampaignRecipient.create({
      organizationId: tenant,
      campaignId: existingCampaign._id,
      rowNumber: 1,
      companyId: sharedCompany._id,
      contactId: sharedContact._id,
      email: 'shared_boss@shared.com',
      companyName: 'Shared Enterprise Inc',
      status: 'pending',
      completedSteps: 0,
      customFields: {},
    });

    // 3. Now start a new import that includes the shared contact plus a new contact
    const csvContent = [
      'Company Name,Work Email,Director Full Name',
      'Shared Enterprise Inc,shared_boss@shared.com,Shared Boss',
      'Exclusive Cancelled Corp,exclusive@cancelled.com,New Person',
    ].join('\n');

    const startRes = await request(app)
      .post('/api/v1/campaigns/jobs')
      .set(authHeader())
      .send({
        name: 'Shared Record Preservation Test',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1', bodyText: 'Body 1' }],
        csvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          director_full_name: 'Director Full Name',
        },
      });

    const { jobId, campaignId } = startRes.body.data;

    // 4. Cancel the import
    const cancelRes = await request(app)
      .post(`/api/v1/campaigns/jobs/${jobId}/cancel`)
      .set(authHeader());

    expect(cancelRes.status).toBe(200);

    // Wait for cancellation cleanup
    for (let i = 0; i < 30; i++) {
      const pollRes = await request(app)
        .get(`/api/v1/campaigns/jobs/${jobId}`)
        .set(authHeader());
      if (pollRes.body.data.status === 'cancelled') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // 5. Shared company and contact MUST STILL EXIST!
    const verifiedCompany = await Company.findById(sharedCompany._id);
    expect(verifiedCompany).not.toBeNull();
    const verifiedContact = await CompanyContact.findById(sharedContact._id);
    expect(verifiedContact).not.toBeNull();

    // The other campaign's recipient MUST STILL EXIST!
    const existingRecipients = await CampaignRecipient.find({ campaignId: existingCampaign._id });
    expect(existingRecipients.length).toBe(1);

    // Cancelled campaign's recipients MUST BE GONE!
    const cancelledRecipients = await CampaignRecipient.find({ campaignId });
    expect(cancelledRecipients.length).toBe(0);
  });

  it('7. Detects stalled jobs and accurately reports stall duration and diagnostics', async () => {
    // Manually create a job with a stale heartbeat from 60 seconds ago
    const campaign = await Campaign.create({
      organizationId: tenant,
      name: 'Stall Detection Campaign',
      status: 'draft',
      mailboxId: mailbox,
      steps: [{ stepIndex: 0, subject: 'Hi', bodyText: 'Body', delayDays: 0 }],
      createdBy: 'usr_cancel_tester',
      stats: { totalRecipients: 0, prepared: 0, sent: 0, failed: 0, skipped: 0 },
    });

    const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
    const stalledJob = await CampaignImportJob.create({
      organizationId: tenant,
      campaignId: campaign._id,
      campaignName: campaign.name,
      fileName: 'stalled.csv',
      status: 'processing',
      phase: 'processing',
      totalRows: 100,
      processedRows: 10,
      committedRows: 10,
      heartbeatAt: sixtySecondsAgo,
    });

    // Poll the status
    const pollRes = await request(app)
      .get(`/api/v1/campaigns/jobs/${stalledJob._id}`)
      .set(authHeader());

    expect(pollRes.status).toBe(200);
    const data = pollRes.body.data;
    expect(data.isStalled).toBe(true);
    expect(data.stallSeconds).toBeGreaterThanOrEqual(55);
    expect(data.message).toContain('Import appears stalled');

    // Cancelling a stalled job works cleanly
    const cancelRes = await request(app)
      .post(`/api/v1/campaigns/jobs/${stalledJob._id}/cancel`)
      .set(authHeader());

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('cancelled');
  });

  it('8. Cancels a general CSV import job via /api/v1/imports/jobs/:id/cancel', async () => {
    // Create an import job
    const csvContent = generateCsv(20);
    const tempFile = path.join(ensureUploadDir(), `general_import_${Date.now()}.csv`);
    fs.writeFileSync(tempFile, csvContent, 'utf8');

    const job = await CSVImport.create({
      organizationId: tenant,
      fileName: 'general_import.csv',
      storedFilePath: tempFile,
      fileBytes: Buffer.byteLength(csvContent),
      headers: ['Company Name', 'Work Email', 'Director Full Name'],
      sampleRows: [],
      totalRows: 20,
      status: 'processing',
      mapping: {
        company_name: 'Company Name',
        contact_email: 'Work Email',
      },
    });

    const cancelRes = await request(app)
      .post(`/api/v1/imports/jobs/${job._id}/cancel`)
      .set(authHeader());

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.success).toBe(true);
    expect(cancelRes.body.data.status).toBe('cancelled');

    // Verify temp file was unlinked
    expect(fs.existsSync(tempFile)).toBe(false);
  });
});

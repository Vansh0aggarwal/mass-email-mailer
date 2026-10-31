import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { CampaignSplitJob } from '../models/CampaignSplitJob.js';
import { CampaignStagingContact } from '../models/CampaignStagingContact.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { Suppression } from '../models/Suppression.js';
import { computeSplitPlan, buildChildCampaignName } from '../services/campaign-split.service.js';
import { writeCsvStringToTempFile } from '../services/spreadsheet-stream.service.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Smart Campaign Splitter', () => {
  let app: any;
  // Unique per run: two suites running against the same database (e.g. a
  // targeted rerun while the full suite is still going) must not delete each
  // other's fixtures mid-generation.
  const runTag = `org_split_${Date.now().toString(36)}_${process.pid}`;
  const tenant = `${runTag}_main`;
  const otherTenant = `${runTag}_other`;
  const actorId = 'usr_split_tester';
  const mailbox = 'splitter@swaniki.dev';
  const cleanupFiles: string[] = [];

  const auth = (org = tenant) => ({
    'x-organization-id': org,
    'x-user-id': actorId,
    'x-user-role': 'owner',
  });

  const basePayload = (uploadId: string, overrides: Record<string, unknown> = {}) => ({
    uploadId,
    fileName: 'prospects.csv',
    groupName: 'QA Batch',
    mailboxId: mailbox,
    columnMapping: {
      company_name: 'Company Name',
      contact_email: 'Contact Email',
    },
    steps: [{ subject: 'Hello {{company_name}}', bodyText: 'Hi there', delayDays: 0 }],
    ...overrides,
  });

  async function createSplitJob(csv: string, overrides: Record<string, unknown> = {}) {
    const temp = await writeCsvStringToTempFile(csv);
    cleanupFiles.push(temp.filePath);
    const res = await request(app)
      .post('/api/v1/campaign-splits')
      .set(auth())
      .send(basePayload(temp.uploadId, overrides));
    return { res, uploadId: temp.uploadId };
  }

  async function waitForJob(
    jobId: string,
    statuses: string[],
    timeoutMs = 60000
  ): Promise<any> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const res = await request(app).get(`/api/v1/campaign-splits/${jobId}`).set(auth());
      if (res.status !== 200) throw new Error(`progress lookup failed: ${res.status} ${JSON.stringify(res.body)}`);
      if (statuses.includes(res.body.data.status)) return res.body.data;
      if (res.body.data.status === 'failed') {
        throw new Error(`job failed: ${res.body.data.errorMessage}`);
      }
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${statuses.join('/')}`);
  }

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    for (const org of [tenant, otherTenant]) {
      await Campaign.deleteMany({ organizationId: org });
      await CampaignRecipient.deleteMany({ organizationId: org });
      await CampaignSplitJob.deleteMany({ organizationId: org });
      await CampaignStagingContact.deleteMany({ organizationId: org });
      await Company.deleteMany({ organizationId: org });
      await CompanyContact.deleteMany({ organizationId: org });
      await CompanyAssessment.deleteMany({ organizationId: org });
      await EmailDraft.deleteMany({ organizationId: org });
      await Suppression.deleteMany({ organizationId: org });
    }

    await Suppression.create({
      organizationId: tenant,
      email: 'blocked@example.com',
      reason: 'unsubscribed',
    });
  }, 60000);

  afterAll(async () => {
    for (const org of [tenant, otherTenant]) {
      await Campaign.deleteMany({ organizationId: org });
      await CampaignRecipient.deleteMany({ organizationId: org });
      await CampaignSplitJob.deleteMany({ organizationId: org });
      await CampaignStagingContact.deleteMany({ organizationId: org });
      await Company.deleteMany({ organizationId: org });
      await CompanyContact.deleteMany({ organizationId: org });
      await CompanyAssessment.deleteMany({ organizationId: org });
      await EmailDraft.deleteMany({ organizationId: org });
      await Suppression.deleteMany({ organizationId: org });
    }
    for (const file of cleanupFiles) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    }
    await disconnectDatabase();
  }, 60000);

  it('computes the documented split arithmetic', () => {
    expect(computeSplitPlan(10000, 100)).toEqual({
      validContacts: 10000,
      contactsPerCampaign: 100,
      expectedCampaigns: 100,
      lastCampaignContacts: 100,
    });
    expect(computeSplitPlan(10000, 200).expectedCampaigns).toBe(50);
    expect(computeSplitPlan(10000, 500).expectedCampaigns).toBe(20);
    expect(computeSplitPlan(10000, 1000).expectedCampaigns).toBe(10);
    expect(computeSplitPlan(10000, 300)).toEqual({
      validContacts: 10000,
      contactsPerCampaign: 300,
      expectedCampaigns: 34,
      lastCampaignContacts: 100,
    });
    expect(computeSplitPlan(0, 100).expectedCampaigns).toBe(0);
    expect(buildChildCampaignName('{group} – Campaign {number}', 'October', 7, 100)).toBe(
      'October – Campaign 007'
    );
  });

  it('analyzes validation buckets, distributes contacts, and never sends automatically', async () => {
    const lines = ['Company Name,Contact Email'];
    for (let i = 1; i <= 20; i++) {
      lines.push(`Company ${String(i).padStart(2, '0')},u${String(i).padStart(2, '0')}@example.com`);
    }
    // 2 duplicates + 1 malformed email + 1 missing email + 1 suppressed.
    lines.push('Duplicate One,u01@example.com');
    lines.push('Duplicate Two,u02@example.com');
    lines.push('Bad Email Row,not-an-email');
    lines.push('Missing Email Row,');
    lines.push('Suppressed Row,blocked@example.com');

    const { res, uploadId } = await createSplitJob(lines.join('\r\n'));
    expect(res.status).toBe(202);
    const jobId = res.body.data.id;
    expect(uploadId).toBeTruthy();

    const ready = await waitForJob(jobId, ['ready']);
    expect(ready.progress.analysis).toMatchObject({
      totalRows: 25,
      processedRows: 25,
      validContacts: 20,
      invalidContacts: 2,
      duplicateContacts: 2,
      suppressedContacts: 1,
      percent: 100,
    });
    expect(ready.hasErrorReport).toBe(true);

    const planRes = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/plan`)
      .set(auth())
      .send({ contactsPerCampaign: 10 });
    expect(planRes.status).toBe(200);
    expect(planRes.body.data.progress.split).toMatchObject({
      validContacts: 20,
      contactsPerCampaign: 10,
      expectedCampaigns: 2,
      lastCampaignContacts: 10,
    });

    const generateRes = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/generate`)
      .set(auth())
      .send({});
    expect(generateRes.status).toBe(202);

    const completed = await waitForJob(jobId, ['completed', 'completed_with_errors']);
    expect(completed.status).toBe('completed');
    expect(completed.progress.generation).toMatchObject({
      expectedCampaigns: 2,
      campaignsCreated: 2,
      contactsAssigned: 20,
      failedCampaigns: 0,
    });

    const campaigns = await Campaign.find({ organizationId: tenant, parentImportId: jobId })
      .sort({ campaignNumber: 1 })
      .lean();
    expect(campaigns).toHaveLength(2);
    expect(campaigns.map((c) => c.name)).toEqual([
      'QA Batch – Campaign 001',
      'QA Batch – Campaign 002',
    ]);
    for (const campaign of campaigns) {
      expect(campaign.status).toBe('draft');
      expect(campaign.schedule).toBeUndefined();
      expect(campaign.groupName).toBe('QA Batch');
      expect(campaign.stats.totalRecipients).toBe(10);
    }

    // Deterministic, non-overlapping distribution in source order.
    const firstRows = await CampaignRecipient.find({ campaignId: campaigns[0]._id })
      .sort({ rowNumber: 1 })
      .select('rowNumber')
      .lean();
    const secondRows = await CampaignRecipient.find({ campaignId: campaigns[1]._id })
      .sort({ rowNumber: 1 })
      .select('rowNumber')
      .lean();
    expect(firstRows.map((r) => r.rowNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(secondRows.map((r) => r.rowNumber)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

    const allRecipients = await CampaignRecipient.find({ organizationId: tenant })
      .select('email')
      .lean();
    expect(allRecipients).toHaveLength(20);
    expect(new Set(allRecipients.map((r) => r.email)).size).toBe(20);

    // Sending safety: no drafts and no send attempts are generated.
    expect(await EmailDraft.countDocuments({ organizationId: tenant })).toBe(0);

    const staged = await CampaignStagingContact.countDocuments({
      jobId,
      status: 'assigned',
    });
    expect(staged).toBe(20);

    const campaignsRes = await request(app)
      .get(`/api/v1/campaign-splits/${jobId}/campaigns`)
      .set(auth());
    expect(campaignsRes.status).toBe(200);
    expect(campaignsRes.body.data.total).toBe(2);

    const errorsRes = await request(app)
      .get(`/api/v1/campaign-splits/${jobId}/errors`)
      .set(auth())
      .buffer(true)
      .parse((res: any, callback: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => callback(null, data));
      });
    expect(errorsRes.status).toBe(200);
    expect(String(errorsRes.body)).toContain('not-an-email');

    // Tenant isolation: another organization cannot read the job.
    const crossTenant = await request(app)
      .get(`/api/v1/campaign-splits/${jobId}`)
      .set(auth(otherTenant));
    expect(crossTenant.status).toBe(404);

    // Idempotent retry: force the completed job back into a retryable state and
    // re-run generation. It must not duplicate campaigns or recipients.
    await CampaignSplitJob.updateOne(
      { _id: jobId },
      { $set: { status: 'completed_with_errors', phase: 'generation' } }
    );
    const retryRes = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/generate`)
      .set(auth())
      .send({});
    expect(retryRes.status).toBe(202);
    await waitForJob(jobId, ['completed', 'completed_with_errors']);

    expect(await Campaign.countDocuments({ organizationId: tenant, parentImportId: jobId })).toBe(2);
    expect(await CampaignRecipient.countDocuments({ organizationId: tenant })).toBe(20);
    expect(
      await CampaignStagingContact.countDocuments({ jobId, status: 'assigned' })
    ).toBe(20);
  }, 90000);

  it('locks the split size once campaign generation has started', async () => {
    const lines = ['Company Name,Contact Email'];
    for (let i = 1; i <= 5; i++) lines.push(`Lock Corp ${i},lock${i}@example.com`);

    const { res } = await createSplitJob(lines.join('\r\n'), { groupName: 'Lock Batch' });
    expect(res.status).toBe(202);
    const jobId = res.body.data.id;
    await waitForJob(jobId, ['ready']);

    const initial = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/plan`)
      .set(auth())
      .send({ contactsPerCampaign: 2 });
    expect(initial.status).toBe(200);

    // Simulate a partially completed generation: contacts are already reserved
    // at 2 per campaign, so renumbering them must be rejected.
    await CampaignSplitJob.updateOne(
      { _id: jobId },
      { $set: { status: 'completed_with_errors', phase: 'generation' } }
    );

    const changed = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/plan`)
      .set(auth())
      .send({ contactsPerCampaign: 3 });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('SPLIT_LOCKED');

    const unchanged = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/plan`)
      .set(auth())
      .send({ contactsPerCampaign: 2 });
    expect(unchanged.status).toBe(200);
  }, 90000);

  it('audits and restores campaign recipients from the import staging rows', async () => {
    const lines = ['Company Name,Contact Email'];
    for (let i = 1; i <= 6; i++) lines.push(`Repair Corp ${i},repair${i}@example.com`);

    const { res } = await createSplitJob(lines.join('\r\n'), { groupName: 'Repair Batch' });
    expect(res.status).toBe(202);
    const jobId = res.body.data.id;
    await waitForJob(jobId, ['ready']);

    const planRes = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/plan`)
      .set(auth())
      .send({ contactsPerCampaign: 3 });
    expect(planRes.status).toBe(200);
    expect(
      await request(app)
        .post(`/api/v1/campaign-splits/${jobId}/generate`)
        .set(auth())
        .send({})
    ).toHaveProperty('status', 202);
    await waitForJob(jobId, ['completed']);

    const campaigns = await Campaign.find({ organizationId: tenant, parentImportId: jobId })
      .sort({ campaignNumber: 1 })
      .lean();
    expect(campaigns).toHaveLength(2);
    expect(await CampaignRecipient.countDocuments({ organizationId: tenant, campaignId: { $in: campaigns.map((c) => c._id) } })).toBe(6);

    // Simulate the incident this feature exists for: recipients and the
    // denormalized campaign total are lost while the import is intact.
    const lost = await CampaignRecipient.find({ campaignId: campaigns[0]._id })
      .sort({ rowNumber: 1 })
      .limit(2)
      .select('_id')
      .lean();
    await CampaignRecipient.deleteMany({ _id: { $in: lost.map((row) => row._id) } });
    await Campaign.updateOne({ _id: campaigns[0]._id }, { $set: { 'stats.totalRecipients': 3 } });

    const auditRes = await request(app)
      .get(`/api/v1/campaign-splits/${jobId}/recipients/integrity`)
      .set(auth());
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.data).toMatchObject({
      expectedRecipients: 6,
      actualRecipients: 4,
      missingRecipients: 2,
      campaignsWithDrift: 1,
      campaignsWithStatsDrift: 1,
      repaired: false,
    });

    // Cross-tenant repair is not possible.
    const crossTenant = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/recipients/repair`)
      .set(auth(otherTenant));
    expect(crossTenant.status).toBe(404);

    const repairRes = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/recipients/repair`)
      .set(auth());
    expect(repairRes.status).toBe(200);
    expect(repairRes.body.data).toMatchObject({
      expectedRecipients: 6,
      actualRecipients: 6,
      missingRecipients: 0,
      campaignsWithStatsDrift: 0,
      repaired: true,
      repairedCampaigns: 1,
      repairedRecipients: 2,
    });

    const restored = await CampaignRecipient.find({ campaignId: campaigns[0]._id })
      .sort({ rowNumber: 1 })
      .select('rowNumber email addedBy')
      .lean();
    expect(restored.map((row) => row.rowNumber)).toEqual([1, 2, 3]);
    expect(restored.every((row) => row.addedBy === actorId)).toBe(true);
    const campaignAfter = await Campaign.findById(campaigns[0]._id).select('stats').lean();
    expect(campaignAfter?.stats?.totalRecipients).toBe(3);
    expect(
      await CampaignStagingContact.countDocuments({ jobId, status: 'assigned' })
    ).toBe(6);

    // Idempotent: a second repair finds nothing to restore.
    const secondRepair = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/recipients/repair`)
      .set(auth());
    expect(secondRepair.status).toBe(200);
    expect(secondRepair.body.data).toMatchObject({
      repaired: false,
      repairedCampaigns: 0,
      repairedRecipients: 0,
      missingRecipients: 0,
    });
  }, 90000);

  it('creates exactly 100 child campaigns for 10,000 valid contacts at 100 per campaign', async () => {
    const lines = ['Company Name,Contact Email'];
    for (let i = 1; i <= 10000; i++) {
      lines.push(`Scale Corp ${i},scale${i}@split-scale.test`);
    }

    const { res } = await createSplitJob(lines.join('\r\n'), {
      groupName: 'Scale Batch',
    });
    expect(res.status).toBe(202);
    const jobId = res.body.data.id;

    const ready = await waitForJob(jobId, ['ready'], 120000);
    expect(ready.progress.analysis.validContacts).toBe(10000);

    const planRes = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/plan`)
      .set(auth())
      .send({ contactsPerCampaign: 100 });
    expect(planRes.status).toBe(200);
    expect(planRes.body.data.progress.split.expectedCampaigns).toBe(100);
    expect(planRes.body.data.progress.split.lastCampaignContacts).toBe(100);

    const generateRes = await request(app)
      .post(`/api/v1/campaign-splits/${jobId}/generate`)
      .set(auth())
      .send({});
    expect(generateRes.status).toBe(202);

    const completed = await waitForJob(jobId, ['completed', 'completed_with_errors'], 180000);
    expect(completed.status).toBe('completed');
    expect(completed.progress.generation.campaignsCreated).toBe(100);
    expect(completed.progress.generation.contactsAssigned).toBe(10000);

    const campaigns = await Campaign.find({ organizationId: tenant, parentImportId: jobId })
      .sort({ campaignNumber: 1 })
      .select('campaignNumber name stats')
      .lean();
    expect(campaigns).toHaveLength(100);
    expect(campaigns[0].name).toBe('Scale Batch – Campaign 001');
    expect(campaigns[99].name).toBe('Scale Batch – Campaign 100');
    expect(campaigns.every((c) => c.stats.totalRecipients === 100)).toBe(true);

    expect(
      await CampaignRecipient.countDocuments({
        organizationId: tenant,
        campaignId: { $in: campaigns.map((c) => c._id) },
      })
    ).toBe(10000);

    // Contact #1..100 live in campaign 001; #9901..10000 in campaign 100.
    const first = await CampaignRecipient.find({ campaignId: campaigns[0]._id })
      .sort({ rowNumber: 1 })
      .select('rowNumber')
      .lean();
    const last = await CampaignRecipient.find({ campaignId: campaigns[99]._id })
      .sort({ rowNumber: 1 })
      .select('rowNumber')
      .lean();
    expect(first[0].rowNumber).toBe(1);
    expect(first[99].rowNumber).toBe(100);
    expect(last[0].rowNumber).toBe(9901);
    expect(last[99].rowNumber).toBe(10000);

    const distinctEmails = await CampaignRecipient.distinct('email', {
      organizationId: tenant,
      campaignId: { $in: campaigns.map((c) => c._id) },
    });
    expect(distinctEmails).toHaveLength(10000);
  }, 240000);
});

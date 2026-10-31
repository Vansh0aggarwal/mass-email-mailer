import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { User } from '../models/User.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { CampaignImportJob } from '../models/CampaignImportJob.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { CSVImport } from '../models/CSVImport.js';
import { EmailAccount } from '../models/EmailAccount.js';

const ORG_A = 'ownership-org-a';
const ORG_B = 'ownership-org-b';
const MAILBOX = 'ownership@swaniki.dev';

let app: Express;
let userA: InstanceType<typeof User>;
let userB: InstanceType<typeof User>;
let outsider: InstanceType<typeof User>;

function headers(user: { _id: unknown }, org = ORG_A): Record<string, string> {
  return { 'x-organization-id': org, 'x-user-id': String(user._id) };
}

function campaignPayload(name: string, rows: string[][]): Record<string, unknown> {
  const csv = [
    'Company,Email,Domain',
    ...rows.map((row) => row.join(',')),
  ].join('\n');

  return {
    name,
    mailboxId: MAILBOX,
    steps: [{ subject: 'Hello {{company_name}}', bodyText: 'Hi {{contact_first_name}}' }],
    csvContent: csv,
    columnMapping: {
      company_name: 'Company',
      contact_email: 'Email',
      domain: 'Domain',
    },
    senderName: 'Ownership Tester',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForImportJob(jobId: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/v1/imports/jobs/${jobId}`).set(headers(userA));
    last = res.body?.data;
    if (last && !['queued', 'processing', 'pending'].includes(last.status)) return last;
    await sleep(75);
  }
  throw new Error(`Import job ${jobId} did not finish (last status: ${last?.status})`);
}

describe('Creator and ownership tracking', () => {
  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    await Promise.all([
      Campaign.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CampaignRecipient.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CampaignImportJob.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      Company.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CompanyContact.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CompanyAssessment.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CSVImport.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      EmailAccount.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      User.deleteMany({ email: /@ownership\.test$/ }),
    ]);

    [userA, userB, outsider] = await Promise.all([
      User.create({
        email: 'alice@ownership.test',
        fullName: 'Alice Owner',
        organizations: [{ organizationId: ORG_A, role: 'owner' }],
      }),
      User.create({
        email: 'bob@ownership.test',
        fullName: 'Bob Seller',
        organizations: [{ organizationId: ORG_A, role: 'manager' }],
      }),
      User.create({
        email: 'carl@ownership.test',
        fullName: 'Carl Outsider',
        organizations: [{ organizationId: ORG_B, role: 'owner' }],
      }),
    ]);

    await EmailAccount.create({
      organizationId: ORG_A,
      emailAddress: MAILBOX,
      displayName: 'Ownership',
      provider: 'mock',
      status: 'connected',
      isPaused: false,
      dailySendLimit: 100,
      sendsToday: 0,
    });
  });

  afterAll(async () => {
    await Promise.all([
      Campaign.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CampaignRecipient.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CampaignImportJob.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      Company.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CompanyContact.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CompanyAssessment.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      CSVImport.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      EmailAccount.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } }),
      User.deleteMany({ email: /@ownership\.test$/ }),
    ]);
    await disconnectDatabase();
  });

  it('records the authenticated creator on manual company creation and exposes it', async () => {
    const res = await request(app)
      .post('/api/v1/companies')
      .set(headers(userA))
      .send({ name: 'Manual Co', domain: 'manual.example.com' });

    expect(res.status).toBe(201);
    expect(res.body.data.createdBy).toBe(String(userA._id));
    expect(res.body.data.createdVia).toBe('manual');
    expect(res.body.data.createdByUser.fullName).toBe('Alice Owner');
    expect(res.body.data.createdByUser.email).toBe('alice@ownership.test');

    const listRes = await request(app).get('/api/v1/companies?q=Manual').set(headers(userB));
    expect(listRes.status).toBe(200);
    expect(listRes.body.data[0].createdByUser.fullName).toBe('Alice Owner');

    const detailRes = await request(app)
      .get(`/api/v1/companies/${res.body.data._id}`)
      .set(headers(userB));
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.createdByUser.fullName).toBe('Alice Owner');
  });

  it('never overwrites the original creator or source when a company is updated', async () => {
    const created = await request(app)
      .post('/api/v1/companies')
      .set(headers(userA))
      .send({ name: 'Stable Co', domain: 'stable.example.com' });

    const updated = await request(app)
      .put(`/api/v1/companies/${created.body.data._id}`)
      .set(headers(userB))
      .send({ industry: 'Software', domain: 'stable.example.com' });

    expect(updated.status).toBe(200);
    expect(updated.body.data.createdBy).toBe(String(userA._id));
    expect(updated.body.data.createdVia).toBe('manual');
    expect(updated.body.data.industry).toBe('Software');

    const stored = await Company.findById(created.body.data._id).lean();
    expect(stored!.createdBy).toBe(String(userA._id));
    expect(stored!.createdVia).toBe('manual');
  });

  it('attributes CSV-committed companies to the importer and preserves them on re-import', async () => {
    const csvContent = [
      'Organization,Domain,Contact',
      'Imported Co,imported.example.com,sales@imported.example.com',
    ].join('\n');

    const preview = await request(app)
      .post('/api/v1/imports/preview')
      .set(headers(userB))
      .send({
        csvContent,
        mapping: {
          company_name: 'Organization',
          domain: 'Domain',
          contact_email: 'Contact',
        },
      });
    expect(preview.status).toBe(200);

    const firstCommit = await request(app)
      .post('/api/v1/imports/commit')
      .set(headers(userB))
      .send({
        fileName: 'imported.csv',
        rows: preview.body.data.summary.parsedRows,
        mapping: { company_name: 'Organization' },
      });
    expect(firstCommit.status).toBe(201);

    const stored = await Company.findOne({
      organizationId: ORG_A,
      domain: 'imported.example.com',
    }).lean();
    expect(stored!.createdBy).toBe(String(userB._id));
    expect(stored!.createdVia).toBe('csv_import');

    // Re-import with the update strategy as a different user: existing
    // ownership must survive untouched.
    const rePreview = await request(app)
      .post('/api/v1/imports/preview')
      .set(headers(userA))
      .send({
        csvContent,
        mapping: {
          company_name: 'Organization',
          domain: 'Domain',
          contact_email: 'Contact',
        },
      });
    const secondCommit = await request(app)
      .post('/api/v1/imports/commit')
      .set(headers(userA))
      .send({
        fileName: 'imported.csv',
        rows: rePreview.body.data.summary.parsedRows,
        mapping: { company_name: 'Organization' },
        duplicateStrategy: 'update',
      });
    expect(secondCommit.status).toBe(201);
    expect(secondCommit.body.data.updatedCount).toBe(1);

    const afterUpdate = await Company.findOne({
      organizationId: ORG_A,
      domain: 'imported.example.com',
    }).lean();
    expect(afterUpdate!.createdBy).toBe(String(userB._id));
    expect(afterUpdate!.createdVia).toBe('csv_import');
  });

  it('attributes streamed background imports to the uploader even when another user retries', async () => {
    const csv = [
      'Company Name,Work Email,Domain',
      'Stream One,one@stream.example.com,one.stream.example.com',
      'Stream Two,two@stream.example.com,two.stream.example.com',
    ].join('\r\n');

    const upload = await request(app)
      .post('/api/v1/imports/jobs')
      .set(headers(userA))
      .attach('file', Buffer.from(csv, 'utf8'), 'stream.csv');
    expect(upload.status).toBe(201);
    const jobId = upload.body.data.jobId;

    const storedJob = await CSVImport.findById(jobId).lean();
    expect(storedJob!.createdBy).toBe(String(userA._id));

    const start = await request(app)
      .post(`/api/v1/imports/jobs/${jobId}/start`)
      .set(headers(userA))
      .send({});
    expect(start.status).toBe(202);
    const finished = await waitForImportJob(jobId);
    expect(finished.status).toBe('completed');

    const both = await Company.find({ organizationId: ORG_A, domain: /\.stream\.example\.com$/ }).lean();
    expect(both).toHaveLength(2);
    for (const company of both) {
      expect(company.createdBy).toBe(String(userA._id));
      expect(company.createdVia).toBe('csv_import');
    }

    // Simulate an interruption after the first row, then retry as Bob. The
    // replay must be attributed to Alice, the original actor.
    await Company.deleteOne({ organizationId: ORG_A, domain: 'two.stream.example.com' });
    await CSVImport.updateOne(
      { _id: jobId },
      { $set: { status: 'failed', lastProcessedRow: 1, processedRows: 1, importedCount: 1 } }
    );

    const retry = await request(app)
      .post(`/api/v1/imports/jobs/${jobId}/retry`)
      .set(headers(userB));
    expect(retry.status).toBe(202);
    const retried = await waitForImportJob(jobId);
    expect(['completed', 'completed_with_errors']).toContain(retried.status);

    const replayed = await Company.findOne({
      organizationId: ORG_A,
      domain: 'two.stream.example.com',
    }).lean();
    expect(replayed!.createdBy).toBe(String(userA._id));
  });

  it('records the campaign creator and keeps it through edits and scheduling', async () => {
    const res = await request(app)
      .post('/api/v1/campaigns')
      .set(headers(userA))
      .send(campaignPayload('Creator Campaign', [['Creator Co', 'ada@creator.example.com', 'creator.example.com']]));
    expect(res.status).toBe(201);

    const campaignId = res.body.data.campaignId;
    const campaign = await Campaign.findById(campaignId).lean();
    expect(campaign!.createdBy).toBe(String(userA._id));

    const detail = await request(app)
      .get(`/api/v1/campaigns/${campaignId}`)
      .set(headers(userB));
    expect(detail.status).toBe(200);
    expect(detail.body.data.createdByUser.fullName).toBe('Alice Owner');

    const list = await request(app).get('/api/v1/campaigns').set(headers(userB));
    expect(list.status).toBe(200);
    expect(list.body.data.find((c: any) => c._id === campaignId).createdByUser.fullName).toBe('Alice Owner');

    await request(app)
      .patch(`/api/v1/campaigns/${campaignId}/schedule-settings`)
      .set(headers(userB))
      .send({ schedule: { timezone: 'UTC', windowStartHour: 9, windowEndHour: 17 } });

    const afterEdit = await Campaign.findById(campaignId).lean();
    expect(afterEdit!.createdBy).toBe(String(userA._id));
  });

  it('tags recipients with the actor who added them, not the campaign creator', async () => {
    const created = await request(app)
      .post('/api/v1/campaigns')
      .set(headers(userA))
      .send(campaignPayload('Tag Campaign', [['Tag Co', 'tag@tag.example.com', 'tag.example.com']]));
    expect(created.status).toBe(201);
    const campaignId = created.body.data.campaignId;

    const recipients = await CampaignRecipient.find({ campaignId }).lean();
    expect(recipients).toHaveLength(1);
    expect(recipients[0].addedBy).toBe(String(userA._id));
    expect(recipients[0].addedAt).toBeInstanceOf(Date);

    // A different user adds the same company to their own campaign.
    const second = await request(app)
      .post('/api/v1/campaigns')
      .set(headers(userB))
      .send(campaignPayload('Second Campaign', [['Tag Co', 'tag@tag.example.com', 'tag.example.com']]));
    expect(second.status).toBe(201);
    const secondId = second.body.data.campaignId;

    const secondRecipients = await CampaignRecipient.find({ campaignId: secondId }).lean();
    expect(secondRecipients).toHaveLength(1);
    expect(secondRecipients[0].addedBy).toBe(String(userB._id));
    expect(String(secondRecipients[0].companyId)).toBe(String(recipients[0].companyId));

    // Operational changes must not rewrite the audit fields.
    const recipientId = String(recipients[0]._id);
    await request(app)
      .post(`/api/v1/campaigns/${campaignId}/recipients/${recipientId}/generate`)
      .set(headers(userB))
      .send({ senderName: 'Bob Seller' });

    const afterGenerate = await CampaignRecipient.findById(recipientId).lean();
    expect(afterGenerate!.addedBy).toBe(String(userA._id));
    expect(afterGenerate!.addedAt).toEqual(recipients[0].addedAt);

    const listRes = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/recipients`)
      .set(headers(userB));
    expect(listRes.status).toBe(200);
    const row = listRes.body.data.recipients.find((r: any) => r._id === recipientId);
    expect(row.addedByUser.fullName).toBe('Alice Owner');

    const exportRes = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/export`)
      .set(headers(userB));
    expect(exportRes.status).toBe(200);
    expect(exportRes.text).toContain('Added By');
    expect(exportRes.text).toContain('Alice Owner');
  });

  it('keeps legacy rows without ownership fields readable and unassigned', async () => {
    const legacyCompany = await Company.create({
      organizationId: ORG_A,
      name: 'Legacy Company',
      domain: 'legacy.example.com',
    });
    expect(legacyCompany.createdBy).toBeUndefined();
    expect(legacyCompany.createdVia).toBeUndefined();

    const legacyCampaign = await Campaign.create({
      organizationId: ORG_A,
      name: 'Legacy Campaign',
      createdBy: String(userA._id),
      mailboxId: MAILBOX,
      steps: [{ stepIndex: 0, subject: 'Hi', bodyText: 'Hello' }],
    });

    const legacyRecipient = await CampaignRecipient.create({
      organizationId: ORG_A,
      campaignId: legacyCampaign._id,
      rowNumber: 1,
      email: 'legacy@legacy.example.com',
      companyName: 'Legacy Company',
      status: 'pending',
    });
    expect(legacyRecipient.addedBy).toBeUndefined();

    const companies = await request(app).get('/api/v1/companies?q=Legacy').set(headers(userA));
    expect(companies.status).toBe(200);
    const legacyRow = companies.body.data.find((c: any) => c._id === String(legacyCompany._id));
    expect(legacyRow.createdByUser).toBeNull();

    const recipients = await request(app)
      .get(`/api/v1/campaigns/${legacyCampaign._id}/recipients`)
      .set(headers(userA));
    expect(recipients.status).toBe(200);
    const legacyRecipientRow = recipients.body.data.recipients.find(
      (r: any) => r._id === String(legacyRecipient._id)
    );
    expect(legacyRecipientRow.addedByUser).toBeNull();
  });

  it('keeps campaigns visible to the whole org but hidden across tenants', async () => {
    const created = await request(app)
      .post('/api/v1/campaigns')
      .set(headers(userA))
      .send(campaignPayload('Tenant Campaign', [['Tenant Co', 'tenant@tenant.example.com', 'tenant.example.com']]));
    const campaignId = created.body.data.campaignId;

    const sameOrg = await request(app).get(`/api/v1/campaigns/${campaignId}`).set(headers(userB));
    expect(sameOrg.status).toBe(200);

    const crossTenant = await request(app)
      .get(`/api/v1/campaigns/${campaignId}`)
      .set(headers(outsider, ORG_B));
    expect(crossTenant.status).toBe(404);

    const crossTenantRecipients = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/recipients`)
      .set(headers(outsider, ORG_B));
    expect(crossTenantRecipients.status).toBe(404);

    // A stored id belonging to another org must never resolve a profile.
    const outsiderView = await request(app)
      .get('/api/v1/campaigns')
      .set(headers(outsider, ORG_B));
    expect(outsiderView.status).toBe(200);
    expect(outsiderView.body.data).toHaveLength(0);
  });
});

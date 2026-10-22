import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { Suppression } from '../models/Suppression.js';

const tenant = 'org_test_lifecycle_tenant';
const mailbox = 'outreach@lifecycletest.com';

function authHeader() {
  return {
    'x-organization-id': tenant,
    'x-user-id': 'usr_test_lifecycle_actor',
  };
}

describe('Critical Bug Fix: Campaign Recipient & Draft Lifecycle Suite', () => {
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
      Company.deleteMany({ organizationId: tenant }),
      CompanyContact.deleteMany({ organizationId: tenant }),
      EmailDraft.deleteMany({ organizationId: tenant }),
      EmailAccount.deleteMany({ organizationId: tenant }),
      Suppression.deleteMany({ organizationId: tenant }),
    ]);

    await EmailAccount.create({
      organizationId: tenant,
      emailAddress: mailbox,
      displayName: 'Lifecycle Test Mailbox',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 50,
      sendsToday: 0,
      isPaused: false,
    });
  });

  afterEach(async () => {
    await Promise.all([
      Campaign.deleteMany({ organizationId: tenant }),
      CampaignRecipient.deleteMany({ organizationId: tenant }),
      Company.deleteMany({ organizationId: tenant }),
      CompanyContact.deleteMany({ organizationId: tenant }),
      EmailDraft.deleteMany({ organizationId: tenant }),
      EmailAccount.deleteMany({ organizationId: tenant }),
      Suppression.deleteMany({ organizationId: tenant }),
    ]);
  });

  it('Phase 1 & 2: Pre-existing CRM contacts are attached to the campaign and NOT skipped as duplicates', async () => {
    // 1. Pre-seed a company and contact in the CRM
    const existingCompany = await Company.create({
      organizationId: tenant,
      name: 'PreExisting Corp',
      domain: 'preexisting.com',
    });
    const existingContact = await CompanyContact.create({
      organizationId: tenant,
      companyId: existingCompany._id,
      email: 'lead@preexisting.com',
      firstName: 'Alice',
    });

    // 2. Create a campaign with a CSV containing this contact
    const csvContent =
      'Company Name,Work Email,First Name\n' +
      'PreExisting Corp,lead@preexisting.com,Alice\n' +
      'Brand New Ltd,bob@brandnew.com,Bob\n';

    const res = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'CRM Reuse Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Hello {{contact_first_name}}', bodyText: 'Checking in with {{company_name}}' }],
        csvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          contact_first_name: 'First Name',
        },
      });

    expect(res.status).toBe(201);
    const campaignId = res.body.data.campaignId;

    // Both rows must be accepted (0 skipped)
    expect(res.body.data.summary.recipientsCreated).toBe(2);

    // Verify CampaignRecipient records in MongoDB
    const recipients = await CampaignRecipient.find({ organizationId: tenant, campaignId }).sort({ rowNumber: 1 });
    expect(recipients).toHaveLength(2);
    expect(recipients[0].status).toBe('pending');
    expect(recipients[0].email).toBe('lead@preexisting.com');
    // Pre-existing IDs were reused!
    expect(recipients[0].companyId?.toString()).toBe(existingCompany._id.toString());
    expect(recipients[0].contactId?.toString()).toBe(existingContact._id.toString());

    expect(recipients[1].status).toBe('pending');
    expect(recipients[1].email).toBe('bob@brandnew.com');
  });

  it('Phase 3 & 4: Ineligible / skipped records are persisted, diagnosable, and counted correctly in statistics', async () => {
    // CSV with 9 rows:
    // - Row 1: Valid
    // - Row 2: Missing company name (validation error)
    // - Row 3: Invalid email format
    // - Row 4: Missing contact email
    // - Row 5: Duplicate of Row 1 in this campaign
    // - Row 6: Suppressed email
    // - Row 7: Valid
    // - Row 8: Valid
    // - Row 9: Duplicate of Row 7 in this campaign

    await Suppression.create({
      organizationId: tenant,
      email: 'suppressed@domain.com',
      reason: 'unsubscribed',
    });

    const csvContent =
      'Company Name,Work Email,First Name\n' +
      'Company One,one@domain.com,User1\n' +
      ',two@domain.com,User2\n' +
      'Company Three,invalid-email-address,User3\n' +
      'Company Four,,User4\n' +
      'Company One Duplicate,one@domain.com,User1\n' +
      'Company Six,suppressed@domain.com,User6\n' +
      'Company Seven,seven@domain.com,User7\n' +
      'Company Eight,eight@domain.com,User8\n' +
      'Company Seven Duplicate,seven@domain.com,User7\n';

    const res = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: '9-Row Diagnostic Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Intro {{company_name}}', bodyText: 'Body' }],
        csvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          contact_first_name: 'First Name',
        },
      });

    expect(res.status).toBe(201);
    const campaignId = res.body.data.campaignId;

    // Verify stats
    const campaign = await Campaign.findById(campaignId);
    expect(campaign).not.toBeNull();
    expect(campaign?.stats.totalRecipients).toBe(9);
    expect(campaign?.stats.skipped).toBe(6); // 1 missing company name + 1 invalid email + 1 missing email + 2 duplicates + 1 suppressed = 6

    // Verify all 9 recipients are persisted and returned via API
    const recRes = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/recipients?limit=20`)
      .set(authHeader());

    expect(recRes.status).toBe(200);
    expect(recRes.body.data.total).toBe(9);
    expect(recRes.body.data.recipients).toHaveLength(9);

    const recs = recRes.body.data.recipients;

    // Check specific rows and reasons
    const row2 = recs.find((r: any) => r.rowNumber === 2);
    expect(row2.status).toBe('skipped');
    expect(row2.skipReason).toContain('Company name is required');
    expect(row2.canRetry).toBe(true);

    const row3 = recs.find((r: any) => r.rowNumber === 3);
    expect(row3.status).toBe('skipped');
    expect(row3.skipReason).toContain('Invalid email');

    const row5 = recs.find((r: any) => r.rowNumber === 5);
    expect(row5.status).toBe('skipped');
    expect(row5.skipReason).toContain('Duplicate recipient email');

    const row6 = recs.find((r: any) => r.rowNumber === 6);
    expect(row6.status).toBe('suppressed');
    expect(row6.skipReason).toContain('suppression list');

    // Progress endpoint returns live aggregated metrics
    const progRes = await request(app).get(`/api/v1/campaigns/${campaignId}/progress`).set(authHeader());
    expect(progRes.status).toBe(200);
    expect(progRes.body.data.totalRecipients).toBe(9);
    expect(progRes.body.data.skipped).toBe(6);
    expect(progRes.body.data.byStatus.pending).toBe(3);
  });

  it('Phase 5: Draft approval synchronizes with CampaignRecipient and enables sending', async () => {
    // 1. Create campaign with 2 valid recipients
    const csvContent =
      'Company Name,Work Email,First Name\n' +
      'Alpha Corp,alpha@test.com,Alpha\n' +
      'Beta Corp,beta@test.com,Beta\n';

    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Approval Sync Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Subject for {{company_name}}', bodyText: 'Hi {{contact_first_name}}' }],
        csvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          contact_first_name: 'First Name',
        },
      });

    const campaignId = createRes.body.data.campaignId;

    // 2. Generate drafts batch
    const genRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/generate`)
      .set(authHeader())
      .send({ batchSize: 10 });

    expect(genRes.status).toBe(200);
    expect(genRes.body.data.processed).toBe(2);

    // Verify drafts exist in MongoDB and have campaignId and recipientId
    const drafts = await EmailDraft.find({ organizationId: tenant, campaignId });
    expect(drafts).toHaveLength(2);
    expect(drafts[0].campaignId?.toString()).toBe(campaignId);
    expect(drafts[0].recipientId).toBeDefined();
    expect(drafts[0].status).toBe('draft');

    // 3. Approve individual draft via POST /api/v1/drafts/:id/approve
    const appRes = await request(app)
      .post(`/api/v1/drafts/${drafts[0]._id}/approve`)
      .set(authHeader())
      .send();

    expect(appRes.status).toBe(200);
    expect(appRes.body.data.status).toBe('approved');

    // Recipient 0 must now be 'approved' in CampaignRecipient!
    const recipient0 = await CampaignRecipient.findById(drafts[0].recipientId);
    expect(recipient0?.status).toBe('approved');
    expect(recipient0?.stepDrafts[0].status).toBe('approved');

    // 4. Approve all remaining via POST /api/v1/campaigns/:id/approve
    const appAllRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/approve`)
      .set(authHeader())
      .send({});

    expect(appAllRes.status).toBe(200);

    const allApproved = await CampaignRecipient.find({ organizationId: tenant, campaignId, status: 'approved' });
    expect(allApproved).toHaveLength(2);

    // 5. Send batch via POST /api/v1/campaigns/:id/send
    const sendRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/send`)
      .set(authHeader())
      .send({ batchSize: 10 });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.data.processed).toBe(2);

    // Both recipients should now be 'sent'
    const sentRecipients = await CampaignRecipient.find({ organizationId: tenant, campaignId, status: 'sent' });
    expect(sentRecipients).toHaveLength(2);
    expect(sentRecipients[0].completedSteps).toBe(1);
    expect(sentRecipients[0].stepDrafts[0].status).toBe('sent');
    expect(sentRecipients[0].stepDrafts[0].providerMessageId).toBeDefined();

    // Live progress confirms 2 sent
    const progress = await request(app).get(`/api/v1/campaigns/${campaignId}/progress`).set(authHeader());
    expect(progress.body.data.sent).toBe(2);
    expect(progress.body.data.totalRecipients).toBe(2);
  });

  it('Phase 6: Retrying a skipped record revalidates and requeues it only after correcting errors', async () => {
    // 1. Create a campaign with an invalid email
    const csvContent =
      'Company Name,Work Email,First Name\n' +
      'Correction Tech,bad-email-format,Charlie\n';

    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Retry Requeue Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Test', bodyText: 'Body' }],
        csvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          contact_first_name: 'First Name',
        },
      });

    const campaignId = createRes.body.data.campaignId;
    const recipient = await CampaignRecipient.findOne({ organizationId: tenant, campaignId });
    expect(recipient?.status).toBe('skipped');

    // 2. Attempting to retry directly without fixing email fails with 400
    const retryFailRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/recipients/${recipient?._id}/retry`)
      .set(authHeader())
      .send();

    expect(retryFailRes.status).toBe(400);
    expect(retryFailRes.body.error.message).toContain('invalid');

    // 3. Update the email to a valid one via PATCH
    const patchRes = await request(app)
      .patch(`/api/v1/campaigns/${campaignId}/recipients/${recipient?._id}`)
      .set(authHeader())
      .send({ email: 'charlie.corrected@domain.com' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.email).toBe('charlie.corrected@domain.com');

    // 4. Now retry succeeds
    const retrySuccessRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/recipients/${recipient?._id}/retry`)
      .set(authHeader())
      .send();

    expect(retrySuccessRes.status).toBe(200);
    expect(retrySuccessRes.body.data.status).toBe('pending');
    expect(retrySuccessRes.body.data.skipReason).toBeUndefined();

    // Verify DB
    const fresh = await CampaignRecipient.findById(recipient?._id);
    expect(fresh?.status).toBe('pending');
    expect(fresh?.email).toBe('charlie.corrected@domain.com');
  });
});

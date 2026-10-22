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

const tenant = 'org_regression_suite_tenant';
const otherTenant = 'org_other_suite_tenant';
const mailbox = 'outreach@regressionsuite.com';

function authHeader(org: string = tenant, user: string = 'usr_regression_actor') {
  return {
    'x-organization-id': org,
    'x-user-id': user,
  };
}

describe('Regression Suite: Draft Generation & Step 1/2/3 Sending', () => {
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
      Company.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      CompanyContact.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      EmailDraft.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      EmailAccount.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
      Suppression.deleteMany({ organizationId: { $in: [tenant, otherTenant] } }),
    ]);

    await EmailAccount.create({
      organizationId: tenant,
      emailAddress: mailbox,
      displayName: 'Regression Mailbox',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 100,
      sendsToday: 0,
      isPaused: false,
    });
  });

  const sampleCsvContent = [
    'Company Name,Work Email,Director Full Name,Sector,Proposed Deliverable,Step 1 Subject,Step 1 Body,Step 2 Subject,Step 2 Body,Step 3 Subject,Step 3 Body',
    'AYYAN GLOBAL PRIVATE LIMITED,ayyan@ayyan.com,Ayyan Management,Retail / D2C,Headless Shopify Storefront,Question re: AYYAN GLOBAL digital infrastructure,"Hi Ayyan, congratulations on your recent incorporation.",Re: Question re: AYYAN GLOBAL,"Following up on our earlier note.",AYYAN GLOBAL digital roadmap,"Are you still exploring custom software?"',
  ].join('\n');

  it('1. maps CSV Step 1/2/3 fields correctly onto CampaignRecipient customFields', async () => {
    const res = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Step Mapping Campaign',
        mailboxId: mailbox,
        steps: [
          { subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 },
          { subject: '{{step_2_subject}}', bodyText: '{{step_2_body}}', delayDays: 3 },
          { subject: '{{step_3_subject}}', bodyText: '{{step_3_body}}', delayDays: 4 },
        ],
        csvContent: sampleCsvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          contact_full_name: 'Director Full Name',
          sector: 'Sector',
          proposed_deliverable: 'Proposed Deliverable',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
          step_2_subject: 'Step 2 Subject',
          step_2_body: 'Step 2 Body',
          step_3_subject: 'Step 3 Subject',
          step_3_body: 'Step 3 Body',
        },
      });

    expect(res.status).toBe(201);
    const campaignId = res.body.data.campaignId;

    const recipient = await CampaignRecipient.findOne({ organizationId: tenant, campaignId });
    expect(recipient).toBeDefined();
    expect(recipient?.customFields['step_1_subject']).toBe('Question re: AYYAN GLOBAL digital infrastructure');
    expect(recipient?.customFields['step_1_body']).toContain('congratulations on your recent incorporation');
    expect(recipient?.customFields['step_2_subject']).toBe('Re: Question re: AYYAN GLOBAL');
    expect(recipient?.customFields['step_3_subject']).toBe('AYYAN GLOBAL digital roadmap');
  });

  it('2. generates and persists Step 1 draft for a valid recipient', async () => {
    const campaign = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Draft Gen Campaign',
        mailboxId: mailbox,
        steps: [
          { subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 },
        ],
        csvContent: sampleCsvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
        },
      });

    const campaignId = campaign.body.data.campaignId;

    const genRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/generate`)
      .set(authHeader())
      .send({ batchSize: 10 });

    expect(genRes.status).toBe(200);
    expect(genRes.body.data.processed).toBe(1);

    const draft = await EmailDraft.findOne({ organizationId: tenant, campaignId });
    expect(draft).toBeDefined();
    expect(draft?.subject).toBe('Question re: AYYAN GLOBAL digital infrastructure');
    expect(draft?.bodyText).toContain('congratulations on your recent incorporation');
    expect(draft?.status).toBe('draft');
    expect(draft?.stepIndex).toBe(0);
  });

  it('3. returns generated drafts in the recipient review queue API', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Review Queue Campaign',
        mailboxId: mailbox,
        steps: [{ subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 }],
        csvContent: sampleCsvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
        },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});

    const recRes = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/recipients`)
      .set(authHeader());

    expect(recRes.status).toBe(200);
    const recs = recRes.body.data.recipients;
    expect(recs.length).toBe(1);
    expect(recs[0].stepDrafts[0].draft).toBeDefined();
    expect(recs[0].stepDrafts[0].draft.subject).toBe('Question re: AYYAN GLOBAL digital infrastructure');
  });

  it('4. Approve All cannot approve nonexistent drafts and returns clear exclusion error', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Empty Drafts Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Hello', bodyText: 'Body', delayDays: 0 }],
        csvContent: sampleCsvContent,
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;

    // Approve All without generating drafts
    const approveRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/approve`)
      .set(authHeader())
      .send({});

    expect(approveRes.status).toBe(400);
    expect(approveRes.body.error.code).toBe('NO_DRAFTS_TO_APPROVE');

    // Verify recipient status remains 'pending', not 'approved'
    const recipient = await CampaignRecipient.findOne({ campaignId });
    expect(recipient?.status).toBe('pending');
  });

  it('5. Send All dispatches approved recipients through preflight checks and records sentAt', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Send All Campaign',
        mailboxId: mailbox,
        steps: [{ subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 }],
        csvContent: sampleCsvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
        },
      });

    const campaignId = createRes.body.data.campaignId;

    // Generate -> Approve -> Send
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});
    await request(app).post(`/api/v1/campaigns/${campaignId}/approve`).set(authHeader()).send({});

    const sendRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/send`)
      .set(authHeader())
      .send({ batchSize: 10 });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.data.processed).toBe(1);

    const recipient = await CampaignRecipient.findOne({ campaignId });
    expect(recipient?.status).toBe('sent');
    expect(recipient?.completedSteps).toBe(1);
    expect(recipient?.stepDrafts[0].status).toBe('sent');
    expect(recipient?.stepDrafts[0].sentAt).toBeDefined();
    expect(recipient?.stepDrafts[0].providerMessageId).toBeDefined();
  });

  it('6. Send Batch respects configured batch size', async () => {
    const multiRowCsv = [
      'Company Name,Work Email',
      'Alpha Corp,alpha@test.com',
      'Beta Corp,beta@test.com',
      'Gamma Corp,gamma@test.com',
    ].join('\n');

    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Batch Size Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Hi {{company_name}}', bodyText: 'Body text', delayDays: 0 }],
        csvContent: multiRowCsv,
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});
    await request(app).post(`/api/v1/campaigns/${campaignId}/approve`).set(authHeader()).send({});

    // Send with batchSize = 1
    const sendRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/send`)
      .set(authHeader())
      .send({ batchSize: 1 });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.data.processed).toBe(1);
    expect(sendRes.body.data.remaining).toBe(2);
  });

  it('7. handles missing Step 2 content clearly with validation error on step slot', async () => {
    const partialCsv = [
      'Company Name,Work Email,Step 1 Subject,Step 1 Body',
      'Delta Corp,delta@test.com,Welcome Delta,Step 1 body copy',
    ].join('\n');

    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Missing Step Content Campaign',
        mailboxId: mailbox,
        steps: [
          { subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 },
          { subject: '{{step_2_subject}}', bodyText: '{{step_2_body}}', delayDays: 3 },
        ],
        csvContent: partialCsv,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
        },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});

    const recipient = await CampaignRecipient.findOne({ campaignId });
    expect(recipient?.stepDrafts[0].status).toBe('draft');
    // Step 2 should be explicitly failed with actionable error
    expect(recipient?.stepDrafts[1].status).toBe('failed');
    expect(recipient?.stepDrafts[1].error).toContain('Step 2 requires a subject and body');
  });

  it('8. cancels follow-ups when recipient replies or becomes suppressed', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Reply Stop Campaign',
        mailboxId: mailbox,
        steps: [
          { subject: 'Step 1', bodyText: 'Step 1 body', delayDays: 0 },
          { subject: 'Step 2', bodyText: 'Step 2 body', delayDays: 0 },
        ],
        csvContent: 'Company Name,Work Email\nEcho Corp,echo@test.com',
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});
    await request(app).post(`/api/v1/campaigns/${campaignId}/approve`).set(authHeader()).send({});

    // Send step 1
    await request(app).post(`/api/v1/campaigns/${campaignId}/send`).set(authHeader()).send({ batchSize: 1 });

    const recipient = await CampaignRecipient.findOne({ campaignId });
    expect(recipient?.completedSteps).toBe(1);

    // Simulate inbound reply arrived
    recipient!.replied = true;
    recipient!.replyThreadId = 'gmail_thread_echo_123';
    await recipient!.save();

    // Try sending step 2
    await request(app).post(`/api/v1/campaigns/${campaignId}/send`).set(authHeader()).send({ batchSize: 1 });

    const updatedRecipient = await CampaignRecipient.findOne({ campaignId });
    expect(updatedRecipient?.status).toBe('replied');
    expect(updatedRecipient?.stepDrafts[1].status).toBe('skipped');
    expect(updatedRecipient?.stepDrafts[1].error).toContain('replied');
  });

  it('9. prevents duplicate sends using idempotency safeguards', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Duplicate Prevent Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1', bodyText: 'Step 1 body', delayDays: 0 }],
        csvContent: 'Company Name,Work Email\nFoxtrot Corp,foxtrot@test.com',
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});
    await request(app).post(`/api/v1/campaigns/${campaignId}/approve`).set(authHeader()).send({});

    // First send
    const send1 = await request(app).post(`/api/v1/campaigns/${campaignId}/send`).set(authHeader()).send({});
    expect(send1.body.data.processed).toBe(1);

    // Immediate second send attempt
    const send2 = await request(app).post(`/api/v1/campaigns/${campaignId}/send`).set(authHeader()).send({});
    expect(send2.body.data.processed).toBe(0);
    expect(send2.body.data.remaining).toBe(0);
  });

  it('10. records actionable error when sending mailbox encounters issues', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Paused Mailbox Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1', bodyText: 'Step 1 body', delayDays: 0 }],
        csvContent: 'Company Name,Work Email\nGolf Corp,golf@test.com',
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});
    await request(app).post(`/api/v1/campaigns/${campaignId}/approve`).set(authHeader()).send({});

    // Pause mailbox
    await EmailAccount.updateOne({ organizationId: tenant, emailAddress: mailbox }, { $set: { isPaused: true } });

    await request(app).post(`/api/v1/campaigns/${campaignId}/send`).set(authHeader()).send({});

    const recipient = await CampaignRecipient.findOne({ campaignId });
    expect(recipient?.status).toBe('failed');
    expect(recipient?.lastError).toContain('paused');
  });

  it('11. returns progress stats matching persisted recipient records', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Progress Match Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1', bodyText: 'Step 1 body', delayDays: 0 }],
        csvContent: 'Company Name,Work Email\nHotel Corp,hotel@test.com',
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});

    const progRes = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/progress`)
      .set(authHeader());

    expect(progRes.status).toBe(200);
    expect(progRes.body.data.totalRecipients).toBe(1);
    expect(progRes.body.data.prepared).toBe(1);
    expect(progRes.body.data.sent).toBe(0);
    expect(progRes.body.data.hasUngeneratedDrafts).toBe(false);
  });

  it('12. denies cross-workspace access to campaigns and drafts', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader(tenant))
      .send({
        name: 'Tenant Isolation Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1', bodyText: 'Step 1 body', delayDays: 0 }],
        csvContent: 'Company Name,Work Email\nIndia Corp,india@test.com',
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;

    // Attempt to access with other tenant credentials
    const unauthorizedGet = await request(app)
      .get(`/api/v1/campaigns/${campaignId}`)
      .set(authHeader(otherTenant));

    expect(unauthorizedGet.status).toBe(404);

    const unauthorizedApprove = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/approve`)
      .set(authHeader(otherTenant))
      .send({});

    expect(unauthorizedApprove.status).toBe(404);
  });

  it('13. leaves existing campaign data intact without data loss', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Data Integrity Campaign',
        mailboxId: mailbox,
        steps: [{ subject: 'Step 1', bodyText: 'Step 1 body', delayDays: 0 }],
        csvContent: sampleCsvContent,
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;
    const initialRecipient = await CampaignRecipient.findOne({ campaignId });
    expect(initialRecipient).toBeDefined();

    // Multiple progress and query calls should preserve the initial record intact
    await request(app).get(`/api/v1/campaigns/${campaignId}/progress`).set(authHeader());
    await request(app).get(`/api/v1/campaigns/${campaignId}/recipients`).set(authHeader());

    const verifiedRecipient = await CampaignRecipient.findOne({ campaignId });
    expect(verifiedRecipient?._id.toString()).toBe(initialRecipient?._id.toString());
    expect(verifiedRecipient?.email).toBe(initialRecipient?.email);
  });

  it('14. fetches single enriched recipient with full draft content and original copy', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Single Recipient Inspection',
        mailboxId: mailbox,
        steps: [{ subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 }],
        csvContent: sampleCsvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
        },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});

    const recipient = await CampaignRecipient.findOne({ campaignId });
    expect(recipient).toBeDefined();

    const detailRes = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/recipients/${recipient!._id}`)
      .set(authHeader());

    expect(detailRes.status).toBe(200);
    const data = detailRes.body.data;
    expect(data._id).toBe(recipient!._id.toString());
    expect(data.stepDrafts[0].draft).toBeDefined();
    expect(data.stepDrafts[0].draft.subject).toBe('Question re: AYYAN GLOBAL digital infrastructure');
    expect(data.stepDrafts[0].draft.bodyText).toContain('congratulations on your recent incorporation');
  });

  it('15. edits, saves, and approves a single recipient step draft', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Edit & Approve Step Draft',
        mailboxId: mailbox,
        steps: [{ subject: 'Initial Subj', bodyText: 'Initial Body', delayDays: 0 }],
        csvContent: sampleCsvContent,
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});
    const recipient = await CampaignRecipient.findOne({ campaignId });

    // 1. Edit draft
    const editRes = await request(app)
      .patch(`/api/v1/campaigns/${campaignId}/recipients/${recipient!._id}/steps/0`)
      .set(authHeader())
      .send({
        subject: 'Custom Tailored Subject Line',
        bodyText: 'Custom tailored body text with unique client proposal.',
      });

    expect(editRes.status).toBe(200);

    // Verify draft was modified
    const draft = await EmailDraft.findById(recipient!.stepDrafts[0].draftId);
    expect(draft?.subject).toBe('Custom Tailored Subject Line');
    expect(draft?.bodyText).toBe('Custom tailored body text with unique client proposal.');

    // 2. Approve draft individually
    const approveRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/recipients/${recipient!._id}/steps/0/approve`)
      .set(authHeader())
      .send({});

    expect(approveRes.status).toBe(200);
    const updatedDraft = await EmailDraft.findById(draft?._id);
    expect(updatedDraft?.status).toBe('approved');
  });

  it('16. calculates and persists Step 2 scheduledAt timestamp after Step 1 succeeds', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Multi-Step Delay Persistence',
        mailboxId: mailbox,
        steps: [
          { subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 },
          { subject: '{{step_2_subject}}', bodyText: '{{step_2_body}}', delayDays: 3 },
          { subject: '{{step_3_subject}}', bodyText: '{{step_3_body}}', delayDays: 4 },
        ],
        csvContent: sampleCsvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
          step_2_subject: 'Step 2 Subject',
          step_2_body: 'Step 2 Body',
          step_3_subject: 'Step 3 Subject',
          step_3_body: 'Step 3 Body',
        },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});
    await request(app).post(`/api/v1/campaigns/${campaignId}/approve`).set(authHeader()).send({});

    const recipientBefore = await CampaignRecipient.findOne({ campaignId });
    expect(recipientBefore?.stepDrafts[1]?.scheduledAt).toBeUndefined();

    // Send Step 1
    const sendRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/send`)
      .set(authHeader())
      .send({ batchSize: 1 });

    expect(sendRes.status).toBe(200);

    const recipientAfter = await CampaignRecipient.findOne({ campaignId });
    expect(recipientAfter?.completedSteps).toBe(1);
    expect(recipientAfter?.lastSentAt).toBeDefined();

    // Step 2 scheduledAt MUST be persisted exactly 3 days after step 1 sentAt
    const step2Slot = recipientAfter?.stepDrafts.find((s) => s.stepIndex === 1);
    expect(step2Slot?.scheduledAt).toBeDefined();
    const expectedTime = recipientAfter!.lastSentAt!.getTime() + 3 * 24 * 60 * 60 * 1000;
    expect(Math.abs(step2Slot!.scheduledAt!.getTime() - expectedTime)).toBeLessThan(1000);
  });

  it('17. dispatches a test preview email to designated test mailbox', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Test Email Preview Campaign',
        mailboxId: mailbox,
        steps: [{ subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 }],
        csvContent: sampleCsvContent,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
        },
      });

    const campaignId = createRes.body.data.campaignId;
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});
    const recipient = await CampaignRecipient.findOne({ campaignId });

    const testRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/recipients/${recipient!._id}/steps/0/test`)
      .set(authHeader())
      .send({ targetEmail: 'test.preview@swaniki.com' });

    expect(testRes.status).toBe(200);
    expect(testRes.body.data.success).toBe(true);
    expect(testRes.body.data.messageId).toBeDefined();
  });

  it('18. updates schedule settings (step delay days & window) and cancels follow-ups', async () => {
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set(authHeader())
      .send({
        name: 'Schedule Settings Campaign',
        mailboxId: mailbox,
        steps: [
          { subject: 'Step 1', bodyText: 'Body 1', delayDays: 0 },
          { subject: 'Step 2', bodyText: 'Body 2', delayDays: 2 },
        ],
        csvContent: sampleCsvContent,
        columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      });

    const campaignId = createRes.body.data.campaignId;

    // Update schedule settings
    const patchRes = await request(app)
      .patch(`/api/v1/campaigns/${campaignId}/schedule-settings`)
      .set(authHeader())
      .send({
        stepDelays: [{ stepIndex: 1, delayDays: 5 }],
        schedule: {
          startAt: new Date(Date.now() + 3600000).toISOString(),
          timezone: 'Asia/Kolkata',
          batchSize: 50,
          paceMinutes: 10,
          windowStartHour: 9,
          windowEndHour: 18,
        },
      });

    expect(patchRes.status).toBe(200);
    const campaign = await Campaign.findById(campaignId);
    expect(campaign?.steps[1].delayDays).toBe(5);
    expect(campaign?.schedule?.timezone).toBe('Asia/Kolkata');
    expect(campaign?.schedule?.windowStartHour).toBe(9);

    // Generate drafts and test cancelling follow-ups
    await request(app).post(`/api/v1/campaigns/${campaignId}/generate`).set(authHeader()).send({});
    const recipient = await CampaignRecipient.findOne({ campaignId });

    const cancelRes = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/recipients/${recipient!._id}/cancel-followups`)
      .set(authHeader())
      .send({});

    expect(cancelRes.status).toBe(200);
    const updatedRecipient = await CampaignRecipient.findById(recipient!._id);
    expect(updatedRecipient?.stepDrafts.every((s) => s.status === 'skipped')).toBe(true);
  });
});

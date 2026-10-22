import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { Suppression } from '../models/Suppression.js';
import {
  normalizeTokenKey,
  boundCustomFields,
  interpolateTemplate,
  sanitizeHeaderValue,
  detectCompanyNameMismatch,
} from '../services/template-interpolation.service.js';

describe('Campaigns: CSV bulk sender suite', () => {
  let app: any;
  const tenant = 'org_test_campaign_tenant';
  const mailbox = 'campaigner@swaniki.dev';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    await CampaignRecipient.deleteMany({ organizationId: tenant });
    await Campaign.deleteMany({ organizationId: tenant });
    await Company.deleteMany({ organizationId: tenant });
    await CompanyContact.deleteMany({ organizationId: tenant });
    await CompanyAssessment.deleteMany({ organizationId: tenant });
    await EmailDraft.deleteMany({ organizationId: tenant });
    await EmailSendAttempt.deleteMany({ organizationId: tenant });
    await Suppression.deleteMany({ organizationId: tenant });
    await EmailAccount.deleteMany({ organizationId: tenant });

    await EmailAccount.create({
      organizationId: tenant,
      emailAddress: mailbox,
      displayName: 'Campaigner',
      provider: 'mock',
      status: 'connected',
      isPaused: false,
      dailySendLimit: 100,
      sendsToday: 0,
    });
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  describe('Template interpolation unit logic', () => {
    it('normalizes token keys to snake_case', () => {
      expect(normalizeTokenKey('Company Name')).toBe('company_name');
      expect(normalizeTokenKey('  Plan-Tier ')).toBe('plan_tier');
      expect(normalizeTokenKey('Weird!!Key')).toBe('weirdkey');
    });

    it('bounds custom fields by count and value length', () => {
      const raw: Record<string, unknown> = {};
      for (let i = 0; i < 80; i++) raw[`k${i}`] = 'v';
      const { customFields, droppedKeys } = boundCustomFields(raw);
      expect(Object.keys(customFields)).toHaveLength(50);
      expect(droppedKeys).toBe(30);

      const long = boundCustomFields({ note: 'x'.repeat(900) });
      expect(long.customFields.note.length).toBe(500);
      expect(long.truncatedValues).toBe(1);
    });

    it('interpolates known tokens and reports missing ones without throwing', () => {
      const result = interpolateTemplate('Hi {{name}}, plan: {{plan}} ({{missing}})', {
        name: 'Ada',
        plan: 'Pro',
      });
      expect(result.output).toBe('Hi Ada, plan: Pro ()');
      expect(result.usedTokens.sort()).toEqual(['name', 'plan']);
      expect(result.missingTokens).toEqual(['missing']);
    });

    it('strips CR/LF from header values to prevent header injection', () => {
      expect(sanitizeHeaderValue('Hello\r\nBcc: evil@x.com')).toBe('Hello Bcc: evil@x.com');
    });

    it('does not flag copy that references the recipient company', () => {
      expect(
        detectCompanyNameMismatch('AYYAN GLOBAL PRIVATE LIMITED digital infrastructure', 'AYYAN GLOBAL PRIVATE LIMITED')
      ).toBeNull();
      expect(detectCompanyNameMismatch('For Acme Corp about the Pro plan', 'Acme Corp')).toBeNull();
    });

    it('flags a different company name bleeding into the copy', () => {
      expect(
        detectCompanyNameMismatch('vansh GLOBAL PRIVATE LIMITED digital infrastructure', 'AYYAN GLOBAL PRIVATE LIMITED')
      ).toBe('vansh GLOBAL PRIVATE LIMITED');
      expect(detectCompanyNameMismatch('Modernizing Infosys Limited', 'Acme Corp')).toContain('Infosys Limited');
    });
  });

  describe('Campaign REST lifecycle', () => {
    let campaignId = '';
    const csv = [
      'Company,Email,Contact,Plan,Seats',
      'Acme Corp,ada@acme.example.com,Ada,Pro,10',
      'Beta LLC,bob@beta.example.com,Bob,Free,3',
    ].join('\n');

    it('POST /campaigns imports recipients with bounded custom fields', async () => {
      const res = await request(app)
        .post('/api/v1/campaigns')
        .set('x-organization-id', tenant)
        .send({
          name: 'Q4 Outreach',
          mailboxId: mailbox,
          steps: [
            {
              subject: 'For {{company_name}} about the {{plan}} plan',
              bodyText: 'Hi {{contact_first_name}}, we noticed {{seats}} seats. Regards, {{sender_name}}',
            },
          ],
          csvContent: csv,
          columnMapping: { company_name: 'Company', contact_email: 'Email', contact_first_name: 'Contact' },
          customFieldMapping: { Plan: 'plan', Seats: 'seats' },
          senderName: 'Vansh',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.summary.recipientsCreated).toBe(2);
      campaignId = res.body.data.campaignId;

      const company = await Company.findOne({ organizationId: tenant, name: 'Acme Corp' });
      expect(company!.customFields.get('plan')).toBe('Pro');
      expect(company!.customFields.get('seats')).toBe('10');
    });

    it('POST /campaigns/:id/generate produces personalized drafts', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/generate`)
        .set('x-organization-id', tenant)
        .send({ batchSize: 50, senderName: 'Vansh' });

      expect(res.status).toBe(200);
      expect(res.body.data.processed).toBe(2);
      expect(res.body.data.remaining).toBe(0);

      const recipientsRes = await request(app)
        .get(`/api/v1/campaigns/${campaignId}/recipients`)
        .set('x-organization-id', tenant);

      expect(recipientsRes.status).toBe(200);
      expect(recipientsRes.body.data.total).toBe(2);

      const acme = recipientsRes.body.data.recipients.find((r: any) => r.companyName === 'Acme Corp');
      const draft = acme.stepDrafts[0].draft;
      expect(draft.subject).toBe('For Acme Corp about the Pro plan');
      expect(draft.bodyText).toContain('Hi Ada');
      expect(draft.bodyText).toContain('Vansh');
    });

    it('POST /campaigns/:id/approve approves generated drafts', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/approve`)
        .set('x-organization-id', tenant)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.approved).toBe(2);

      const drafts = await EmailDraft.find({ organizationId: tenant, status: 'approved' });
      expect(drafts.length).toBe(2);
    });

    it('POST /campaigns/:id/send dispatches through the pre-flight pipeline', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/send`)
        .set('x-organization-id', tenant)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.processed).toBe(2);
      expect(res.body.data.stats.sent).toBe(2);
      expect(res.body.data.status).toBe('completed');

      const attempts = await EmailSendAttempt.find({ organizationId: tenant, status: 'accepted' });
      expect(attempts.length).toBe(2);
    });

    it('POST /campaigns/:id/send is idempotent on repeat (no double send)', async () => {
      const res = await request(app)
        .post(`/api/v1/campaigns/${campaignId}/send`)
        .set('x-organization-id', tenant)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.processed).toBe(0);

      const attempts = await EmailSendAttempt.find({ organizationId: tenant, status: 'accepted' });
      expect(attempts.length).toBe(2);
    });

    it('GET /campaigns/:id/progress reports completed state', async () => {
      const res = await request(app)
        .get(`/api/v1/campaigns/${campaignId}/progress`)
        .set('x-organization-id', tenant);

      expect(res.status).toBe(200);
      expect(res.body.data.sent).toBe(2);
      expect(res.body.data.byStatus.sent).toBe(2);
    });

    it('does not leak campaigns across tenants', async () => {
      const res = await request(app)
        .get(`/api/v1/campaigns/${campaignId}`)
        .set('x-organization-id', 'org_test_campaign_other');
      expect(res.status).toBe(404);
    });
  });

  describe('Suppression handling', () => {
    it('suppressed recipients are skipped, not failed', async () => {
      const createRes = await request(app)
        .post('/api/v1/campaigns')
        .set('x-organization-id', tenant)
        .send({
          name: 'Suppression Test',
          mailboxId: mailbox,
          steps: [{ subject: 'Hi {{company_name}}', bodyText: 'Body' }],
          csvContent: ['Company,Email', 'Gamma,gamma@gamma.example.com'].join('\n'),
          columnMapping: { company_name: 'Company', contact_email: 'Email' },
        });

      const id = createRes.body.data.campaignId;

      await Suppression.create({ organizationId: tenant, email: 'gamma@gamma.example.com', reason: 'unsubscribed' });

      await request(app).post(`/api/v1/campaigns/${id}/generate`).set('x-organization-id', tenant).send({});
      await request(app).post(`/api/v1/campaigns/${id}/approve`).set('x-organization-id', tenant).send({});
      const sendRes = await request(app)
        .post(`/api/v1/campaigns/${id}/send`)
        .set('x-organization-id', tenant)
        .send({});

      expect(sendRes.status).toBe(200);

      const progress = await request(app)
        .get(`/api/v1/campaigns/${id}/progress`)
        .set('x-organization-id', tenant);

      expect(progress.body.data.byStatus.suppressed).toBe(1);
      expect(progress.body.data.sent).toBe(0);
    });
  });

  describe('Campaign Sent metric counts successful sends, not recipient status', () => {
    it('reports Step 1 sends even while later steps remain approved', async () => {
      const createRes = await request(app)
        .post('/api/v1/campaigns')
        .set('x-organization-id', tenant)
        .send({
          name: 'Multi Step Sent Metric',
          mailboxId: mailbox,
          steps: [
            { subject: 'Step 1 for {{company_name}}', bodyText: 'First touch', delayDays: 0 },
            { subject: 'Step 2 for {{company_name}}', bodyText: 'Follow up', delayDays: 3 },
            { subject: 'Step 3 for {{company_name}}', bodyText: 'Final touch', delayDays: 4 },
          ],
          csvContent: ['Company,Email', 'Multi One,multi1@acme.example.com', 'Multi Two,multi2@beta.example.com'].join('\n'),
          columnMapping: { company_name: 'Company', contact_email: 'Email' },
        });

      const id = createRes.body.data.campaignId;

      await request(app).post(`/api/v1/campaigns/${id}/generate`).set('x-organization-id', tenant).send({});
      await request(app).post(`/api/v1/campaigns/${id}/approve`).set('x-organization-id', tenant).send({});
      const sendRes = await request(app)
        .post(`/api/v1/campaigns/${id}/send`)
        .set('x-organization-id', tenant)
        .send({});

      expect(sendRes.status).toBe(200);
      // Each recipient had exactly one (Step 1) successful send.
      expect(createRes.body.data.summary.recipientsCreated).toBe(2);

      const recipients = await CampaignRecipient.find({ organizationId: tenant, campaignId: id });
      expect(recipients.every((r) => r.status === 'approved')).toBe(true);
      expect(recipients.every((r) => r.completedSteps === 1)).toBe(true);

      const attempts = await EmailSendAttempt.find({
        organizationId: tenant,
        campaignId: id,
        status: 'accepted',
      });
      expect(attempts.length).toBe(2);
      expect(attempts.every((a) => a.recipientId && a.stepIndex === 0)).toBe(true);

      const progress = await request(app)
        .get(`/api/v1/campaigns/${id}/progress`)
        .set('x-organization-id', tenant);

      expect(progress.status).toBe(200);
      // Sent counts the two successful Step 1 sends...
      expect(progress.body.data.sent).toBe(2);
      // ...even though no recipient has the terminal "sent" status yet.
      expect(progress.body.data.byStatus.sent ?? 0).toBe(0);

      // Re-polling must not change the count (refresh-stable).
      const progress2 = await request(app)
        .get(`/api/v1/campaigns/${id}/progress`)
        .set('x-organization-id', tenant);
      expect(progress2.body.data.sent).toBe(2);

      // Re-sending is idempotent and must not double-count.
      await request(app).post(`/api/v1/campaigns/${id}/send`).set('x-organization-id', tenant).send({});
      const attemptsAfter = await EmailSendAttempt.countDocuments({
        organizationId: tenant,
        campaignId: id,
        status: 'accepted',
      });
      expect(attemptsAfter).toBe(2);
    });

    it('flags a template draft whose copy names a different company', async () => {
      const createRes = await request(app)
        .post('/api/v1/campaigns')
        .set('x-organization-id', tenant)
        .send({
          name: 'Mismatch Detection',
          mailboxId: mailbox,
          steps: [
            {
              subject: 'vansh GLOBAL PRIVATE LIMITED digital infrastructure',
              bodyText: 'Hello {{company_name}}, reaching out about your platform.',
            },
          ],
          csvContent: ['Company,Email', 'AYYAN GLOBAL PRIVATE LIMITED,ops@ayyan.example.com'].join('\n'),
          columnMapping: { company_name: 'Company', contact_email: 'Email' },
        });

      const id = createRes.body.data.campaignId;
      await request(app).post(`/api/v1/campaigns/${id}/generate`).set('x-organization-id', tenant).send({});

      const recipientsRes = await request(app)
        .get(`/api/v1/campaigns/${id}/recipients`)
        .set('x-organization-id', tenant);

      expect(createRes.status).toBe(201);
      expect(recipientsRes.status).toBe(200);

      const recipient = recipientsRes.body.data.recipients[0];
      const draft = recipient.stepDrafts[0].draft;
      expect(draft.companyNameMismatch).toBe('vansh GLOBAL PRIVATE LIMITED');
      expect(draft.warnings.join(' ')).toContain('Company name mismatch');
    });
  });
});

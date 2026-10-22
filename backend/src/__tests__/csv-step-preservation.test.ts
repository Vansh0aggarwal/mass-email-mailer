import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { WorkspaceSettings } from '../models/WorkspaceSettings.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { campaignService } from '../services/campaign.service.js';
import { interpolateTemplate, isCompanyNameLike, buildInterpolationValues } from '../services/template-interpolation.service.js';

describe('CSV Step Copy Preservation & Template Interpolation', () => {
  let app: any;
  const tenant = 'org_csv_preservation_test';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
    await Campaign.deleteMany({ organizationId: tenant });
    await CampaignRecipient.deleteMany({ organizationId: tenant });
    await EmailDraft.deleteMany({ organizationId: tenant });
    await EmailAccount.deleteMany({ organizationId: tenant });
    await WorkspaceSettings.deleteMany({ organizationId: tenant });
  });

  afterAll(async () => {
    await Campaign.deleteMany({ organizationId: tenant });
    await CampaignRecipient.deleteMany({});
    await EmailDraft.deleteMany({ organizationId: tenant });
    await WorkspaceSettings.deleteMany({ organizationId: tenant });
    await EmailAccount.deleteMany({ organizationId: tenant });
    await disconnectDatabase();
  });

  describe('isCompanyNameLike & Greeting Normalization', () => {
    it('detects corporate legal entities and flags them to avoid awkward greetings', () => {
      expect(isCompanyNameLike('Acme Technologies Pvt Ltd')).toBe(true);
      expect(isCompanyNameLike('Infotech Solutions LLC')).toBe(true);
      expect(isCompanyNameLike('Summit Enterprises Inc')).toBe(true);
      expect(isCompanyNameLike('Global Ventures LLP')).toBe(true);
      expect(isCompanyNameLike('Rahul Sharma')).toBe(false);
      expect(isCompanyNameLike('Priya Patel')).toBe(false);
    });

    it('interpolates template with sender settings and handles fallback when name looks like company', () => {
      const settings = {
        senderName: 'Vikram Malhotra',
        senderBusiness: 'Swaniki Outreach',
        greetingFormat: 'Hi {{first_name}},',
        missingNameFallback: 'Hi there,',
        signOff: 'Best regards',
        signature: 'Vikram | Swaniki',
        contactDetails: '+91 99999 88888',
      };

      const values = buildInterpolationValues({
        contactName: 'Apex Innovations Private Limited',
        companyName: 'Apex Innovations',
        sector: 'Software',
        ...settings,
      });

      const template = '{{greeting}}\n\nWe noticed {{company_name}} operates in {{sector}}.\n\n{{sign_off}},\n{{sender_name}}';
      const rendered = interpolateTemplate(template, values);

      expect(rendered.output).toContain('Hi there,');
      expect(rendered.output).toContain('We noticed Apex Innovations operates in Software.');
      expect(rendered.output).toContain('Best regards,\nVikram Malhotra');
    });
  });

  describe('Preservation of Original CSV Step Copy on EmailDrafts', () => {
    it('preserves raw imported Step 1/2/3 subject and body as originalSubject and originalBodyText', async () => {
      await EmailAccount.create({
        organizationId: tenant,
        emailAddress: 'sender@swaniki.com',
        displayName: 'Sender Account',
        provider: 'mock',
        status: 'connected',
        dailySendLimit: 100,
      });

      const campaign = await Campaign.create({
        organizationId: tenant,
        createdBy: 'usr_test_creator',
        name: 'Preservation Test Campaign',
        mailboxId: 'sender@swaniki.com',
        generationMode: 'template',
        status: 'draft',
        steps: [
          { stepIndex: 1, subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 },
        ],
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          contact_first_name: 'First Name',
          director_full_name: 'Director Full Name',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
        },
        customFieldMapping: {},
      });

      const recipient = await CampaignRecipient.create({
        campaignId: campaign._id,
        organizationId: tenant,
        rowNumber: 2,
        email: 'director@techforward.in',
        name: 'Vikramaditya Rao',
        companyName: 'TechForward Solutions',
        customFields: {
          step_1_subject: 'Tailored Web Modernization for TechForward Solutions',
          step_1_body: 'Hi Vikramaditya,\n\nWe audited your web portal and identified 3 key latency improvements.\n\nBest,\nOutreach Team',
        },
        status: 'pending',
        completedSteps: 0,
        stepDrafts: [
          { stepIndex: 1, status: 'pending' },
        ],
      });

      // Generate drafts batch (organizationId, campaignId, batchSize)
      const result = await campaignService.generateDraftsBatch(tenant, campaign._id.toString(), 10);
      expect(result.processed).toBe(1);

      // Verify draft document
      const updatedRecipient = await CampaignRecipient.findById(recipient._id);
      expect(updatedRecipient?.stepDrafts[0]?.draftId).toBeDefined();

      const draft = await EmailDraft.findById(updatedRecipient?.stepDrafts[0]?.draftId);
      expect(draft).toBeDefined();
      if (!draft) throw new Error('Draft not found');

      // Subject and body were rendered
      expect(draft.subject).toContain('Tailored Web Modernization for TechForward Solutions');
      expect(draft.bodyText).toContain('We audited your web portal');

      // Crucial requirement: Raw original content is preserved for auditability!
      expect(draft.originalSubject).toBe('Tailored Web Modernization for TechForward Solutions');
      expect(draft.originalBodyText).toBe('Hi Vikramaditya,\n\nWe audited your web portal and identified 3 key latency improvements.\n\nBest,\nOutreach Team');
    });
  });
});

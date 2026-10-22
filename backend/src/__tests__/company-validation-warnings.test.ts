import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { Company } from '../models/Company.js';
import {
  detectCompanyNameMismatch,
  validateEmailCopy,
  repairUnsupportedClaims,
} from '../services/template-interpolation.service.js';
import { CampaignService } from '../services/campaign.service.js';

const tenant = 'org_company_val_tenant';
const mailbox = 'outreach@companyval.com';

function authHeader(org: string = tenant, user: string = 'usr_val_actor') {
  return {
    'x-organization-id': org,
    'x-user-id': user,
  };
}

describe('Company Name Validation, Distinct Warnings, and Repair Suite', () => {
  let app: any;
  const campaignService = new CampaignService();

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
      EmailDraft.deleteMany({ organizationId: tenant }),
      EmailAccount.deleteMany({ organizationId: tenant }),
    ]);

    await EmailAccount.create({
      organizationId: tenant,
      emailAddress: mailbox,
      displayName: 'Outreach Mailbox',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 100,
      sendsToday: 0,
      isPaused: false,
    });
  });

  describe('1. Unit-level validation logic for HI-TECH and company name detection', () => {
    const hiTechName = 'HI-TECH INFRA SYSTEMS PRIVATE LIMITED';

    it('does NOT misclassify "was recently incorporated" as a company name mismatch', () => {
      const copy = `Noticed HI-TECH INFRA SYSTEMS PRIVATE LIMITED was recently incorporated under the Ministry of Corporate Affairs gazette, and we wanted to connect.`;

      const mismatch = detectCompanyNameMismatch(copy, hiTechName);
      expect(mismatch).toBeNull();
    });

    it('separates company name mismatch from unsupported incorporation claims', () => {
      const copy = `Noticed HI-TECH INFRA SYSTEMS PRIVATE LIMITED was recently incorporated under the Ministry of Corporate Affairs gazette, and we wanted to pitch an interactive portal.`;

      const result = validateEmailCopy({
        subject: 'Quick question for HI-TECH INFRA SYSTEMS PRIVATE LIMITED',
        bodyText: copy,
        companyName: hiTechName,
        incorporationDate: null,
      });

      // No company name mismatch:
      expect(result.companyNameMismatch).toBeNull();
      expect(result.hasBlockingError).toBe(false);

      // Distinct incorporation claim warning:
      expect(result.unsupportedIncorporationClaim).toBeTruthy();
      expect(result.unsupportedIncorporationClaim).toContain('incorporat');
      expect(result.requiresReview).toBe(true);
      expect(result.unsupportedClaims.length).toBeGreaterThan(0);
    });

    it('accurately catches a REAL company name mismatch', () => {
      const copy = `Noticed AYYAN GLOBAL PRIVATE LIMITED has expanded its infrastructure division, and we wanted to connect with HI-TECH INFRA SYSTEMS PRIVATE LIMITED.`;

      const mismatch = detectCompanyNameMismatch(copy, hiTechName);
      expect(mismatch).toBe('AYYAN GLOBAL PRIVATE LIMITED');

      const result = validateEmailCopy({
        subject: 'Inquiry for HI-TECH',
        bodyText: copy,
        companyName: hiTechName,
      });

      expect(result.companyNameMismatch).toBe('AYYAN GLOBAL PRIVATE LIMITED');
      expect(result.hasBlockingError).toBe(true);
    });

    it('flags contradicted website claim when site is live HTTP 200', () => {
      const copy = `We noticed client portal infrastructure isn't live yet on hitechinfra.in, so we wanted to offer 3D floorplans.`;

      const result = validateEmailCopy({
        subject: 'Proposal for HI-TECH',
        bodyText: copy,
        companyName: hiTechName,
        websiteStatus: 'active',
        httpCode: '200',
        domain: 'hitechinfra.in',
      });

      expect(result.unsupportedWebsiteClaim).toBeTruthy();
      expect(result.unsupportedWebsiteClaim).toContain('verified audit indicates status is live');
      expect(result.requiresReview).toBe(true);
    });

    it('does NOT flag incorporation claims when verified MCA evidence is present', () => {
      const copy = `Noticed HI-TECH INFRA SYSTEMS PRIVATE LIMITED was recently incorporated under the Ministry of Corporate Affairs gazette.`;

      const result = validateEmailCopy({
        subject: 'Welcome HI-TECH INFRA SYSTEMS PRIVATE LIMITED',
        bodyText: copy,
        companyName: hiTechName,
        incorporationDate: new Date('2026-08-15'),
        customFields: {
          mca_verified: 'true',
          cin: 'U70109DL2026PTC123456',
        },
      });

      expect(result.unsupportedIncorporationClaim).toBeNull();
      expect(result.companyNameMismatch).toBeNull();
    });

    it('repairs unsupported claims into neutral verified wording while preserving exact company name & proposed deliverable', () => {
      const originalBody = `Hi there,\n\nNoticed HI-TECH INFRA SYSTEMS PRIVATE LIMITED was recently incorporated under the Ministry of Corporate Affairs gazette. Noticing client portal infrastructure isn't live yet on hitechinfra.in, we specialize in Interactive Property Showcase, 3D Floorplans & Lead CRM.\n\nBest,\nVansh`;

      const repaired = repairUnsupportedClaims(originalBody, {
        companyName: hiTechName,
        proposedDeliverable: 'Interactive Property Showcase, 3D Floorplans & Lead CRM',
        domain: 'hitechinfra.in',
        websiteStatus: 'active',
        httpCode: '200',
      });

      // Must NOT contain unverified incorporation assertions:
      expect(repaired).not.toContain('was recently incorporated');
      expect(repaired).not.toContain("infrastructure isn't live yet");

      // Must preserve the verified company name:
      expect(repaired).toContain(hiTechName);

      // Must preserve the intended proposed deliverable:
      expect(repaired).toContain('Interactive Property Showcase, 3D Floorplans & Lead CRM');

      // Validating the repaired copy yields no unsupported claims:
      const validationAfter = validateEmailCopy({
        subject: 'Proposal',
        bodyText: repaired,
        companyName: hiTechName,
        websiteStatus: 'active',
        httpCode: '200',
        domain: 'hitechinfra.in',
      });

      expect(validationAfter.companyNameMismatch).toBeNull();
      expect(validationAfter.unsupportedIncorporationClaim).toBeNull();
      expect(validationAfter.unsupportedWebsiteClaim).toBeNull();
      expect(validationAfter.hasBlockingError).toBe(false);
    });
  });

  describe('2. Campaign pipeline behavior: drafts, blocking errors, and repair endpoint', () => {
    it('generates drafts with separate validation fields and allows one-click repair via API', async () => {
      // Create campaign
      const campaign = await Campaign.create({
        organizationId: tenant,
        name: 'Hi-Tech Infrastructure Outreach',
        mailboxId: mailbox,
        status: 'draft',
        tone: 'professional',
        createdBy: 'usr_val_actor',
        steps: [
          {
            stepIndex: 0,
            subject: 'Exploring synergies with {{company_name}}',
            bodyText: `Noticed HI-TECH INFRA SYSTEMS PRIVATE LIMITED was recently incorporated under the Ministry of Corporate Affairs gazette.\nWe specialize in {{proposed_deliverable}} for your team.`,
            delayDays: 0,
          },
        ],
      });

      // Create recipient
      const recipient = await CampaignRecipient.create({
        organizationId: tenant,
        campaignId: campaign._id,
        companyName: 'HI-TECH INFRA SYSTEMS PRIVATE LIMITED',
        email: 'hitech@hitechinfra.in',
        name: 'Managing Director',
        rowNumber: 19,
        status: 'pending',
        customFields: new Map([
          ['proposed_deliverable', 'Interactive Property Showcase, 3D Floorplans & Lead CRM'],
          ['domain', 'hitechinfra.in'],
          ['website_status', 'active'],
          ['http_code', '200'],
          ['step_1_subject', 'Exploring synergies with {{company_name}}'],
          ['step_1_body', `Noticed HI-TECH INFRA SYSTEMS PRIVATE LIMITED was recently incorporated under the Ministry of Corporate Affairs gazette.\nWe specialize in {{proposed_deliverable}} for your team.`],
        ]),
        stepDrafts: [{ stepIndex: 0, status: 'pending' }],
      });

      // Generate drafts
      const genRes = await request(app)
        .post(`/api/v1/campaigns/${campaign._id}/recipients/${recipient._id}/generate`)
        .set(authHeader())
        .send();

      expect(genRes.status).toBe(200);

      // Check generated draft
      const draft = await EmailDraft.findOne({
        recipientId: recipient._id,
        stepIndex: 0,
      });

      expect(draft).toBeTruthy();
      expect(draft?.companyNameMismatch).toBeFalsy(); // NO false company name mismatch!
      expect(draft?.unsupportedClaims?.length).toBeGreaterThan(0); // Flagged as unverified claim
      expect(draft?.unsupportedClaims?.[0]).toContain('incorporat');

      // Test repair endpoint
      const repairRes = await request(app)
        .post(`/api/v1/campaigns/${campaign._id}/recipients/${recipient._id}/steps/0/repair`)
        .set(authHeader())
        .send();

      expect(repairRes.status).toBe(200);

      const repairedDraft = await EmailDraft.findOne({
        recipientId: recipient._id,
        stepIndex: 0,
      });

      expect(repairedDraft?.bodyText).not.toContain('was recently incorporated');
      expect(repairedDraft?.bodyText).toContain('HI-TECH INFRA SYSTEMS PRIVATE LIMITED');
      expect(repairedDraft?.bodyText).toContain('Interactive Property Showcase, 3D Floorplans & Lead CRM');
      expect(repairedDraft?.unsupportedClaims?.length).toBe(0);
    });

    it('blocks bulk approval when draft has a companyNameMismatch, but allows approval once repaired/correct', async () => {
      const campaign = await Campaign.create({
        organizationId: tenant,
        name: 'Safety Guard Campaign',
        mailboxId: mailbox,
        status: 'ready_for_review',
        tone: 'professional',
        createdBy: 'usr_val_actor',
        steps: [{ stepIndex: 0, subject: 'Hello', bodyText: 'Body', delayDays: 0 }],
      });

      // Recipient A has a real mismatch
      const recipientA = await CampaignRecipient.create({
        organizationId: tenant,
        campaignId: campaign._id,
        companyName: 'HI-TECH INFRA SYSTEMS PRIVATE LIMITED',
        email: 'hitech@hitechinfra.in',
        rowNumber: 1,
        status: 'pending',
        stepDrafts: [{ stepIndex: 0, status: 'pending' }],
      });

      const draftA = await EmailDraft.create({
        organizationId: tenant,
        campaignId: campaign._id,
        recipientId: recipientA._id,
        stepIndex: 0,
        companyName: recipientA.companyName,
        recipientEmail: recipientA.email,
        subject: 'Notice',
        bodyText: 'We noticed AYYAN GLOBAL PRIVATE LIMITED has launched a new branch.',
        companyNameMismatch: 'AYYAN GLOBAL PRIVATE LIMITED',
        status: 'draft',
        tone: 'professional',
      });
      recipientA.stepDrafts[0].draftId = draftA._id as any;
      recipientA.stepDrafts[0].status = 'draft';
      await recipientA.save();

      // Recipient B has HI-TECH with unverified claim (review warning, NOT blocking mismatch)
      const recipientB = await CampaignRecipient.create({
        organizationId: tenant,
        campaignId: campaign._id,
        companyName: 'HI-TECH INFRA SYSTEMS PRIVATE LIMITED',
        email: 'director@hitechinfra.in',
        rowNumber: 2,
        status: 'pending',
        stepDrafts: [{ stepIndex: 0, status: 'pending' }],
      });

      const draftB = await EmailDraft.create({
        organizationId: tenant,
        campaignId: campaign._id,
        recipientId: recipientB._id,
        stepIndex: 0,
        companyName: recipientB.companyName,
        recipientEmail: recipientB.email,
        subject: 'Notice',
        bodyText: 'Noticed HI-TECH INFRA SYSTEMS PRIVATE LIMITED was recently incorporated.',
        unsupportedClaims: ['Unverified claim: recently incorporated'],
        status: 'draft',
        tone: 'professional',
      });
      recipientB.stepDrafts[0].draftId = draftB._id as any;
      recipientB.stepDrafts[0].status = 'draft';
      await recipientB.save();

      // Run bulk approve
      const approveRes = await campaignService.approveRecipients(tenant, String(campaign._id), [
        String(recipientA._id),
        String(recipientB._id),
      ]);

      // Recipient A MUST be blocked from bulk approval because of companyNameMismatch!
      const refreshedA = await CampaignRecipient.findById(recipientA._id);
      expect(refreshedA?.stepDrafts[0].status).toBe('draft');

      // Recipient B (review warning, not mismatch) is permitted when explicitly approved by user
      const refreshedB = await CampaignRecipient.findById(recipientB._id);
      expect(refreshedB?.stepDrafts[0].status).toBe('approved');
    });
  });
});

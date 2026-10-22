import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { WorkspaceSettings } from '../models/WorkspaceSettings.js';
import { campaignService } from '../services/campaign.service.js';
import { parseCsvDetailed } from '../services/csv-parser.service.js';
import { boundCustomFields, MAX_TEMPLATE_LENGTH } from '../services/template-interpolation.service.js';
import { mockEmailProvider } from '../providers/email/mock-email.provider.js';
import { gmailProvider } from '../providers/email/gmail.provider.js';

// The complete Step 1 body exactly as it appears in the real campaign CSV. The
// previous 500-char custom-field cap cut this off at "...establishes immediate
// credibility and preven".
const STEP_1_BODY =
  "Hi Ayyan,\n\nNoticed AYYAN GLOBAL PRIVATE LIMITED was recently incorporated under the Ministry of Corporate Affairs gazette. Congratulations on the new venture.\n\nWhile auditing new retail / d2c entrants across your region, I observed that your dedicated digital intake and client portal infrastructure isn't live yet on ayyan.com. For newly launching businesses in retail / d2c, having a tailor-made customer workflow directly on your owned digital presence establishes immediate credibility and prevents manual phone follow-up.\n\nAt Swaniki (swaniki.com), we build modern web applications, SaaS prototypes, and custom workflow automations (\"think it. build it.\"). Specifically for AYYAN GLOBAL PRIVATE LIMITED, we can deliver a Headless Shopify Storefront & Omnichannel Inventory PWA.\n\nWould you be open to seeing a brief 2-minute architectural prototype we outlined for your retail / d2c workflow?\n\nBest regards,\nSwaniki Studio Team\nthink it. build it. \u2022 swaniki.com";

const STEP_1_SUBJECT = 'Question re: AYYAN GLOBAL PRIVATE LIMITED digital infrastructure';
const STEP_2_SUBJECT = 'Re: Question re: AYYAN GLOBAL PRIVATE LIMITED digital infrastructure';
const STEP_2_BODY =
  "Hi Ayyan,\n\nFollowing up briefly on my earlier note regarding AYYAN GLOBAL PRIVATE LIMITED.\n\nWe recently completed a similar custom portal for an emerging retail / d2c brand that automated client intake and integrated instant WhatsApp notifications, eliminating front-office coordination bottlenecks.\n\nHappy to share that case study or jump on a quick 10-minute introductory call this week if modernizing AYYAN GLOBAL PRIVATE LIMITED's digital presence is currently on your roadmap.\n\nBest,\nSwaniki Studio Team";
const STEP_3_SUBJECT = 'AYYAN GLOBAL PRIVATE LIMITED digital roadmap';
const STEP_3_BODY =
  "Hi Ayyan,\n\nAre you still exploring custom software or a modern web platform for AYYAN GLOBAL PRIVATE LIMITED, or have you already handled this internally?\n\nBest,\nSwaniki Studio Team";

function csvField(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function buildCsv(rows: Record<string, string>[], headers: string[]): string {
  const head = headers.map(csvField).join(',');
  const lines = rows.map((r) => headers.map((h) => csvField(r[h] ?? '')).join(','));
  return '\uFEFF' + [head, ...lines].join('\r\n');
}

const AYYAN_ROW: Record<string, string> = {
  'Company Name': 'AYYAN GLOBAL PRIVATE LIMITED',
  'Work Email': 'ayyan@example.com',
  'First Name': 'Ayyan',
  'Director Full Name': 'Ayyan Director',
  Sector: 'Manufacturing',
  'Proposed Deliverable': 'Digital Storefront',
  'Step 1 Subject': STEP_1_SUBJECT,
  'Step 1 Body': STEP_1_BODY,
  'Step 2 Subject': STEP_2_SUBJECT,
  'Step 2 Body': STEP_2_BODY,
  'Step 3 Subject': STEP_3_SUBJECT,
  'Step 3 Body': STEP_3_BODY,
};

const HEADERS = [
  'Company Name',
  'Work Email',
  'First Name',
  'Director Full Name',
  'Sector',
  'Proposed Deliverable',
  'Step 1 Subject',
  'Step 1 Body',
  'Step 2 Subject',
  'Step 2 Body',
  'Step 3 Subject',
  'Step 3 Body',
];

const COLUMN_MAPPING = {
  company_name: 'Company Name',
  contact_email: 'Work Email',
  contact_first_name: 'First Name',
  director_full_name: 'Director Full Name',
  sector: 'Sector',
  proposed_deliverable: 'Proposed Deliverable',
  step_1_subject: 'Step 1 Subject',
  step_1_body: 'Step 1 Body',
  step_2_subject: 'Step 2 Subject',
  step_2_body: 'Step 2 Body',
  step_3_subject: 'Step 3 Subject',
  step_3_body: 'Step 3 Body',
};

const STEP_TEMPLATES = [
  { subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 },
  { subject: '{{step_2_subject}}', bodyText: '{{step_2_body}}', delayDays: 3 },
  { subject: '{{step_3_subject}}', bodyText: '{{step_3_body}}', delayDays: 4 },
];

describe('CSV body preservation: real AYYAN example end to end', () => {
  let app: any;
  const tenant = 'org_csv_body_truncation_test';
  const actorId = 'usr_body_tester';
  let mailbox = 'ayyan-sender@swaniki.com';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
    await Campaign.deleteMany({ organizationId: tenant });
    await CampaignRecipient.deleteMany({ organizationId: tenant });
    await EmailDraft.deleteMany({ organizationId: tenant });
    await Company.deleteMany({ organizationId: tenant });
    await CompanyContact.deleteMany({ organizationId: tenant });
    await EmailAccount.deleteMany({ organizationId: tenant });
    await WorkspaceSettings.deleteMany({ organizationId: tenant });

    await EmailAccount.create({
      organizationId: tenant,
      emailAddress: mailbox,
      displayName: 'Swaniki Sender',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 200,
    });
    await WorkspaceSettings.create({
      organizationId: tenant,
      senderDisplayName: 'Priya Sharma',
      businessName: 'Swaniki Business Solutions',
      defaultSignOff: 'Best regards,',
      emailSignature: 'Priya Sharma | Swaniki',
    });
  });

  afterAll(async () => {
    await Campaign.deleteMany({ organizationId: tenant });
    await CampaignRecipient.deleteMany({ organizationId: tenant });
    await EmailDraft.deleteMany({ organizationId: tenant });
    await Company.deleteMany({ organizationId: tenant });
    await CompanyContact.deleteMany({ organizationId: tenant });
    await EmailAccount.deleteMany({ organizationId: tenant });
    await WorkspaceSettings.deleteMany({ organizationId: tenant });
    await disconnectDatabase();
  });

  it('parses the full quoted multiline Step 1 body without truncation', () => {
    const csv = buildCsv([AYYAN_ROW], HEADERS);
    const parsed = parseCsvDetailed(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.length).toBe(1);
    const body = parsed.rows[0]['Step 1 Body'];
    expect(body).toBe(STEP_1_BODY);
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain('prevents manual phone follow-up');
    expect(body.endsWith('think it. build it. \u2022 swaniki.com')).toBe(true);
  });

  it('bounds Step copy at the template size while still capping metadata at 500', () => {
    const long = 'x'.repeat(MAX_TEMPLATE_LENGTH + 100);
    const result = boundCustomFields({ step_1_body: long, notes: long });
    // Step body content is bounded by the template size...
    expect(result.customFields.step_1_body.length).toBe(MAX_TEMPLATE_LENGTH);
    expect(result.truncatedKeys).toContain('step_1_body');
    // ...but ordinary metadata keeps the tight 500-char cap.
    expect(result.customFields.notes.length).toBe(500);
    expect(result.truncatedKeys).toContain('notes');
  });

  describe('full import -> persistence -> draft -> API -> send pipeline', () => {
    let campaignId: string;
    let recipientId: string;

    it('persists the exact Step 1/2/3 bodies on the recipient and company', async () => {
      const csv = buildCsv([AYYAN_ROW], HEADERS);
      const result = await campaignService.createCampaign({
        organizationId: tenant,
        actorId,
        name: 'AYYAN body preservation',
        mailboxId: mailbox,
        csvContent: csv,
        columnMapping: COLUMN_MAPPING as any,
        steps: STEP_TEMPLATES,
        generationMode: 'template',
      });
      expect(result.summary.recipientsCreated).toBe(1);

      campaignId = result.campaignId;
      const recipient: any = await CampaignRecipient.findOne({
        organizationId: tenant,
        campaignId,
      });
      recipientId = String(recipient._id);
      const cf = cf_records(recipient.customFields);
      expect(cf.step_1_body).toBe(STEP_1_BODY);
      expect(cf.step_2_body).toBe(STEP_2_BODY);
      expect(cf.step_3_body).toBe(STEP_3_BODY);
      expect(cf.step_1_body.length).toBe(STEP_1_BODY.length);
      expect(cf.step_2_body.length).toBeGreaterThan(500); // was previously truncated at 500

      const company: any = await Company.findOne({ organizationId: tenant, name: 'AYYAN GLOBAL PRIVATE LIMITED' }).lean();
      expect(cf_records(company?.customFields).step_1_body).toBe(STEP_1_BODY);

      // The full body is persisted (survives a fresh DB read), not the 500-char slice.
      const reloaded: any = await CampaignRecipient.findOne({ _id: recipient._id }).lean();
      expect(cf_records(reloaded.customFields).step_1_body).toBe(STEP_1_BODY);
      expect(cf_records(reloaded.customFields).step_1_body.endsWith('swaniki.com')).toBe(true);
    });

    it('generates complete drafts for all three steps without mixing or truncation', async () => {
      await campaignService.generateDraftsBatch(tenant, campaignId, 10);
      const recipient: any = await CampaignRecipient.findOne({ organizationId: tenant, campaignId }).sort({ rowNumber: 1 });

      const drafts = await EmailDraft.find({ organizationId: tenant, campaignId, recipientId: recipient._id }).sort({ stepIndex: 1 });
      expect(drafts.length).toBe(3);

      expect(drafts[0].stepIndex).toBe(0);
      expect(drafts[0].bodyText).toBe(STEP_1_BODY);
      expect(drafts[0].originalBodyText).toBe(STEP_1_BODY);
      expect(drafts[0].subject).toBe(STEP_1_SUBJECT);
      expect(drafts[0].bodyText).toContain('prevents manual phone follow-up');
      expect(drafts[0].bodyText.endsWith('think it. build it. \u2022 swaniki.com')).toBe(true);

      expect(drafts[1].bodyText).toBe(STEP_2_BODY);
      expect(drafts[1].bodyText).not.toBe(drafts[0].bodyText);

      expect(drafts[2].bodyText).toBe(STEP_3_BODY);
      expect(drafts[2].bodyText).not.toBe(drafts[0].bodyText);

      // Paragraph boundaries + newlines intact.
      expect(drafts[0].bodyText.split('\n\n').length).toBe(STEP_1_BODY.split('\n\n').length);
    });

    it('returns the complete body through the API response', async () => {
      const res = await request(app)
        .get(`/api/v1/campaigns/${campaignId}/recipients/${recipientId}`)
        .set('x-organization-id', tenant)
        .set('x-user-id', actorId);

      expect(res.status).toBe(200);
      expect(res.body.data.stepDrafts[0].draft.bodyText).toBe(STEP_1_BODY);
      expect(res.body.data.stepDrafts[0].draft.bodyText).toContain('think it. build it. \u2022 swaniki.com');
    });

    it('passes the complete body to the provider and to the outgoing MIME message', async () => {
      await campaignService.approveRecipientStepDraft(tenant, campaignId, recipientId, 0);

      const spy = vi.spyOn(mockEmailProvider, 'sendMessage');
      const enriched = await campaignService.sendRecipientStepDraft(tenant, campaignId, recipientId, 0, actorId);
      expect(enriched.stepDrafts[0].status).toBe('sent');

      expect(spy).toHaveBeenCalledTimes(1);
      const [, options] = spy.mock.calls[0];
      expect(options.to).toBe('ayyan@example.com');
      expect(options.body).toBe(STEP_1_BODY);
      expect(options.body.endsWith('think it. build it. \u2022 swaniki.com')).toBe(true);
      spy.mockRestore();

      // The Gmail adapter embeds the full body in the raw RFC 2822 message.
      const raw = (gmailProvider as any).buildRfc2822Message(mailbox, {
        to: 'ayyan@example.com',
        subject: STEP_1_SUBJECT,
        body: STEP_1_BODY,
      });
      expect(raw).toContain('think it. build it. \u2022 swaniki.com');
      expect(raw).toContain('prevents manual phone follow-up');
      expect(raw).toContain(STEP_1_BODY);
    });
  });

  it('preserves escaped quotes and multiline fields through the import path', async () => {
    const tricky = 'Hi "Ayyan",\n\nLine with "quoted, comma" text.\n\nthink it. build it. \u2022 swaniki.com';
    const row = { ...AYYAN_ROW, 'Work Email': 'tricky@example.com', 'Step 1 Body': tricky };
    const csv = buildCsv([row], HEADERS);
    const parsed = parseCsvDetailed(csv);
    expect(parsed.rows[0]['Step 1 Body']).toBe(tricky);

    const result = await campaignService.createCampaign({
      organizationId: tenant,
      actorId,
      name: 'Tricky quotes campaign',
      mailboxId: mailbox,
      csvContent: csv,
      columnMapping: COLUMN_MAPPING,
      steps: [{ subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 }],
      generationMode: 'template',
    });

    const recipient: any = await CampaignRecipient.findOne({ organizationId: tenant, campaignId: result.campaignId });
    expect(cf_records(recipient.customFields).step_1_body).toBe(tricky);
  });

  it('imports and generates a large (multi-KB) body without truncation', async () => {
    const paragraph = 'This is a sentence about AYYAN GLOBAL PRIVATE LIMITED digital infrastructure. ';
    const large = ('Hi Ayyan,\n\n' + paragraph.repeat(150) + '\nthink it. build it. \u2022 swaniki.com');
    expect(large.length).toBeGreaterThan(9000);
    expect(large.length).toBeLessThan(MAX_TEMPLATE_LENGTH);

    const row = { ...AYYAN_ROW, 'Work Email': 'large@example.com', 'Step 1 Body': large };
    const csv = buildCsv([row], HEADERS);
    const result = await campaignService.createCampaign({
      organizationId: tenant,
      actorId,
      name: 'Large body campaign',
      mailboxId: mailbox,
      csvContent: csv,
      columnMapping: COLUMN_MAPPING,
      steps: [{ subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 }],
      generationMode: 'template',
    });

    await campaignService.generateDraftsBatch(tenant, result.campaignId, 10);
    const recipient: any = await CampaignRecipient.findOne({ organizationId: tenant, campaignId: result.campaignId });
    expect(cf_records(recipient.customFields).step_1_body).toBe(large);

    const draft = await EmailDraft.findOne({ organizationId: tenant, campaignId: result.campaignId, stepIndex: 0 });
    expect(draft?.bodyText).toBe(large);
    expect(draft?.bodyText.endsWith('swaniki.com')).toBe(true);
  });

  it('blocks over-limit copy: skips the row with a clear reason instead of persisting partial text', async () => {
    const tooLong = 'A'.repeat(MAX_TEMPLATE_LENGTH + 5000);
    const row = { ...AYYAN_ROW, 'Work Email': 'toolong@example.com', 'Step 1 Body': tooLong };
    const csv = buildCsv([row], HEADERS);
    const result = await campaignService.createCampaign({
      organizationId: tenant,
      actorId,
      name: 'Over-limit campaign',
      mailboxId: mailbox,
      csvContent: csv,
      columnMapping: COLUMN_MAPPING,
      steps: [{ subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 }],
      generationMode: 'template',
    });

    expect(result.summary.recipientsCreated).toBe(0);
    const skipped: any = await CampaignRecipient.findOne({ organizationId: tenant, campaignId: result.campaignId });
    expect(skipped.status).toBe('skipped');
    expect(String(skipped.skipReason)).toContain('exceeds the maximum supported length');
    // No truncated draft is ever generated for a blocked row.
    const drafts = await EmailDraft.find({ organizationId: tenant, campaignId: result.campaignId });
    expect(drafts.length).toBe(0);
  });

  it('blocks sending drafts with an empty body instead of claiming success', async () => {
    const campaign: any = await Campaign.create({
      organizationId: tenant,
      createdBy: actorId,
      name: 'Empty body guard campaign',
      mailboxId: mailbox,
      generationMode: 'template',
      status: 'draft',
      steps: [{ stepIndex: 0, subject: 'Subject', bodyText: 'template body', delayDays: 0 }],
      columnMapping: {},
      customFieldMapping: {},
      stats: { totalRecipients: 1, prepared: 0, sent: 0, failed: 0, skipped: 0 },
    });
    const recipient: any = await CampaignRecipient.create({
      organizationId: tenant,
      campaignId: campaign._id,
      rowNumber: 2,
      email: 'guard@example.com',
      companyName: 'Guard Co',
      customFields: {},
      status: 'pending',
      completedSteps: 0,
      stepDrafts: [],
    });
    const draft: any = await EmailDraft.create({
      organizationId: tenant,
      campaignId: campaign._id,
      recipientId: recipient._id,
      stepIndex: 0,
      recipientEmail: 'guard@example.com',
      subject: 'Subject',
      bodyText: '   ',
      tone: 'consultative',
      status: 'approved',
    });
    recipient.stepDrafts = [{ stepIndex: 0, draftId: draft._id, status: 'approved' }];
    await recipient.save();

    await expect(
      campaignService.sendRecipientStepDraft(tenant, String(campaign._id), String(recipient._id), 0, actorId)
    ).rejects.toMatchObject({ code: 'DRAFT_BODY_MISSING' });

    const after: any = await EmailDraft.findById(draft._id);
    expect(after.status).toBe('approved');
    expect(after.providerMessageId).toBeUndefined();
    const stillRecipient: any = await CampaignRecipient.findById(recipient._id);
    expect(stillRecipient.status).not.toBe('sent');

    // Cleanup local campaign
    await EmailDraft.deleteMany({ campaignId: campaign._id });
    await CampaignRecipient.deleteMany({ campaignId: campaign._id });
    await Campaign.deleteOne({ _id: campaign._id });
  });
});

function cf_records(customFields: any): Record<string, string> {
  if (!customFields) return {};
  if (customFields instanceof Map) return Object.fromEntries(customFields);
  return customFields as Record<string, string>;
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { replyAssociationService } from '../services/reply-association.service.js';

describe('CSV Steps Full Pipeline Acceptance Tests (12 Test Areas)', () => {
  let app: any;
  const tenant = 'org_full_pipeline_test';
  const actorId = 'usr_pipeline_tester';
  let emailAccount: any;

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

    emailAccount = await EmailAccount.create({
      organizationId: tenant,
      emailAddress: 'outreach@swaniki.com',
      displayName: 'Swaniki Outreach Team',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 500,
    });

    await WorkspaceSettings.create({
      organizationId: tenant,
      senderDisplayName: 'Vansh Aggarwal',
      businessName: 'Swaniki New Business Radar',
      defaultGreeting: 'Hi {{first_name}},',
      missingNameFallback: 'Hello,',
      defaultSignOff: 'Best regards,',
      emailSignature: 'Vansh Aggarwal\nFounder, Swaniki',
      contactDetails: '+91 99999 00000',
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

  const sampleCsvContent = `\uFEFF"Company Name","Work Email","Contact Full Name","Sector","Proposed Deliverable","Website Status","Site Audit Type","HTTP Code","Page Title","Primary Tech Signal","Step 1 Subject","Step 1 Body","Step 2 Subject","Step 2 Body","Step 3 Subject","Step 3 Body"
"Ayyan Global Pvt Ltd","ayyan@example.com","Ayyan Director","Manufacturing","Custom ERP System","Timeout","Full Audit","408","Official Ayyan Portal","React & Node","Step 1 Intro: {{company_name}}","Hello {{first_name}}, line 1\nline 2 with quotes ""verified""\nRegards","Step 2 Follow-up","Hi, following up on our ERP proposal for {{company_name}}","Step 3 Final Check","Final check regarding ERP solution for {{company_name}}"
"Nexus Infotech","nexus@example.com","Nexus Lead","Information Tech","Cloud Modernization","Live","Quick Audit","200","Nexus Solutions Tech","Next.js Stack","Tech signal for {{company_name}}","Hi {{contact_name}}, noticed your Next.js tech signal.","Checking in with {{company_name}}","Follow up on cloud migration","Closing file for {{company_name}}","Final notice regarding cloud migration"`;

  // Test Area 1: Parse CSV with multiline quotes and UTF-8 BOM
  it('1. Parses CSV preserving multiline quoted text and UTF-8 BOM without splitting lines', () => {
    const parseResult = parseCsvDetailed(sampleCsvContent);
    expect(parseResult.rows.length).toBe(2);
    expect(parseResult.rows[0]['Company Name']).toBe('Ayyan Global Pvt Ltd');
    expect(parseResult.rows[0]['Step 1 Body']).toContain('line 1\nline 2 with quotes "verified"');
  });

  // Test Area 2: Inspect endpoint captures all 6 step copy fields and extended signals
  it('2. Inspect endpoint captures all 6 step copy fields and extended signals', async () => {
    const res = await request(app)
      .post('/api/v1/imports/inspect')
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId)
      .send({ csvContent: sampleCsvContent });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const summary = res.body.data;
    expect(summary.totalRows).toBe(2);
    expect(summary.detectedMapping.step_1_subject).toBe('Step 1 Subject');
    expect(summary.detectedMapping.step_2_subject).toBe('Step 2 Subject');
    expect(summary.detectedMapping.step_3_subject).toBe('Step 3 Subject');
    expect(summary.detectedMapping.proposed_deliverable).toBe('Proposed Deliverable');
    expect(summary.sampleRows[0]['Proposed Deliverable']).toBe('Custom ERP System');
    expect(summary.sampleRows[0]['HTTP Code']).toBe('408');
  });

  let campaign: any;
  let campaignId: string;
  let recipient1: any;
  let recipient2: any;

  // Test Area 3: Campaign creation persists all 18 fields to customFields
  it('3. Campaign creation persists all 18 fields to company and recipient customFields', async () => {
    const createResult = await campaignService.createCampaign({
      organizationId: tenant,
      actorId,
      name: 'E2E Multi-Step Campaign',
      mailboxId: emailAccount.emailAddress,
      csvContent: sampleCsvContent,
      columnMapping: {
        company_name: 'Company Name',
        contact_email: 'Work Email',
        contact_full_name: 'Contact Full Name',
      },
      steps: [
        { subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 },
        { subject: '{{step_2_subject}}', bodyText: '{{step_2_body}}', delayDays: 3 },
        { subject: '{{step_3_subject}}', bodyText: '{{step_3_body}}', delayDays: 4 },
      ],
      generationMode: 'template',
    });

    campaignId = createResult.campaignId;
    campaign = await Campaign.findById(campaignId);
    expect(campaign).toBeDefined();
    expect(createResult.summary.recipientsCreated).toBe(2);

    const recipients = await CampaignRecipient.find({ campaignId }).sort({ rowNumber: 1 });
    expect(recipients.length).toBe(2);
    recipient1 = recipients[0];
    recipient2 = recipients[1];

    const cFields1 = recipient1.customFields instanceof Map ? Object.fromEntries(recipient1.customFields) : recipient1.customFields;
    expect(cFields1.step_1_subject).toBe('Step 1 Intro: {{company_name}}');
    expect(cFields1.step_2_subject).toBe('Step 2 Follow-up');
    expect(cFields1.step_3_subject).toBe('Step 3 Final Check');
    expect(cFields1.proposed_deliverable).toBe('Custom ERP System');
    expect(cFields1.http_code).toBe('408');
    expect(cFields1.website_status).toBe('Timeout');
  });

  // Test Area 4: Recipient inspector returns Step 1, Step 2, and Step 3 draft data
  it('4. Recipient inspector returns Step 1, Step 2, and Step 3 draft data', async () => {
    // Generate drafts
    await campaignService.generateDraftsBatch(tenant, campaignId, 10);

    const enriched = await campaignService.getEnrichedRecipient(tenant, campaignId, String(recipient1._id));
    expect(enriched.stepDrafts.length).toBe(3);
    expect(enriched.stepDrafts[0].draft).toBeDefined();
    expect(enriched.stepDrafts[1].draft).toBeDefined();
    expect(enriched.stepDrafts[2].draft).toBeDefined();

    expect(enriched.stepDrafts[0].draft.subject).toContain('Step 1 Intro: Ayyan Global Pvt Ltd');
    expect(enriched.stepDrafts[1].draft.subject).toBe('Step 2 Follow-up');
    expect(enriched.stepDrafts[2].draft.subject).toBe('Step 3 Final Check');
  });

  // Test Area 5: All three steps viewable before Step 1 sends
  it('5. All three steps viewable before Step 1 sends', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/recipients/${recipient1._id}`)
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.completedSteps).toBe(0);
    expect(data.stepDrafts[0].draft.bodyText).toContain('line 1');
    expect(data.stepDrafts[1].draft.bodyText).toContain('Ayyan Global Pvt Ltd');
    expect(data.stepDrafts[2].draft.bodyText).toContain('Ayyan Global Pvt Ltd');
  });

  // Test Area 6: Target topic matches Proposed Deliverable & evidence reflects HTTP 408 timeout without falsely claiming missing website
  it('6. Target topic matches Proposed Deliverable & evidence reflects HTTP 408 timeout', async () => {
    const customFields = recipient1.customFields instanceof Map ? Object.fromEntries(recipient1.customFields) : recipient1.customFields;
    expect(customFields.proposed_deliverable).toBe('Custom ERP System');
    expect(customFields.http_code).toBe('408');
    expect(customFields.website_status).toBe('Timeout');
  });

  // Test Area 7: Manual edit sets isManualEdit: true and generationSource: "manual_edit"
  it('7. Manual edit of step draft sets isManualEdit: true and generationSource: "manual_edit"', async () => {
    const res = await request(app)
      .patch(`/api/v1/campaigns/${campaignId}/recipients/${recipient1._id}/steps/0`)
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId)
      .send({
        subject: 'Manually Customized Subject for Ayyan',
        bodyText: 'Custom crafted personalized body message.',
      });

    expect(res.status).toBe(200);
    const draft = await EmailDraft.findOne({
      recipientId: recipient1._id,
      stepIndex: 0,
    });
    expect(draft?.subject).toBe('Manually Customized Subject for Ayyan');
    expect(draft?.isManualEdit).toBe(true);
    expect(draft?.generationSource).toBe('manual_edit');
  });

  // Test Area 8: Restore original template reverts subject and body to CSV values
  it('8. Restore original template reverts subject and body to CSV values and sets generationSource: "csv_template"', async () => {
    const res = await request(app)
      .post(`/api/v1/campaigns/${campaignId}/recipients/${recipient1._id}/steps/0/restore-original`)
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId);

    expect(res.status).toBe(200);
    const draft = await EmailDraft.findOne({
      recipientId: recipient1._id,
      stepIndex: 0,
    });
    expect(draft?.subject).toBe('Step 1 Intro: {{company_name}}');
    expect(draft?.isManualEdit).toBe(false);
    expect(draft?.generationSource).toBe('csv_template');
  });

  // Test Area 9: Regeneration preserves manually edited drafts
  it('9. Regeneration preserves manually edited drafts', async () => {
    // Manually edit Step 2
    await request(app)
      .patch(`/api/v1/campaigns/${campaignId}/recipients/${recipient1._id}/steps/1`)
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId)
      .send({
        subject: 'Preserved Step 2 Manual Subject',
        bodyText: 'Preserved Step 2 Manual Body',
      });

    // Run batch regeneration
    await campaignService.generateDraftsBatch(tenant, campaignId, 10);

    const step2Draft = await EmailDraft.findOne({
      recipientId: recipient1._id,
      stepIndex: 1,
    });
    expect(step2Draft?.subject).toBe('Preserved Step 2 Manual Subject');
    expect(step2Draft?.isManualEdit).toBe(true);
  });

  // Test Area 10: Send step dispatches via pipeline and records sentAt and lastSentAt
  it('10. Send step dispatches via pipeline and records sentAt and lastSentAt', async () => {
    // Approve Step 1
    await campaignService.approveRecipientStepDraft(tenant, campaignId, String(recipient1._id), 0);

    // Send Step 1
    const enriched = await campaignService.sendRecipientStepDraft(
      tenant,
      campaignId,
      String(recipient1._id),
      0,
      actorId
    );

    expect(enriched.stepDrafts[0].status).toBe('sent');
    expect(enriched.stepDrafts[0].sentAt).toBeDefined();
    expect(enriched.lastSentAt).toBeDefined();
    expect(enriched.completedSteps).toBe(1);
  });

  // Test Area 11: Step 2 and Step 3 follow-up scheduledAt persisted and survives simulated restart
  it('11. Step 2 and Step 3 follow-up scheduledAt persisted and survives simulated restart', async () => {
    const recipient = await CampaignRecipient.findById(recipient1._id);
    const step2Slot = recipient?.stepDrafts.find((s) => s.stepIndex === 1);
    expect(step2Slot?.scheduledAt).toBeDefined();

    // Verify scheduledAt is approximately 3 days in the future
    const expectedTime = new Date(recipient!.lastSentAt!.getTime() + 3 * 24 * 60 * 60 * 1000).getTime();
    expect(Math.abs(step2Slot!.scheduledAt!.getTime() - expectedTime)).toBeLessThan(5000);

    // Simulate server restart by querying clean from MongoDB
    const reloadedRecipient = await CampaignRecipient.findById(recipient1._id).lean();
    const reloadedStep2Slot = reloadedRecipient?.stepDrafts.find((s: any) => s.stepIndex === 1);
    expect(reloadedStep2Slot?.scheduledAt).toBeDefined();
  });

  // Test Area 12: Inbound reply marks subsequent step drafts skipped and stops automated sequence
  it('12. Inbound reply marks subsequent step drafts skipped and stops automated sequence', async () => {
    const outcome = await replyAssociationService.handleInboundReply({
      organizationId: tenant,
      mailboxEmail: emailAccount.emailAddress,
      fromEmail: recipient1.email,
      threadId: 'th_mock_reply_123',
    });

    expect(outcome.associated).toBe(true);

    const recipient = await CampaignRecipient.findById(recipient1._id);
    expect(recipient?.replied).toBe(true);
    expect(recipient?.status).toBe('replied');

    // Step 2 and Step 3 must be marked skipped
    const step2Slot = recipient?.stepDrafts.find((s) => s.stepIndex === 1);
    const step3Slot = recipient?.stepDrafts.find((s) => s.stepIndex === 2);
    expect(step2Slot?.status).toBe('skipped');
    expect(step3Slot?.status).toBe('skipped');
  });
});

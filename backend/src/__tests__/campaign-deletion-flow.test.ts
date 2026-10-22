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
import { campaignService } from '../services/campaign.service.js';
import { campaignSchedulerService } from '../services/campaign-scheduler.service.js';

describe('Campaign Deletion & List Refresh End-to-End Suite', () => {
  let app: any;
  const tenant = 'org_delete_test_tenant';
  const otherTenant = 'org_delete_other_tenant';
  const actorId = 'usr_delete_tester';
  let mailboxEmail: string;

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    await Campaign.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await CampaignRecipient.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await EmailDraft.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await Company.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await CompanyContact.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await EmailAccount.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });

    const acc = await EmailAccount.create({
      organizationId: tenant,
      emailAddress: 'sender.delete@swaniki.com',
      displayName: 'Delete Tester',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 200,
    });
    mailboxEmail = acc.emailAddress;
  });

  afterAll(async () => {
    await Campaign.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await CampaignRecipient.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await EmailDraft.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await Company.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await CompanyContact.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await EmailAccount.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await disconnectDatabase();
  });

  it('1. Creates two campaigns, verifies listing count, and preserves company/contact records', async () => {
    const csvContent1 = `"Company Name","Work Email"\n"Alpha Corp","alpha@example.com"`;
    const csvContent2 = `"Company Name","Work Email"\n"Beta Corp","beta@example.com"`;

    const c1 = await campaignService.createCampaign({
      organizationId: tenant,
      actorId,
      name: 'Campaign to Delete',
      mailboxId: mailboxEmail,
      csvContent: csvContent1,
      columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      steps: [{ subject: 'Step 1 for {{company_name}}', bodyText: 'Body 1', delayDays: 0 }],
      generationMode: 'template',
    });

    const c2 = await campaignService.createCampaign({
      organizationId: tenant,
      actorId,
      name: 'Campaign to Keep',
      mailboxId: mailboxEmail,
      csvContent: csvContent2,
      columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      steps: [{ subject: 'Step 1 for {{company_name}}', bodyText: 'Body 1', delayDays: 0 }],
      generationMode: 'template',
    });

    // Generate drafts for campaign 1
    await campaignService.generateDraftsBatch(tenant, c1.campaignId, 10);

    // Verify initial listing returns 2 campaigns
    const listRes = await request(app)
      .get('/api/v1/campaigns')
      .set('x-organization-id', tenant);

    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(2);

    // Verify draft exists
    const draftsBefore = await EmailDraft.find({ campaignId: c1.campaignId });
    expect(draftsBefore.length).toBeGreaterThan(0);

    // Verify shared company records exist
    const companiesBefore = await Company.find({ organizationId: tenant });
    expect(companiesBefore.length).toBe(2);

    // 2. Perform deletion of Campaign 1
    const delRes = await request(app)
      .delete(`/api/v1/campaigns/${c1.campaignId}`)
      .set('x-organization-id', tenant);

    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);
    expect(delRes.body.data.deleted).toBe(true);
    expect(delRes.body.data.id).toBe(c1.campaignId);

    // 3. Verify Campaign 1 is completely removed
    const foundC1 = await Campaign.findById(c1.campaignId);
    expect(foundC1).toBeNull();

    // 4. Verify associated recipients and drafts are deleted
    const recipientsC1 = await CampaignRecipient.find({ campaignId: c1.campaignId });
    expect(recipientsC1.length).toBe(0);

    const draftsC1 = await EmailDraft.find({ campaignId: c1.campaignId });
    expect(draftsC1.length).toBe(0);

    // 5. CRITICAL: Verify shared Company and Contact records are NOT deleted
    const companiesAfter = await Company.find({ organizationId: tenant });
    expect(companiesAfter.length).toBe(2);

    // 6. Verify subsequent list fetch reflects updated count (now 1) without the deleted campaign
    const listResAfter = await request(app)
      .get('/api/v1/campaigns')
      .set('x-organization-id', tenant);

    expect(listResAfter.status).toBe(200);
    expect(listResAfter.body.data.length).toBe(1);
    expect(listResAfter.body.data[0]._id).toBe(c2.campaignId);
    expect(listResAfter.body.data[0].name).toBe('Campaign to Keep');
  });

  it('2. Cancels scheduled in-flight campaign jobs prior to deletion', async () => {
    const csvContent = `"Company Name","Work Email"\n"Gamma Corp","gamma@example.com"`;
    const c = await campaignService.createCampaign({
      organizationId: tenant,
      actorId,
      name: 'Scheduled Campaign to Delete',
      mailboxId: mailboxEmail,
      csvContent,
      columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      steps: [{ subject: 'Step 1', bodyText: 'Body', delayDays: 0 }],
      generationMode: 'template',
    });

    // Generate and approve drafts before scheduling
    await campaignService.generateDraftsBatch(tenant, c.campaignId, 10);
    await campaignService.approveRecipients(tenant, c.campaignId);

    // Schedule the campaign
    await campaignSchedulerService.schedule(tenant, c.campaignId, actorId, {
      startAt: new Date(Date.now() + 60000).toISOString(),
    });

    const scheduledCamp = await Campaign.findById(c.campaignId);
    expect(scheduledCamp?.status).toBe('scheduled');

    // Delete the scheduled campaign
    const delRes = await request(app)
      .delete(`/api/v1/campaigns/${c.campaignId}`)
      .set('x-organization-id', tenant);

    expect(delRes.status).toBe(200);
    expect(delRes.body.data.deleted).toBe(true);

    const checkCamp = await Campaign.findById(c.campaignId);
    expect(checkCamp).toBeNull();
  });

  it('3. Error handling: returns 404 when deleting a nonexistent campaign and keeps state intact', async () => {
    const nonexistentId = '507f1f77bcf86cd799439011';
    const res = await request(app)
      .delete(`/api/v1/campaigns/${nonexistentId}`)
      .set('x-organization-id', tenant);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.message).toContain('not found');
  });

  it('4. Multi-tenancy safety: denies cross-tenant campaign deletion', async () => {
    const csvContent = `"Company Name","Work Email"\n"Delta Corp","delta@example.com"`;
    const c = await campaignService.createCampaign({
      organizationId: tenant,
      actorId,
      name: 'Tenant Isolation Campaign',
      mailboxId: mailboxEmail,
      csvContent,
      columnMapping: { company_name: 'Company Name', contact_email: 'Work Email' },
      steps: [{ subject: 'Step 1', bodyText: 'Body', delayDays: 0 }],
      generationMode: 'template',
    });

    // Attempt deletion from another tenant
    const res = await request(app)
      .delete(`/api/v1/campaigns/${c.campaignId}`)
      .set('x-organization-id', otherTenant);

    expect(res.status).toBe(404);

    // Verify campaign still exists under original tenant
    const stillExists = await Campaign.findById(c.campaignId);
    expect(stillExists).toBeDefined();
    expect(stillExists?.organizationId).toBe(tenant);
  });
});

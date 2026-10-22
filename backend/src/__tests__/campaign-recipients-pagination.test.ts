import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailDraft } from '../models/EmailDraft.js';

describe('Campaigns Pagination & Filtering Integration Suite', () => {
  let app: any;
  const tenantA = 'org_test_pagination_tenant_a';
  const tenantB = 'org_test_pagination_tenant_b';
  let campaignAId: string;
  let campaignBId: string;

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    // Clean up test tenants
    await CampaignRecipient.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });
    await Campaign.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });
    await EmailDraft.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });

    // Create Campaign in Tenant A
    const campA = await Campaign.create({
      organizationId: tenantA,
      createdBy: 'user_test_pagination_a',
      name: 'Pagination Test Campaign A',
      mailboxId: 'sender@tenant-a.com',
      status: 'draft',
      steps: [
        { stepIndex: 0, subject: 'Step 1 Subject', bodyText: 'Step 1 Body', delayDays: 0 },
        { stepIndex: 1, subject: 'Step 2 Subject', bodyText: 'Step 2 Body', delayDays: 3 },
      ],
      stats: { totalRecipients: 105, prepared: 0, sent: 0, failed: 0, skipped: 0, replied: 0 },
    });
    campaignAId = String(campA._id);

    // Create 105 recipients for Campaign A to test multi-page pagination with pageSize 50
    const recipientsA = [];
    for (let i = 1; i <= 105; i++) {
      recipientsA.push({
        organizationId: tenantA,
        campaignId: campA._id,
        rowNumber: i,
        email: `prospect${i.toString().padStart(4, '0')}@example.com`,
        name: `Prospect Name ${i}`,
        companyName: i === 42 ? 'Special Searchable Corp' : `Company ${i}`,
        customFields: { sector: i % 2 === 0 ? 'Tech' : 'Retail' },
        status: i === 10 ? 'skipped' : i === 20 ? 'failed' : 'pending',
        completedSteps: 0,
        stepDrafts: [],
      });
    }
    await CampaignRecipient.insertMany(recipientsA);

    // Create Campaign in Tenant B for tenant isolation test
    const campB = await Campaign.create({
      organizationId: tenantB,
      createdBy: 'user_test_pagination_b',
      name: 'Tenant B Secret Campaign',
      mailboxId: 'sender@tenant-b.com',
      status: 'draft',
      steps: [{ stepIndex: 0, subject: 'Secret Subject', bodyText: 'Secret Body', delayDays: 0 }],
      stats: { totalRecipients: 5, prepared: 0, sent: 0, failed: 0, skipped: 0, replied: 0 },
    });
    campaignBId = String(campB._id);

    const recipientsB = [];
    for (let i = 1; i <= 5; i++) {
      recipientsB.push({
        organizationId: tenantB,
        campaignId: campB._id,
        rowNumber: i,
        email: `secret_tenant_b_${i}@private.org`,
        name: `Secret Contact ${i}`,
        companyName: `Tenant B Corp ${i}`,
        status: 'pending',
        completedSteps: 0,
        stepDrafts: [],
      });
    }
    await CampaignRecipient.insertMany(recipientsB);
  }, 60000);

  afterAll(async () => {
    await CampaignRecipient.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });
    await Campaign.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });
    await EmailDraft.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });
    await disconnectDatabase();
  }, 60000);

  it('1. Page 1 returns at most 50 records with pagination metadata', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?page=1&limit=50`)
      .set('x-organization-id', tenantA);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.recipients).toHaveLength(50);
    expect(res.body.data.total).toBe(105);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(50);
    expect(res.body.data.totalPages).toBe(3);
    expect(res.body.data.hasNextPage).toBe(true);
    expect(res.body.data.hasPreviousPage).toBe(false);
    expect(res.body.data.recipients[0].rowNumber).toBe(1);
    expect(res.body.data.recipients[49].rowNumber).toBe(50);
  });

  it('2. Page 2 returns the next records without duplicates', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?page=2&limit=50`)
      .set('x-organization-id', tenantA);

    expect(res.status).toBe(200);
    expect(res.body.data.recipients).toHaveLength(50);
    expect(res.body.data.page).toBe(2);
    expect(res.body.data.hasNextPage).toBe(true);
    expect(res.body.data.hasPreviousPage).toBe(true);
    expect(res.body.data.recipients[0].rowNumber).toBe(51);
    expect(res.body.data.recipients[49].rowNumber).toBe(100);
  });

  it('3. The final page (Page 3) returns the remaining 5 records', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?page=3&limit=50`)
      .set('x-organization-id', tenantA);

    expect(res.status).toBe(200);
    expect(res.body.data.recipients).toHaveLength(5);
    expect(res.body.data.page).toBe(3);
    expect(res.body.data.totalPages).toBe(3);
    expect(res.body.data.hasNextPage).toBe(false);
    expect(res.body.data.hasPreviousPage).toBe(true);
    expect(res.body.data.recipients[0].rowNumber).toBe(101);
    expect(res.body.data.recipients[4].rowNumber).toBe(105);
  });

  it('4. Custom page-size changes work (e.g., limit=25, limit=100, limit=200)', async () => {
    const res25 = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?page=1&limit=25`)
      .set('x-organization-id', tenantA);

    expect(res25.status).toBe(200);
    expect(res25.body.data.recipients).toHaveLength(25);
    expect(res25.body.data.totalPages).toBe(5);

    const res100 = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?page=1&limit=100`)
      .set('x-organization-id', tenantA);

    expect(res100.status).toBe(200);
    expect(res100.body.data.recipients).toHaveLength(100);
    expect(res100.body.data.totalPages).toBe(2);

    const res200 = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?page=1&limit=200`)
      .set('x-organization-id', tenantA);

    expect(res200.status).toBe(200);
    expect(res200.body.data.recipients).toHaveLength(105);
    expect(res200.body.data.totalPages).toBe(1);
  });

  it('5. Search filtering returns exact matching records and count', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?search=Special+Searchable`)
      .set('x-organization-id', tenantA);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.recipients).toHaveLength(1);
    expect(res.body.data.recipients[0].companyName).toBe('Special Searchable Corp');
    expect(res.body.data.recipients[0].rowNumber).toBe(42);
  });

  it('6. Status filtering returns matching records and count', async () => {
    const resSkipped = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?status=skipped`)
      .set('x-organization-id', tenantA);

    expect(resSkipped.status).toBe(200);
    expect(resSkipped.body.data.total).toBe(1);
    expect(resSkipped.body.data.recipients[0].rowNumber).toBe(10);
    expect(resSkipped.body.data.recipients[0].status).toBe('skipped');

    const resFailed = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?status=failed`)
      .set('x-organization-id', tenantA);

    expect(resFailed.status).toBe(200);
    expect(resFailed.body.data.total).toBe(1);
    expect(resFailed.body.data.recipients[0].rowNumber).toBe(20);
    expect(resFailed.body.data.recipients[0].status).toBe('failed');
  });

  it('7. Handles invalid and boundary page/limit values safely', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/recipients?page=-5&limit=99999`)
      .set('x-organization-id', tenantA);

    expect(res.status).toBe(200);
    // Page clamped to 1, limit clamped to 200
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(200);
  });

  it('8. Enforces tenant isolation (Tenant A cannot see Tenant B recipients)', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignBId}/recipients`)
      .set('x-organization-id', tenantA);

    // Tenant A querying Tenant B's campaign returns 404
    expect(res.status).toBe(404);
  });

  it('9. Empty campaigns return 0 recipients with valid pagination structure', async () => {
    const emptyCamp = await Campaign.create({
      organizationId: tenantA,
      createdBy: 'user_test_pagination_a',
      name: 'Empty Campaign',
      mailboxId: 'sender@tenant-a.com',
      status: 'draft',
      steps: [{ stepIndex: 0, subject: 'Subject', bodyText: 'Body', delayDays: 0 }],
      stats: { totalRecipients: 0, prepared: 0, sent: 0, failed: 0, skipped: 0, replied: 0 },
    });

    const res = await request(app)
      .get(`/api/v1/campaigns/${emptyCamp._id}/recipients`)
      .set('x-organization-id', tenantA);

    expect(res.status).toBe(200);
    expect(res.body.data.recipients).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.totalPages).toBe(1);
    expect(res.body.data.hasNextPage).toBe(false);
    expect(res.body.data.hasPreviousPage).toBe(false);
  });
});

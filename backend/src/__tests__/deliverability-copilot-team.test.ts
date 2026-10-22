import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailThread } from '../models/EmailThread.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { Suppression } from '../models/Suppression.js';
import { User } from '../models/User.js';
import { ActivityLog } from '../models/ActivityLog.js';

describe('Enterprise Features: Deliverability, Copilot, Team & Search Suite', () => {
  let app: any;
  const tenant = 'org_enterprise_test';
  const otherTenant = 'org_enterprise_other';
  const actorId = 'usr_ent_tester';
  const mailboxEmail = 'outreach.enterprise@example.com';
  let testCampaignId: string;

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    await EmailAccount.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await EmailThread.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await Company.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await CompanyContact.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await Campaign.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await CampaignRecipient.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await Suppression.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await User.deleteMany({ 'organizations.organizationId': { $in: [tenant, otherTenant] } });
    await ActivityLog.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });

    // Seed Mailbox
    await EmailAccount.create({
      organizationId: tenant,
      emailAddress: mailboxEmail,
      displayName: 'Enterprise Outreach',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 150,
      sendsToday: 5,
    });

    // Seed Company & Contact
    const comp = await Company.create({
      organizationId: tenant,
      name: 'OmniCorp Logistics',
      domain: 'omnicorp.example.com',
      industry: 'Freight & Logistics',
      city: 'Chicago',
      overallRating: 'A',
    });

    await CompanyContact.create({
      organizationId: tenant,
      companyId: comp._id,
      fullName: 'Sarah Connor',
      email: 'sarah@omnicorp.example.com',
      role: 'Operations Director',
    });

    // Seed Thread
    await EmailThread.create({
      organizationId: tenant,
      mailboxEmail,
      threadId: 'th_ent_001',
      subject: 'Streamlining cold-chain operations',
      snippet: 'We would love to jump on a quick 15-min call to discuss benchmarks.',
      lastMessageDate: new Date(),
      messageCount: 2,
      isRead: true,
      labels: ['INBOX'],
      lastFromName: 'Sarah Connor',
      lastFromEmail: 'sarah@omnicorp.example.com',
      participants: [mailboxEmail, 'sarah@omnicorp.example.com'],
      companyName: 'OmniCorp Logistics',
      companyId: comp._id,
      messages: [
        {
          id: 'msg_1',
          from: { name: 'Vansh', email: mailboxEmail },
          to: [{ name: 'Sarah', email: 'sarah@omnicorp.example.com' }],
          subject: 'Streamlining cold-chain operations',
          bodyText: 'Hi Sarah, noticed your logistics expansion. Can we discuss your sub-second routing?',
          snippet: 'Hi Sarah, noticed your logistics expansion...',
          date: new Date(Date.now() - 3600000 * 24),
          isRead: true,
          isStarred: false,
          hasAttachments: false,
        },
        {
          id: 'msg_2',
          from: { name: 'Sarah Connor', email: 'sarah@omnicorp.example.com' },
          to: [{ name: 'Vansh', email: mailboxEmail }],
          subject: 'Re: Streamlining cold-chain operations',
          bodyText: 'We would love to jump on a quick 15-min call to discuss benchmarks. Do you have time Thursday at 2pm?',
          snippet: 'We would love to jump on a quick 15-min call...',
          date: new Date(),
          isRead: true,
          isStarred: false,
          hasAttachments: false,
        },
      ],
    });

    // Seed Campaign
    const cmp = await Campaign.create({
      organizationId: tenant,
      name: 'Q4 Enterprise Inbound Drive',
      status: 'sending',
      createdBy: actorId,
      mailboxId: mailboxEmail,
      tone: 'professional',
      generationMode: 'template',
      stats: {
        totalRecipients: 10,
        prepared: 10,
        sent: 8,
        failed: 0,
        skipped: 1,
        replied: 2,
      },
    });
    testCampaignId = String(cmp._id);

    await CampaignRecipient.create({
      organizationId: tenant,
      campaignId: cmp._id,
      rowNumber: 1,
      email: 'sarah@omnicorp.example.com',
      companyName: 'OmniCorp Logistics',
      contactName: 'Sarah Connor',
      status: 'sent',
      completedSteps: 1,
      repliesReceived: 1,
      hasReplied: true,
      lastReplySnippet: 'We would love to jump on a quick 15-min call...',
      stepSendStatus: {
        step1: 'sent',
        step2: 'not_sent',
        step3: 'not_sent',
      },
    });
  });

  afterAll(async () => {
    await EmailAccount.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await EmailThread.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await Company.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await CompanyContact.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await Campaign.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await CampaignRecipient.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await Suppression.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await User.deleteMany({ 'organizations.organizationId': { $in: [tenant, otherTenant] } });
    await ActivityLog.deleteMany({ organizationId: { $in: [tenant, otherTenant] } });
    await disconnectDatabase();
  });

  it('1. Deliverability Overview & Suppression Management', async () => {
    const res = await request(app)
      .get('/api/v1/deliverability/overview')
      .set('x-organization-id', tenant);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.score).toBeDefined();
    expect(res.body.data.grade).toBeDefined();
    expect(res.body.data.mailboxes).toHaveLength(1);
    expect(res.body.data.mailboxes[0].emailAddress).toBe(mailboxEmail);

    // Add suppression
    const supRes = await request(app)
      .post('/api/v1/deliverability/suppressions')
      .set('x-organization-id', tenant)
      .send({ email: 'optout@example.com', reason: 'unsubscribed' });

    expect(supRes.status).toBe(201);
    expect(supRes.body.success).toBe(true);

    // List suppressions
    const listRes = await request(app)
      .get('/api/v1/deliverability/suppressions')
      .set('x-organization-id', tenant);

    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((s: any) => s.email === 'optout@example.com')).toBe(true);

    // Remove suppression
    const delRes = await request(app)
      .delete('/api/v1/deliverability/suppressions/optout@example.com')
      .set('x-organization-id', tenant);

    expect(delRes.status).toBe(200);
  });

  it('2. AI Inbox Copilot generates summaries, action items, and tone variants', async () => {
    const tones = ['consultative', 'direct', 'friendly', 'formal', 'urgent'] as const;

    for (const tone of tones) {
      const res = await request(app)
        .post(`/api/v1/mailboxes/${mailboxEmail}/threads/th_ent_001/copilot`)
        .set('x-organization-id', tenant)
        .send({ tone });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.summary).toBeTruthy();
      expect(res.body.data.actionItems.length).toBeGreaterThan(0);
      expect(res.body.data.suggestedNextSteps.length).toBeGreaterThan(0);
      expect(res.body.data.sentiment).toBe('scheduling');
      expect(res.body.data.draftReply.tone).toBe(tone);
      expect(res.body.data.draftReply.bodyText).toBeTruthy();
    }
  });

  it('3. Team Collaboration, Member Roles, and Audit Activity Logging', async () => {
    // Invite member
    const inviteRes = await request(app)
      .post('/api/v1/team/invite')
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId)
      .send({
        email: 'alex.sales@example.com',
        fullName: 'Alex Vance',
        role: 'sales_rep',
      });

    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.success).toBe(true);
    const memberId = inviteRes.body.data._id;

    // List members
    const membersRes = await request(app)
      .get('/api/v1/team/members')
      .set('x-organization-id', tenant);

    expect(membersRes.status).toBe(200);
    expect(membersRes.body.data.some((m: any) => m.email === 'alex.sales@example.com')).toBe(true);

    // Update role
    const patchRes = await request(app)
      .patch(`/api/v1/team/members/${memberId}`)
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId)
      .send({ role: 'manager' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.role).toBe('manager');

    // Verify activity log captured events
    const actRes = await request(app)
      .get('/api/v1/team/activity')
      .set('x-organization-id', tenant);

    expect(actRes.status).toBe(200);
    expect(actRes.body.data.length).toBeGreaterThanOrEqual(2);
    expect(actRes.body.data.some((a: any) => a.action === 'team.member_invited')).toBe(true);
  });

  it('4. Unified Search across companies, contacts, campaigns, and threads', async () => {
    const res = await request(app)
      .get('/api/v1/search?q=omni')
      .set('x-organization-id', tenant);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.companies.length).toBeGreaterThan(0);
    expect(res.body.data.companies[0].title).toBe('OmniCorp Logistics');

    // Search campaign
    const campSearch = await request(app)
      .get('/api/v1/search?q=Inbound')
      .set('x-organization-id', tenant);

    expect(campSearch.status).toBe(200);
    expect(campSearch.body.data.campaigns.length).toBeGreaterThan(0);
    expect(campSearch.body.data.campaigns[0].title).toBe('Q4 Enterprise Inbound Drive');
  });

  it('5. Analytics Overview returns real persisted campaign metrics', async () => {
    const res = await request(app)
      .get('/api/v1/analytics/overview')
      .set('x-organization-id', tenant);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.campaigns).toBeDefined();
    expect(res.body.data.campaigns.total).toBe(1);
    expect(res.body.data.campaigns.topCampaigns).toHaveLength(1);
    expect(res.body.data.campaigns.topCampaigns[0].sent).toBe(8);
  });

  it('6. Campaign CSV Export returns CSV report with recipient details', async () => {
    const res = await request(app)
      .get(`/api/v1/campaigns/${testCampaignId}/export`)
      .set('x-organization-id', tenant);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Email');
    expect(res.text).toContain('sarah@omnicorp.example.com');
    expect(res.text).toContain('OmniCorp Logistics');
    expect(res.text).toContain('Step 1 Status');
  });
});

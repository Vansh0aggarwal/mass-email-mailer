import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { WorkspaceSettings } from '../models/WorkspaceSettings.js';

describe('Workspace Sender Settings Integration', () => {
  let app: any;
  const tenantA = 'org_sender_test_a';
  const tenantB = 'org_sender_test_b';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
  });

  afterAll(async () => {
    await WorkspaceSettings.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });
    await EmailAccount.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });
    await disconnectDatabase();
  });

  it('GET /api/v1/settings/sender returns seeded default settings for a fresh organization', async () => {
    const res = await request(app)
      .get('/api/v1/settings/sender')
      .set('x-organization-id', tenantA);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.organizationId).toBe(tenantA);
    expect(res.body.data.senderDisplayName).toBe('Vansh Aggarwal');
    expect(res.body.data.defaultTimezone).toBe('Asia/Kolkata');
    expect(res.body.data.dailySendCap).toBe(100);
    expect(res.body.data.batchSize).toBe(25);
    expect(res.body.data.paceMinutes).toBe(15);
    expect(res.body.data.defaultFollowUpIntervalDays).toBe(3);
    expect(res.body.data.missingNameFallback).toBe('Hello,');
  });

  it('PUT /api/v1/settings/sender rejects authorizedMailbox if mailbox does not belong to tenant', async () => {
    const res = await request(app)
      .put('/api/v1/settings/sender')
      .set('x-organization-id', tenantA)
      .send({
        senderDisplayName: 'Lead Director',
        authorizedMailbox: 'unauthorized@example.com',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED_MAILBOX');
  });

  it('PUT /api/v1/settings/sender updates settings when mailbox is authorized', async () => {
    // Connect a mailbox for tenantA
    await EmailAccount.create({
      organizationId: tenantA,
      emailAddress: 'outreach@swaniki.com',
      displayName: 'Swaniki Official Mailbox',
      provider: 'gmail',
      status: 'connected',
      dailySendLimit: 100,
    });

    const res = await request(app)
      .put('/api/v1/settings/sender')
      .set('x-organization-id', tenantA)
      .send({
        senderDisplayName: 'Ananya Sharma',
        businessName: 'Swaniki Digital',
        businessDescription: 'Premium web performance and cloud portal engineering.',
        authorizedMailbox: 'outreach@swaniki.com',
        defaultGreeting: 'Hello {{first_name}}',
        missingNameFallback: 'there',
        defaultSignOff: 'Warm regards',
        emailSignature: 'Ananya Sharma | Swaniki Digital',
        contactDetails: '+91 98765 43210',
        defaultTimezone: 'Asia/Kolkata',
        sendingWindowStartHour: 9,
        sendingWindowEndHour: 18,
        dailySendCap: 80,
        batchSize: 15,
        paceMinutes: 20,
        defaultFollowUpIntervalDays: 4,
        preferredTone: 'consultative',
        preferredLength: 'medium',
        preferredLanguage: 'English',
        defaultServiceOffering: 'Web Portal Modernization',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.senderDisplayName).toBe('Ananya Sharma');
    expect(res.body.data.businessName).toBe('Swaniki Digital');
    expect(res.body.data.authorizedMailbox).toBe('outreach@swaniki.com');
    expect(res.body.data.dailySendCap).toBe(80);
    expect(res.body.data.defaultServiceOffering).toBe('Web Portal Modernization');
  });

  it('Strict multi-tenant isolation: Tenant B does not see Tenant A updates', async () => {
    const resB = await request(app)
      .get('/api/v1/settings/sender')
      .set('x-organization-id', tenantB);

    expect(resB.status).toBe(200);
    expect(resB.body.success).toBe(true);
    expect(resB.body.data.organizationId).toBe(tenantB);
    expect(resB.body.data.senderDisplayName).toBe('Vansh Aggarwal');
    expect(resB.body.data.authorizedMailbox).toBeUndefined();
    expect(resB.body.data.dailySendCap).toBe(100);
  });
});

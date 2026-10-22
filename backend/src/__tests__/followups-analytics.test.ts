import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Company } from '../models/Company.js';
import { FollowUpTask } from '../models/FollowUpTask.js';

describe('Stage 7: Follow-ups & Analytics Suite', () => {
  let app: any;
  const tenant = 'org_test_analytics_tenant';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it('should create and complete a follow-up task', async () => {
    const createRes = await request(app)
      .post('/api/v1/follow-ups')
      .set('x-organization-id', tenant)
      .send({
        companyName: 'Helios Solar',
        contactEmail: 'contact@helios.example.com',
        dueDate: new Date(Date.now() + 86400000 * 3).toISOString(),
        notes: 'Check back after sending ROI calculator',
        priority: 'high',
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.data.status).toBe('pending');
    expect(createRes.body.data.priority).toBe('high');

    const taskId = createRes.body.data._id;

    // Complete task
    const patchRes = await request(app)
      .patch(`/api/v1/follow-ups/${taskId}`)
      .set('x-organization-id', tenant)
      .send({ status: 'completed' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.status).toBe('completed');
  });

  it('GET /api/v1/analytics/overview should return comprehensive metrics', async () => {
    // Seed test company
    await Company.create({
      organizationId: tenant,
      name: 'Omni Media',
      industry: 'Publishing',
      overallRating: 'A',
    });

    const res = await request(app)
      .get('/api/v1/analytics/overview')
      .set('x-organization-id', tenant);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.companies.totalTracked).toBeGreaterThanOrEqual(1);
    expect(res.body.data.contacts).toBeDefined();
    expect(res.body.data.drafts).toBeDefined();
    expect(res.body.data.sendPipeline).toBeDefined();
  });
});

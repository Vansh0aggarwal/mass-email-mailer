import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Company } from '../models/Company.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { generateDeterministicFallback } from '../providers/ai/ai-grounding.service.js';

describe('Stage 4: AI Email Studio & Grounded Drafting Suite', () => {
  let app: any;
  const tenant = 'org_test_ai_tenant';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  describe('AI Grounding and Anti-Hallucination Unit Logic', () => {
    it('should generate grounded drafts using verified facts without inventing flaws or audit claims', () => {
      const output = generateDeterministicFallback(
        {
          companyName: 'Vertex Medical Systems',
          recipientEmail: 'sarah@vertex.example.com',
          recipientName: 'Sarah Jenkins',
          industry: 'Medical Devices',
          targetService: 'Speed Optimization',
          serviceValueProposition: 'Sub-second mobile checkout',
          tone: 'consultative',
          senderName: 'Vansh Aggarwal',
        },
        'Unit testing fallback'
      );

      // Verify facts
      expect(output.subject).toContain('Speed Optimization');
      expect(output.subject).toContain('Vertex Medical Systems');
      expect(output.bodyText).toContain('Hi Sarah Jenkins,');
      expect(output.bodyText).toContain('Medical Devices');
      expect(output.factsUsed).toContain('Company: Vertex Medical Systems');

      // Verify anti-hallucination warning and human-review flag
      expect(output.warnings.some((w) => w.includes('human review required'))).toBe(true);
      expect(output.warnings.some((w) => w.includes('deterministic fallback'))).toBe(true);

      // Verify that unverified ratings are marked in missingInformation, not assumed zero
      expect(output.missingInformation.some((m) => m.includes('unrecorded'))).toBe(true);
    });

    it('should adapt structure for concise and friendly tones', () => {
      const concise = generateDeterministicFallback(
        {
          companyName: 'Nova Retail',
          recipientEmail: 'ceo@novaretail.example.com',
          targetService: 'Website Redesign',
          tone: 'concise',
        },
        'Concise test'
      );
      expect(concise.bodyText.length).toBeLessThan(400);

      const friendly = generateDeterministicFallback(
        {
          companyName: 'Nova Retail',
          recipientEmail: 'ceo@novaretail.example.com',
          targetService: 'Website Redesign',
          tone: 'friendly',
        },
        'Friendly test'
      );
      expect(friendly.bodyText).toContain('Hope you are having a wonderful week');
    });
  });

  describe('Drafts REST Lifecycle Integration', () => {
    it('POST /api/v1/drafts/generate should produce a draft in "draft" status', async () => {
      const company = await Company.create({
        organizationId: tenant,
        name: 'Horizon Robotics',
        industry: 'Industrial Automation',
        overallRating: 'B',
      });

      const res = await request(app)
        .post('/api/v1/drafts/generate')
        .set('x-organization-id', tenant)
        .send({
          companyId: company._id.toString(),
          companyName: company.name,
          recipientEmail: 'contact@horizonrobotics.example.com',
          recipientName: 'Marcus Vance',
          targetService: 'Website Redesign',
          tone: 'consultative',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.recipientEmail).toBe('contact@horizonrobotics.example.com');
      expect(res.body.data.isFallbackTemplate).toBe(true);

      const draftId = res.body.data._id;

      // PUT /api/v1/drafts/:id to update/edit
      const updateRes = await request(app)
        .put(`/api/v1/drafts/${draftId}`)
        .set('x-organization-id', tenant)
        .send({
          subject: 'Customized Human Reviewed Subject',
          bodyText: 'Updated content with custom personal note.',
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.subject).toBe('Customized Human Reviewed Subject');

      // POST /api/v1/drafts/:id/approve to approve
      const approveRes = await request(app)
        .post(`/api/v1/drafts/${draftId}/approve`)
        .set('x-organization-id', tenant);

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.data.status).toBe('approved');

      // Verify status in DB
      const dbDraft = await EmailDraft.findById(draftId);
      expect(dbDraft?.status).toBe('approved');
    });
  });
});

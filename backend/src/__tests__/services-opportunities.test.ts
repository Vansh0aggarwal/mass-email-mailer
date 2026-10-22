import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Company } from '../models/Company.js';
import { evaluateOpportunity } from '../services/opportunity-scoring.service.js';

describe('Stage 3: Services & Recommendations Engine', () => {
  let app: any;
  const tenant = 'org_test_services_tenant';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  describe('Recommendation Scoring Unit Engine', () => {
    const mockCatalog = [
      {
        id: 'svc_web_01',
        name: 'Website Redesign',
        code: 'website-redesign',
        description: 'Modern web development',
        valueProposition: 'Higher conversions',
        triggerKeywords: ['website', 'redesign'],
        isActive: true,
      },
      {
        id: 'svc_seo_01',
        name: 'SEO & Search Optimization',
        code: 'seo-growth',
        description: 'Organic search',
        valueProposition: 'Top rankings',
        triggerKeywords: ['seo', 'search'],
        isActive: true,
      },
    ];

    it('should prioritize explicit company requirements as primary evidence', () => {
      const result = evaluateOpportunity({
        company: {
          id: 'c1',
          name: 'Starlight Tech',
          overallRating: 'unrated',
          services: ['Website Redesign'],
        },
        availableCatalogServices: mockCatalog,
      });

      expect(result.score).toBeGreaterThanOrEqual(60);
      expect(result.isQualified).toBe(true);
      expect(result.recommendedServices[0].serviceName).toBe('Website Redesign');
      expect(result.evidence.some((e) => e.type === 'explicit_need')).toBe(true);
      // Missing rating should NOT penalize as 0 or invent a flaw
      expect(result.missingDataWarnings.some((w) => w.includes('not assumed zero'))).toBe(true);
    });

    it('should recommend redesign when digital health rating is low (D) as supporting evidence', () => {
      const result = evaluateOpportunity({
        company: {
          id: 'c2',
          name: 'Old Mill Craft',
          overallRating: 'D',
          services: [],
        },
        availableCatalogServices: mockCatalog,
      });

      expect(result.recommendedServices.some((s) => s.serviceName === 'Website Redesign')).toBe(true);
      expect(result.evidence.some((e) => e.type === 'assessment')).toBe(true);
    });

    it('should combine multiple services into a coherent pitch summary', () => {
      const result = evaluateOpportunity({
        company: {
          id: 'c3',
          name: 'Global Logistics',
          overallRating: 'unrated',
          services: ['Website Redesign', 'SEO & Search Optimization'],
        },
        availableCatalogServices: mockCatalog,
      });

      expect(result.recommendedServices).toHaveLength(2);
      expect(result.pitchSummary).toContain('Website Redesign and SEO & Search Optimization');
    });
  });

  describe('Services & Opportunities REST Integration', () => {
    it('GET /api/v1/services should auto-seed default catalog for new tenant', async () => {
      const res = await request(app)
        .get('/api/v1/services')
        .set('x-organization-id', tenant);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(4);
      expect(res.body.data.some((s: any) => s.code === 'website-redesign')).toBe(true);
    });

    it('GET /api/v1/opportunities should evaluate recommendations for companies in tenant', async () => {
      // Create a test company with explicit service
      await Company.create({
        organizationId: tenant,
        name: 'Quantum Bio',
        industry: 'Biotechnology',
        overallRating: 'C',
        services: ['website'],
      });

      const res = await request(app)
        .get('/api/v1/opportunities')
        .set('x-organization-id', tenant);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);

      const target = res.body.data.find((o: any) => o.companyName === 'Quantum Bio');
      expect(target).toBeDefined();
      expect(target.recommendedServices.length).toBeGreaterThan(0);
      expect(target.evidence.length).toBeGreaterThan(0);
    });

    it('GET /api/v1/templates should auto-seed default email templates', async () => {
      const res = await request(app)
        .get('/api/v1/templates')
        .set('x-organization-id', tenant);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(3);
      expect(res.body.data[0].variables).toContain('company_name');
    });
  });
});

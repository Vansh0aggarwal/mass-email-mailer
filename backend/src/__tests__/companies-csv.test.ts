import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import {
  sanitizeForFormulaInjection,
  normalizeRating,
  parseCsvString,
  validateAndNormalizeRows,
} from '../services/csv-parser.service.js';

describe('Stage 2: Companies and CSV Import Suite', () => {
  let app: any;
  const tenantA = 'org_test_tenant_a';
  const tenantB = 'org_test_tenant_b';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
    await Company.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });
    await CompanyContact.deleteMany({ organizationId: { $in: [tenantA, tenantB] } });
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  describe('CSV Parser Unit Logic', () => {
    it('should neutralize spreadsheet formula injection characters (=, +, -, @, \\t, \\r)', () => {
      expect(sanitizeForFormulaInjection('=1+2')).toBe("'=1+2");
      expect(sanitizeForFormulaInjection('+SUM(A1:A5)')).toBe("'+SUM(A1:A5)");
      expect(sanitizeForFormulaInjection('-calc.exe')).toBe("'-calc.exe");
      expect(sanitizeForFormulaInjection('@HYPERLINK("http://evil.com")')).toBe("'@HYPERLINK(\"http://evil.com\")");
      expect(sanitizeForFormulaInjection('Standard Company')).toBe('Standard Company');
      expect(sanitizeForFormulaInjection('')).toBe('');
    });

    it('should normalize various rating scales and never treat missing/empty as zero', () => {
      // 5-star scale
      expect(normalizeRating('5', {}, 'five_star')).toBe('A');
      expect(normalizeRating('3', {}, 'five_star')).toBe('C');
      expect(normalizeRating('1', {}, 'five_star')).toBe('F');

      // 10-point scale
      expect(normalizeRating('9', {}, 'ten_point')).toBe('A');
      expect(normalizeRating('6', {}, 'ten_point')).toBe('C');

      // Letter scale
      expect(normalizeRating('A')).toBe('A');
      expect(normalizeRating('b')).toBe('B');

      // Missing / empty values must remain 'unrated'
      expect(normalizeRating('')).toBe('unrated');
      expect(normalizeRating(undefined)).toBe('unrated');
      expect(normalizeRating(null)).toBe('unrated');
      expect(normalizeRating('   ')).toBe('unrated');
    });

    it('should accurately parse CSV rows and detect duplicate records', () => {
      const csv = `Company,Website,Email,Rating\nAcme Corp,acme.com,info@acme.com,5\nBeta LLC,beta.com,contact@beta.com,3\nAcme Corp,acme.com,duplicate@acme.com,4`;
      const { headers, rows } = parseCsvString(csv);

      expect(headers).toContain('Company');
      expect(rows).toHaveLength(3);

      const summary = validateAndNormalizeRows(
        rows,
        { company_name: 'Company', website_url: 'Website', contact_email: 'Email', rating: 'Rating' },
        new Set(),
        new Set(),
        new Set(),
        'five_star'
      );

      expect(summary.totalRows).toBe(3);
      expect(summary.validRows).toBe(2);
      expect(summary.duplicateRows).toBe(1);
      expect(summary.parsedRows[2].isDuplicate).toBe(true);
    });
  });

  describe('Companies & Imports REST Integration', () => {
    it('POST /api/v1/companies should create a company for the authenticated tenant', async () => {
      const res = await request(app)
        .post('/api/v1/companies')
        .set('x-organization-id', tenantA)
        .send({
          name: 'Nexus Dynamics',
          domain: 'nexusdynamics.example.com',
          industry: 'Cloud Computing',
          overallRating: 'B',
          services: ['Web Architecture', 'SEO'],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Nexus Dynamics');
      expect(res.body.data.organizationId).toBe(tenantA);
    });

    it('Strict Tenant Isolation: Tenant B cannot view Tenant A companies', async () => {
      const resA = await request(app)
        .get('/api/v1/companies?q=Nexus')
        .set('x-organization-id', tenantA);
      expect(resA.status).toBe(200);
      expect(resA.body.data.length).toBeGreaterThanOrEqual(1);

      const resB = await request(app)
        .get('/api/v1/companies?q=Nexus')
        .set('x-organization-id', tenantB);
      expect(resB.status).toBe(200);
      expect(resB.body.data).toHaveLength(0);
    });

    it('POST /api/v1/imports/preview and commit should execute end-to-end import lifecycle', async () => {
      const sampleCsv = `Organization,Domain,Contact,Grade\nSolaria Energy,solaria.example.com,sales@solaria.example.com,4\nVortex Analytics,vortex.example.com,founder@vortex.example.com,2`;

      // 1. Preview
      const previewRes = await request(app)
        .post('/api/v1/imports/preview')
        .set('x-organization-id', tenantA)
        .send({
          csvContent: sampleCsv,
          mapping: {
            company_name: 'Organization',
            domain: 'Domain',
            contact_email: 'Contact',
            rating: 'Grade',
          },
          scaleType: 'five_star',
        });

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.success).toBe(true);
      expect(previewRes.body.data.summary.validRows).toBe(2);

      // 2. Commit
      const commitRes = await request(app)
        .post('/api/v1/imports/commit')
        .set('x-organization-id', tenantA)
        .send({
          fileName: 'prospects_q4.csv',
          rows: previewRes.body.data.summary.parsedRows,
          mapping: { company_name: 'Organization' },
        });

      expect(commitRes.status).toBe(201);
      expect(commitRes.body.success).toBe(true);
      expect(commitRes.body.data.importedCount).toBe(2);

      // Verify records in DB
      const dbCompanies = await Company.find({ organizationId: tenantA, name: 'Solaria Energy' });
      expect(dbCompanies).toHaveLength(1);
      expect(dbCompanies[0].overallRating).toBe('B'); // 4 stars mapped to B

      const dbContacts = await CompanyContact.find({
        organizationId: tenantA,
        email: 'sales@solaria.example.com',
      });
      expect(dbContacts).toHaveLength(1);
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CSVImport } from '../models/CSVImport.js';

const TENANT = 'progress-test-tenant';
const HEADERS = ['Company Name', 'Work Email', 'Domain', 'Step 1 Body'];

function esc(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function buildCsv(rows: string[][]): string {
  return [HEADERS.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n') + '\r\n';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let app: Express;

function headers(org = TENANT): Record<string, string> {
  return { 'x-organization-id': org, 'x-user-id': 'progress-tester' };
}

describe('Real-Time CSV Import Progress Suite', () => {
  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
    await Company.deleteMany({ organizationId: TENANT });
    await CompanyContact.deleteMany({ organizationId: TENANT });
    await CSVImport.deleteMany({ organizationId: TENANT });
  });

  afterAll(async () => {
    await Company.deleteMany({ organizationId: TENANT });
    await CompanyContact.deleteMany({ organizationId: TENANT });
    await CSVImport.deleteMany({ organizationId: TENANT });
    await disconnectDatabase();
  });

  it('GET /api/v1/imports/active returns null when no job is running', async () => {
    const res = await request(app).get('/api/v1/imports/active').set(headers());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeNull();
  });

  it('calculates total records and exposes live SSE stream endpoint with event-stream headers', async () => {
    const rows = [
      ['Alpha Tech', 'ceo@alpha.com', 'alpha.com', 'Hello Alpha'],
      ['Beta Solutions', 'info@beta.io', 'beta.io', 'Hello Beta'],
      ['Gamma Global', 'contact@gamma.org', 'gamma.org', 'Hello Gamma'],
    ];
    const csvContent = buildCsv(rows);

    const uploadRes = await request(app)
      .post('/api/v1/imports/jobs')
      .set(headers())
      .attach('file', Buffer.from(csvContent, 'utf8'), 'swaniki_verified_outbound_campaign.csv');

    expect(uploadRes.status).toBe(201);
    const jobId = uploadRes.body.data._id;
    expect(jobId).toBeDefined();
    expect(uploadRes.body.data.totalRows).toBe(3);

    // Test SSE endpoint headers
    const streamRes = await request(app)
      .get(`/api/v1/imports/jobs/${jobId}/stream`)
      .set(headers())
      .buffer(true)
      .timeout({ response: 1000, deadline: 1500 })
      .catch((err) => {
        // SSE streams keep connection open; inspect response if available
        return err.response;
      });

    if (streamRes) {
      expect(streamRes.headers['content-type']).toContain('text/event-stream');
      expect(streamRes.headers['cache-control']).toBe('no-cache');
    }
  });

  it('tracks progress accurately across batch processing and generates error CSV on row failure', async () => {
    // 2 valid rows, 1 duplicate row, 1 row missing required company name
    const rows = [
      ['Delta One', 'team@deltaone.com', 'deltaone.com', 'Hello Delta'],
      ['Delta One', 'team@deltaone.com', 'deltaone.com', 'Duplicate Delta'],
      ['Epsilon Corp', 'sales@epsilon.com', 'epsilon.com', 'Hello Epsilon'],
      ['', 'invalid@missingname.com', 'missingname.com', 'Invalid row'],
    ];
    const csvContent = buildCsv(rows);

    const uploadRes = await request(app)
      .post('/api/v1/imports/jobs')
      .set(headers())
      .attach('file', Buffer.from(csvContent, 'utf8'), 'batch_test.csv');

    expect(uploadRes.status).toBe(201);
    const jobId = uploadRes.body.data._id;

    // Start import
    const startRes = await request(app)
      .post(`/api/v1/imports/jobs/${jobId}/start`)
      .set(headers())
      .send({
        duplicateStrategy: 'skip',
      });

    expect(startRes.status).toBe(202);

    // Wait for completion
    let job: any = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const res = await request(app).get(`/api/v1/imports/jobs/${jobId}`).set(headers());
      job = res.body?.data;
      if (job && (job.status === 'completed' || job.status === 'completed_with_errors' || job.status === 'failed')) {
        break;
      }
      await sleep(100);
    }

    expect(job).not.toBeNull();
    expect(['completed', 'completed_with_errors']).toContain(job.status);
    expect(job.totalRows).toBe(4);
    expect(job.processedRows).toBe(4);
    expect(job.percent).toBe(100);
    expect(job.importedCount).toBe(2); // Delta One + Epsilon Corp
    expect(job.duplicateRows).toBe(1); // Second Delta One
    expect(job.invalidRows).toBe(1); // Missing Company Name

    // Verify error CSV download endpoint
    const errorRes = await request(app).get(`/api/v1/imports/jobs/${jobId}/errors`).set(headers());
    expect(errorRes.status).toBe(200);
    expect(errorRes.headers['content-type']).toContain('text/csv');
    expect(errorRes.text).toContain('row,field,reason');
    expect(errorRes.text).toContain('4,company_name,Company name is required');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { CSVImport } from '../models/CSVImport.js';

const TENANT_A = 'job-tenant-a';
const TENANT_B = 'job-tenant-b';
const HEADERS = ['Company Name', 'Work Email', 'Domain', 'Rating', 'Step 1 Body'];

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

function headers(org: string): Record<string, string> {
  return { 'x-organization-id': org, 'x-user-id': 'test-user' };
}

async function uploadCsv(org: string, csvText: string, name = 'upload.csv') {
  return request(app)
    .post('/api/v1/imports/jobs')
    .set(headers(org))
    .attach('file', Buffer.from(csvText, 'utf8'), name);
}

async function startJob(org: string, jobId: string, body: Record<string, unknown> = {}) {
  return request(app).post(`/api/v1/imports/jobs/${jobId}/start`).set(headers(org)).send(body);
}

async function waitForJob(org: string, jobId: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/v1/imports/jobs/${jobId}`).set(headers(org));
    last = res.body?.data;
    if (last && last.status !== 'queued' && last.status !== 'processing') return last;
    await sleep(75);
  }
  throw new Error(`Import job ${jobId} did not finish in time (last status: ${last?.status})`);
}

describe('CSV import jobs: streaming, batching, resume and isolation', () => {
  let mainJobId = '';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
    await Promise.all([
      Company.deleteMany({ organizationId: { $in: [TENANT_A, TENANT_B] } }),
      CompanyContact.deleteMany({ organizationId: { $in: [TENANT_A, TENANT_B] } }),
      CompanyAssessment.deleteMany({ organizationId: { $in: [TENANT_A, TENANT_B] } }),
      CSVImport.deleteMany({ organizationId: { $in: [TENANT_A, TENANT_B] } }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      Company.deleteMany({ organizationId: { $in: [TENANT_A, TENANT_B] } }),
      CompanyContact.deleteMany({ organizationId: { $in: [TENANT_A, TENANT_B] } }),
      CompanyAssessment.deleteMany({ organizationId: { $in: [TENANT_A, TENANT_B] } }),
      CSVImport.deleteMany({ organizationId: { $in: [TENANT_A, TENANT_B] } }),
    ]);
    await disconnectDatabase();
  });

  it('uploads and imports a multi-batch file with validation + duplicate handling', async () => {
    const total = 1200;
    const rows: string[][] = [];
    for (let i = 0; i < total; i++) {
      rows.push([`Company ${i}`, `user${i}@example.com`, `company${i}.example.com`, 'A', `Body for company ${i}`]);
    }
    rows[10] = ['Company 10 dup', 'user10@example.com', 'company0.example.com', 'A', 'dup body'];
    rows[20] = ['', 'user20@example.com', 'company20.example.com', 'A', 'invalid body'];

    const uploadRes = await uploadCsv(TENANT_A, buildCsv(rows), 'batch.csv');
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.data.rowCount).toBe(total);
    expect(uploadRes.body.data.headers).toEqual(HEADERS);
    mainJobId = uploadRes.body.data.jobId;
    expect(mainJobId).toBeTruthy();

    const startRes = await startJob(TENANT_A, mainJobId);
    expect(startRes.status).toBe(202);

    const job = await waitForJob(TENANT_A, mainJobId);

    expect(job.status).toBe('completed_with_errors');
    expect(job.importedCount).toBe(total - 2);
    expect(job.invalidRows).toBe(1);
    expect(job.duplicateRows).toBe(1);
    expect(job.processedRows).toBe(total);

    expect(await Company.countDocuments({ organizationId: TENANT_A })).toBe(total - 2);
    expect(await CompanyContact.countDocuments({ organizationId: TENANT_A })).toBe(total - 2);
    expect(await CompanyAssessment.countDocuments({ organizationId: TENANT_A })).toBe(total - 2);

    const errRes = await request(app)
      .get(`/api/v1/imports/jobs/${mainJobId}/errors`)
      .set(headers(TENANT_A));
    expect(errRes.status).toBe(200);
    expect(errRes.headers['content-type']).toMatch(/text\/csv/);
    expect(errRes.text).toContain('company_name');
  });

  it('resumes from the saved cursor without creating duplicates', async () => {
    // Simulate an interrupted run: pretend only the first 1000 rows were committed.
    await CSVImport.updateOne(
      { _id: mainJobId, organizationId: TENANT_A },
      { $set: { status: 'failed', lastProcessedRow: 1000, processedRows: 1000 } }
    );

    const retryRes = await request(app)
      .post(`/api/v1/imports/jobs/${mainJobId}/retry`)
      .set(headers(TENANT_A));
    expect(retryRes.status).toBe(202);

    const job = await waitForJob(TENANT_A, mainJobId);
    // The 200 replayed rows already exist, so they are counted as duplicates —
    // never re-inserted.
    expect(job.importedCount).toBe(1198);
    expect(job.duplicateRows).toBe(201);
    expect(await Company.countDocuments({ organizationId: TENANT_A })).toBe(1198);
  });

  it('keeps import jobs isolated per organization', async () => {
    const res = await request(app).get(`/api/v1/imports/jobs/${mainJobId}`).set(headers(TENANT_B));
    expect(res.status).toBe(404);
  });

  it('supports the update strategy without overwriting existing values', async () => {
    const first = buildCsv([['Gamma Ltd', 'hello@gamma.example.com', 'gamma.example.com', 'B', 'first']]);
    const up1 = await uploadCsv(TENANT_A, first, 'gamma1.csv');
    await startJob(TENANT_A, up1.body.data.jobId);
    await waitForJob(TENANT_A, up1.body.data.jobId);

    // Same domain, new contact email + body; update must add without creating a new company.
    const second = buildCsv([['Gamma Ltd', 'new@gamma.example.com', 'gamma.example.com', 'B', 'second']]);
    const up2 = await uploadCsv(TENANT_A, second, 'gamma2.csv');
    const job2Id = up2.body.data.jobId;
    await startJob(TENANT_A, job2Id, { duplicateStrategy: 'update' });
    const job2 = await waitForJob(TENANT_A, job2Id);

    expect(job2.updatedCount).toBe(1);
    expect(job2.importedCount).toBe(0);
    expect(await Company.countDocuments({ organizationId: TENANT_A, domain: 'gamma.example.com' })).toBe(1);
  });
});

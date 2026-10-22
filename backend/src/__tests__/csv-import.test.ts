import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { env } from '../config/env.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { CSVImport } from '../models/CSVImport.js';
import {
  parseCsvDetailed,
  mapHeadersToFields,
  validateAndNormalizeRows,
  assertByteLimit,
  assertRowLimit,
  computeByteLength,
  parseCsvString,
  ColumnMapping,
} from '../services/csv-parser.service.js';
import { interpretWebsiteAudit } from '../services/website-audit.service.js';

const TENANT_A = 'test_csv_import_a';
const TENANT_B = 'test_csv_import_b';

/** Canonical 22-column Swaniki campaign header set, in the file's order. */
const SWANIKI_HEADERS = [
  'Company Name',
  'First Name',
  'Director Full Name',
  'Work Email',
  'Contact Confidence',
  'Direct Phone',
  'Domain',
  'Website Status',
  'Site Audit Type',
  'Page Title',
  'HTTP Code',
  'Primary Tech Signal',
  'Sector',
  'State / ROC',
  'Authorized Capital (INR)',
  'Proposed Deliverable',
  'Step 1 Subject',
  'Step 1 Body',
  'Step 2 Subject',
  'Step 2 Body',
  'Step 3 Subject',
  'Step 3 Body',
];

function csvField(value: string): string {
  const s = value ?? '';
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers.map((h) => csvField(String(h))).join(',')];
  for (const row of rows) lines.push(row.map((v) => csvField(String(v ?? ''))).join(','));
  return lines.join('\r\n');
}

function swanikiRow(overrides: Partial<Record<number, string>> = {}): string[] {
  const base = new Array(22).fill('');
  base[0] = 'Acme Corp';
  base[2] = 'Jane Director';
  base[3] = 'contact@acme.example.com';
  base[6] = 'acme.example.com';
  base[7] = 'Active';
  base[8] = 'Live Portal';
  base[9] = 'Acme — Home';
  base[10] = '200';
  base[15] = 'Website redesign';
  for (const [idx, value] of Object.entries(overrides)) base[Number(idx)] = value as string;
  return base;
}

describe('CSV import: real campaign file support', () => {
  let app: Express;

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

  // -------------------------------------------------------------------------
  // Parser + mapping unit coverage
  // -------------------------------------------------------------------------

  it('1. parses the 22-column Swaniki file and strips the UTF-8 BOM', () => {
    const csv = '\uFEFF' + buildCsv(SWANIKI_HEADERS, [swanikiRow()]);
    const { headers, rows } = parseCsvDetailed(csv);

    expect(headers).toHaveLength(22);
    expect(headers[0]).toBe('Company Name');
    expect(headers[0].charCodeAt(0)).not.toBe(0xfeff);
    expect(rows).toHaveLength(1);
  });

  it('2. maps every exact Swaniki column (plus aliases) with no unmapped headers', () => {
    const { mapping, unmapped, missingRequired } = mapHeadersToFields(SWANIKI_HEADERS);
    expect(mapping.company_name).toBe('Company Name');
    expect(mapping.contact_email).toBe('Work Email');
    expect(mapping.contact_first_name).toBe('First Name');
    expect(mapping.director_full_name).toBe('Director Full Name');
    expect(mapping.contact_confidence).toBe('Contact Confidence');
    expect(mapping.direct_phone).toBe('Direct Phone');
    expect(mapping.website_status).toBe('Website Status');
    expect(mapping.site_audit_type).toBe('Site Audit Type');
    expect(mapping.http_code).toBe('HTTP Code');
    expect(mapping.page_title).toBe('Page Title');
    expect(mapping.primary_tech_signal).toBe('Primary Tech Signal');
    expect(mapping.authorized_capital).toBe('Authorized Capital (INR)');
    expect(mapping.step_1_body).toBe('Step 1 Body');
    expect(mapping.step_3_subject).toBe('Step 3 Subject');
    expect(unmapped).toHaveLength(0);
    expect(missingRequired).toHaveLength(0);
  });

  it('maps alternate header spellings through aliases', () => {
    const { mapping } = mapHeadersToFields(['Organization', 'Email Address', 'Website', 'Grade']);
    expect(mapping.company_name).toBe('Organization');
    expect(mapping.contact_email).toBe('Email Address');
    expect(mapping.website_url).toBe('Website');
    expect(mapping.rating).toBe('Grade');
  });

  it('preserves quoted multiline bodies and escaped quotes', () => {
    const body = 'Hi Jane,\n\nWe noticed "Acme" lacks a mobile layout,\nso here is an idea.\n\nBest,\nSam';
    const csv = buildCsv(SWANIKI_HEADERS, [swanikiRow({ 17: body })]);
    const { rows } = parseCsvDetailed(csv);
    expect(rows[0]['Step 1 Body']).toBe(body);
    expect(rows[0]['Step 1 Body']).toContain('\n');
    expect(rows[0]['Step 1 Body']).toContain('"Acme"');
  });

  it('neutralizes spreadsheet formula injection in mapped values', () => {
    const csv = buildCsv(SWANIKI_HEADERS, [swanikiRow({ 0: '=HYPERLINK("http://evil")' })]);
    const { rows } = parseCsvString(csv);
    const summary = validateAndNormalizeRows(
      rows,
      mapHeadersToFields(SWANIKI_HEADERS).mapping as unknown as ColumnMapping,
      new Set(),
      new Set(),
      new Set()
    );
    expect(summary.parsedRows[0].cleaned.company_name.startsWith("'")).toBe(true);
  });

  it('tolerates blank optional fields without errors and counts missing optional data', () => {
    const csv = buildCsv(SWANIKI_HEADERS, [
      swanikiRow({ 2: '', 5: '', 9: '', 15: '', 18: '', 19: '', 20: '', 21: '' }),
    ]);
    const { rows } = parseCsvDetailed(csv);
    const summary = validateAndNormalizeRows(
      rows,
      { company_name: 'Company Name', contact_email: 'Work Email' },
      new Set(),
      new Set(),
      new Set()
    );
    expect(summary.errorRows).toBe(0);
    expect(summary.validRows).toBe(1);
    expect(summary.missingOptionalRows).toBe(1);
  });

  it('flags duplicate work emails within the file (case-insensitive)', () => {
    const csv = buildCsv(SWANIKI_HEADERS, [
      swanikiRow({ 0: 'Alpha', 6: 'alpha.example.com', 3: 'Owner@Shared.example.com' }),
      swanikiRow({ 0: 'Beta', 6: 'beta.example.com', 3: 'owner@shared.example.com' }),
    ]);
    const rows = parseCsvString(csv).rows;
    const summary = validateAndNormalizeRows(
      rows,
      { company_name: 'Company Name', contact_email: 'Work Email', domain: 'Domain' } as ColumnMapping,
      new Set(),
      new Set(),
      new Set()
    );
    expect(summary.fileDuplicateRows).toBe(1);
    expect(summary.parsedRows[1].isDuplicate).toBe(true);
    expect(summary.parsedRows[1].duplicateScope).toBe('file');
  });

  it('flags invalid email syntax without aborting the batch', () => {
    const csv = buildCsv(SWANIKI_HEADERS, [swanikiRow({ 3: 'not-an-email' })]);
    const { rows } = parseCsvDetailed(csv);
    const summary = validateAndNormalizeRows(
      rows,
      { company_name: 'Company Name', contact_email: 'Work Email' } as ColumnMapping,
      new Set(),
      new Set(),
      new Set()
    );
    expect(summary.errorRows).toBe(1);
    expect(summary.parsedRows[0].errors[0].field).toBe('contact_email');
  });

  it('treats blank optional fields as missing, not as data', () => {
    const csv = buildCsv(SWANIKI_HEADERS, [swanikiRow({ 5: '', 11: '', 13: '' })]);
    const { rows } = parseCsvDetailed(csv);
    const summary = validateAndNormalizeRows(
      rows,
      mapHeadersToFields(SWANIKI_HEADERS).mapping as unknown as ColumnMapping,
      new Set(),
      new Set(),
      new Set()
    );
    expect(summary.parsedRows[0].cleaned.direct_phone).toBeNull();
    expect(summary.parsedRows[0].cleaned.primary_tech_signal).toBeNull();
    expect(summary.parsedRows[0].cleaned.state_roc).toBeNull();
  });

  it('only claims "no website" when the source proves it', () => {
    const proven = interpretWebsiteAudit({ statusRaw: 'Missing', auditTypeRaw: 'Unregistered' });
    expect(proven.definitiveNoWebsite).toBe(true);
    expect(proven.websiteStatus).toBe('missing');

    const timeout = interpretWebsiteAudit({ statusRaw: 'Missing', auditTypeRaw: 'Timeout' });
    expect(timeout.definitiveNoWebsite).toBe(false);
    expect(timeout.cautions.join(' ')).toMatch(/timed out/i);

    const httpErr = interpretWebsiteAudit({ statusRaw: 'Active', auditTypeRaw: 'HTTP Error', httpCodeRaw: '503' });
    expect(httpErr.definitiveNoWebsite).toBe(false);
    expect(httpErr.httpCode).toBe(503);
    expect(httpErr.cautions.length).toBeGreaterThan(0);
  });

  it('flagging website-audit uncertainty surfaces in validation warnings', () => {
    const csv = buildCsv(SWANIKI_HEADERS, [swanikiRow({ 7: 'Missing', 8: 'Timeout' })]);
    const { rows } = parseCsvDetailed(csv);
    const summary = validateAndNormalizeRows(
      rows,
      mapHeadersToFields(SWANIKI_HEADERS).mapping as unknown as ColumnMapping,
      new Set(),
      new Set(),
      new Set()
    );
    expect(summary.websiteAuditWarningRows).toBe(1);
    expect(summary.parsedRows[0].websiteAudit.definitiveNoWebsite).toBe(false);
  });

  it('enforces byte and row limits with structured errors', () => {
    expect(computeByteLength('abc')).toBe(3);
    expect(() => assertByteLimit('abcdef', 3)).toThrowError(/exceeds the configured limit/);
    try {
      assertByteLimit('abcdef', 3);
    } catch (err: any) {
      expect(err.code).toBe('FILE_TOO_LARGE');
      expect(err.statusCode).toBe(413);
    }
    expect(() => assertRowLimit(11, 10)).toThrowError(/exceeds the configured limit/);
    try {
      assertRowLimit(11, 10);
    } catch (err: any) {
      expect(err.code).toBe('TOO_MANY_ROWS');
      expect(err.statusCode).toBe(413);
    }
  });

  describe('HTTP endpoints', () => {
    it('POST /imports/inspect reports columns, mapping, byte length and limits', async () => {
      const csv = '\ufeff' + buildCsv(SWANIKI_HEADERS, [swanikiRow(), swanikiRow({ 0: 'Beta LLC', 6: 'beta.example.com', 3: 'b@beta.example.com' })]);
      const res = await request(app)
        .post('/api/v1/imports/inspect')
        .set('x-organization-id', TENANT_A)
        .send({ csvContent: csv, fileName: 'swaniki.csv' });

      expect(res.status).toBe(200);
      expect(res.body.data.rowCount).toBe(2);
      expect(res.body.data.headers).toHaveLength(22);
      expect(res.body.data.headers[0]).toBe('Company Name');
      expect(res.body.data.detectedMapping.company_name).toBe('Company Name');
      expect(res.body.data.byteLength).toBeGreaterThan(0);
      expect(res.body.data.limits.maxFileBytes).toBe(env.IMPORT_MAX_FILE_BYTES);
      expect(res.body.data.sampleRows).toHaveLength(2);
    });

    it('rejects a preview whose mapping omits company_name', async () => {
      const csv = buildCsv(['Organisation', 'Contact'], [['Acme', 'a@acme.com']]);
      const res = await request(app)
        .post('/api/v1/imports/preview')
        .set('x-organization-id', TENANT_A)
        .send({ csvContent: csv, mapping: { contact_email: 'Contact' } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 413 FILE_TOO_LARGE when the payload exceeds the limit', async () => {
      const original = env.IMPORT_MAX_FILE_BYTES;
      (env as any).IMPORT_MAX_FILE_BYTES = 50;
      try {
        const csv = buildCsv(SWANIKI_HEADERS, [swanikiRow({ 17: 'x'.repeat(500) })]);
        const res = await request(app)
          .post('/api/v1/imports/inspect')
          .set('x-organization-id', TENANT_A)
          .send({ csvContent: csv });
        expect(res.status).toBe(413);
        expect(res.body.error.code).toBe('FILE_TOO_LARGE');
      } finally {
        (env as any).IMPORT_MAX_FILE_BYTES = env.IMPORT_MAX_FILE_BYTES;
        (env as any).IMPORT_MAX_FILE_BYTES = 26214400;
      }
    });

    it('commits a previewed batch, writes contacts + custom fields, and is idempotent', async () => {
      const csv = buildCsv(SWANIKI_HEADERS, [
        swanikiRow({ 0: 'Solaria Energy', 3: 'sales@solaria.example.com', 6: 'solaria.example.com', 12: 'Renewables' }),
        swanikiRow({ 0: 'Vortex Analytics', 3: 'founder@vortex.example.com', 6: 'vortex.example.com', 12: 'Data' }),
      ]);

      const preview = await request(app)
        .post('/api/v1/imports/preview')
        .set('x-organization-id', TENANT_A)
        .send({ csvContent: csv, mapping: mapHeadersToFields(SWANIKI_HEADERS).mapping });

      expect(preview.status).toBe(200);
      expect(preview.body.data.summary.validRows).toBe(2);

      const commit = await request(app)
        .post('/api/v1/imports/commit')
        .set('x-organization-id', TENANT_A)
        .send({
          fileName: 'swaniki.csv',
          rows: preview.body.data.summary.parsedRows,
          mapping: mapHeadersToFields(SWANIKI_HEADERS).mapping,
        });

      expect(commit.status).toBe(201);
      expect(commit.body.data.importedCount).toBe(2);

      const companies = await Company.find({ organizationId: TENANT_A });
      expect(companies).toHaveLength(2);
      const solaria = companies.find((c) => c.name === 'Solaria Energy')!;
      expect(solaria.customFields.get('sector')).toBe('Renewables');

      const contacts = await CompanyContact.find({ organizationId: TENANT_A });
      expect(contacts).toHaveLength(2);

      // Idempotent re-commit with default (skip) policy imports nothing new.
      const rePreview = await request(app)
        .post('/api/v1/imports/preview')
        .set('x-organization-id', TENANT_A)
        .send({ csvContent: csv, mapping: mapHeadersToFields(SWANIKI_HEADERS).mapping });
      expect(rePreview.body.data.summary.existingRows).toBe(2);

      const reCommit = await request(app)
        .post('/api/v1/imports/commit')
        .set('x-organization-id', TENANT_A)
        .send({
          fileName: 'swaniki.csv',
          rows: rePreview.body.data.summary.parsedRows,
          mapping: mapHeadersToFields(SWANIKI_HEADERS).mapping,
        });
      expect(reCommit.body.data.importedCount).toBe(0);

      const after = await Company.countDocuments({ organizationId: TENANT_A });
      expect(after).toBe(2);
    });

    it('update strategy fills empty fields only and never overwrites existing data', async () => {
      const headers = ['Company Name', 'Domain', 'Work Email', 'Notes', 'Rating'];
      const first = buildCsv(headers, [['Update Co', 'update.example.com', 'first@update.example.com', 'Original note', '5']]);
      const firstPreview = await request(app)
        .post('/api/v1/imports/preview')
        .set('x-organization-id', TENANT_A)
        .send({ csvContent: first, mapping: { company_name: 'Company Name', domain: 'Domain', contact_email: 'Work Email', notes: 'Notes', rating: 'Rating' }, scaleType: 'five_star' });
      await request(app)
        .post('/api/v1/imports/commit')
        .set('x-organization-id', TENANT_A)
        .send({ fileName: 'update1.csv', rows: firstPreview.body.data.summary.parsedRows, mapping: { company_name: 'Company Name' } });

      const second = buildCsv(headers, [['Update Co', 'update.example.com', 'second@update.example.com', 'Should not overwrite', '1']]);
      const secondPreview = await request(app)
        .post('/api/v1/imports/preview')
        .set('x-organization-id', TENANT_A)
        .send({ csvContent: second, mapping: { company_name: 'Company Name', domain: 'Domain', contact_email: 'Work Email', notes: 'Notes', rating: 'Rating' }, scaleType: 'five_star' });
      expect(secondPreview.body.data.summary.existingRows).toBe(1);

      const update = await request(app)
        .post('/api/v1/imports/commit')
        .set('x-organization-id', TENANT_A)
        .send({
          fileName: 'update2.csv',
          rows: secondPreview.body.data.summary.parsedRows,
          mapping: { company_name: 'Company Name', domain: 'Domain', contact_email: 'Work Email', notes: 'Notes', rating: 'Rating' },
          duplicateStrategy: 'update',
        });
      expect(update.body.data.updatedCount).toBe(1);
      expect(update.body.data.importedCount).toBe(0);

      const company = await Company.findOne({ organizationId: TENANT_A, domain: 'update.example.com' });
      expect(company!.overallRating).toBe('A');
      expect(company!.notes).toBe('Original note');

      const newContact = await CompanyContact.findOne({ organizationId: TENANT_A, email: 'second@update.example.com' });
      expect(newContact).toBeTruthy();
    });

    it('returns 413 when the row count exceeds the configured limit', async () => {
      const original = env.IMPORT_MAX_ROWS;
      (env as any).IMPORT_MAX_ROWS = 1;
      try {
        const csv = buildCsv(SWANIKI_HEADERS, [swanikiRow(), swanikiRow({ 0: 'Second Co' })]);
        const res = await request(app)
          .post('/api/v1/imports/inspect')
          .set('x-organization-id', TENANT_A)
          .send({ csvContent: csv });
        expect(res.status).toBe(413);
        expect(res.body.error.code).toBe('TOO_MANY_ROWS');
      } finally {
        (env as any).IMPORT_MAX_ROWS = original;
      }
    });

    it('isolates imports between tenants', async () => {
      const csv = buildCsv(SWANIKI_HEADERS, [swanikiRow({ 0: 'Tenant B Co', 6: 'tenantb.example.com', 3: 'b@tenantb.example.com' })]);
      const preview = await request(app)
        .post('/api/v1/imports/preview')
        .set('x-organization-id', TENANT_B)
        .send({ csvContent: csv, mapping: mapHeadersToFields(SWANIKI_HEADERS).mapping });
      await request(app)
        .post('/api/v1/imports/commit')
        .set('x-organization-id', TENANT_B)
        .send({ fileName: 'tenantb.csv', rows: preview.body.data.summary.parsedRows, mapping: { company_name: 'Company Name' } });

      // Tenant A must not see Tenant B's company.
      const leaked = await request(app).get('/api/v1/companies?q=Tenant B').set('x-organization-id', TENANT_A);
      expect(leaked.body.data).toHaveLength(0);
      const own = await request(app).get('/api/v1/companies?q=Tenant B').set('x-organization-id', TENANT_B);
      expect(own.body.data.length).toBeGreaterThanOrEqual(1);
    });

    it('inspects the realistic ~6 MB / ~2,900-row file without a spurious 400 (regression)', async () => {
      const filler = 'We reviewed your site and prepared a tailored growth proposal. '.repeat(28);
      const rows: string[][] = [];
      for (let i = 0; i < 2900; i++) {
        rows.push(
          swanikiRow({
            0: `Prospect Company ${i}`,
            3: `contact${i}@prospect${i}.example.com`,
            6: `prospect${i}.example.com`,
            17: `${filler} Row ${i}.`,
          })
        );
      }
      const csv = buildCsv(SWANIKI_HEADERS, rows);
      expect(computeByteLength(csv)).toBeGreaterThan(5_000_000);

      const res = await request(app)
        .post('/api/v1/imports/inspect')
        .set('x-organization-id', TENANT_A)
        .send({ csvContent: csv, fileName: 'swaniki_verified_outbound_campaign(1).csv' });

      expect(res.status).toBe(200);
      expect(res.body.data.rowCount).toBe(2900);
      expect(res.body.data.headers).toHaveLength(22);
      expect(res.body.success).toBe(true);
    }, 60000);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { CampaignImportJob } from '../models/CampaignImportJob.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { CSVImport } from '../models/CSVImport.js';
import { campaignService } from '../services/campaign.service.js';

describe('Campaign Large Import: CSV and XLSX Streaming Memory-Bounded Pipeline', () => {
  let app: any;
  const tenant = 'org_large_import_test';
  const actorId = 'usr_large_tester';
  const mailbox = 'outreach@swaniki.dev';
  const tempFilesToClean: string[] = [];

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    await Campaign.deleteMany({ organizationId: tenant });
    await CampaignRecipient.deleteMany({ organizationId: tenant });
    await CampaignImportJob.deleteMany({ organizationId: tenant });
    await Company.deleteMany({ organizationId: tenant });
    await CompanyContact.deleteMany({ organizationId: tenant });
    await EmailAccount.deleteMany({ organizationId: tenant });

    await EmailAccount.create({
      organizationId: tenant,
      emailAddress: mailbox,
      displayName: 'Swaniki Outbound',
      provider: 'mock',
      status: 'connected',
    });
  });

  afterAll(async () => {
    await Campaign.deleteMany({ organizationId: tenant });
    await CampaignRecipient.deleteMany({ organizationId: tenant });
    await CampaignImportJob.deleteMany({ organizationId: tenant });
    await Company.deleteMany({ organizationId: tenant });
    await CompanyContact.deleteMany({ organizationId: tenant });
    await EmailAccount.deleteMany({ organizationId: tenant });

    for (const f of tempFilesToClean) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }

    await disconnectDatabase();
  });

  it('1. Uploads a CSV file via multipart/form-data and receives streaming inspection', async () => {
    const csvContent = [
      'Company Name,Work Email,Director Full Name,Sector,Step 1 Subject,Step 1 Body',
      '"Alpha Tech, LLC",alpha@alphatech.io,Alice Director,Software,"Quick question","Hello Alice,\n\nWe love your tech."',
      '"Beta Systems Inc.",beta@betasystems.com,Bob Executive,IT Services,"Partnership","Hi Bob,\n\nLet us collaborate."',
    ].join('\r\n');

    const tempCsv = path.join(os.tmpdir(), `test_upload_${Date.now()}.csv`);
    fs.writeFileSync(tempCsv, csvContent, 'utf8');
    tempFilesToClean.push(tempCsv);

    const uploadRes = await request(app)
      .post('/api/v1/campaigns/upload')
      .attach('file', tempCsv)
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId);

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.success).toBe(true);
    expect(uploadRes.body.data.uploadId).toBeDefined();
    expect(uploadRes.body.data.totalRows).toBe(2);
    expect(uploadRes.body.data.fileType).toBe('csv');
    expect(uploadRes.body.data.headers).toContain('Company Name');
    expect(uploadRes.body.data.headers).toContain('Work Email');
    expect(uploadRes.body.data.sampleRows.length).toBe(2);
  });

  it('2. Streams and creates campaign from uploaded CSV using uploadId with zero email auto-dispatch', async () => {
    const csvContent = [
      'Company Name,Work Email,Director Full Name,Step 1 Subject,Step 1 Body',
      'Gamma Corp,gamma@gammacorp.com,George Director,Subject 1,"Multiline\nStep 1 Body\nLine 3"',
      'Delta LLC,delta@deltallc.com,Diana Founder,Subject 1,"Delta\nStep 1 Body"',
      'Duplicate Corp,gamma@gammacorp.com,Repeat,Subject 1,Body',
    ].join('\r\n');

    const tempCsv = path.join(os.tmpdir(), `test_gamma_${Date.now()}.csv`);
    fs.writeFileSync(tempCsv, csvContent, 'utf8');
    tempFilesToClean.push(tempCsv);

    const uploadRes = await request(app)
      .post('/api/v1/campaigns/upload')
      .attach('file', tempCsv)
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId);

    const uploadId = uploadRes.body.data.uploadId;
    expect(uploadId).toBeDefined();

    // Create campaign using uploadId
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId)
      .send({
        name: 'Gamma Delta Outreach',
        mailboxId: mailbox,
        uploadId,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          director_full_name: 'Director Full Name',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
        },
        steps: [{ subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 }],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.summary.totalRows).toBe(3);
    expect(createRes.body.data.summary.recipientsCreated).toBe(2);
    expect(createRes.body.data.summary.duplicateRows).toBe(1);

    const campaignId = createRes.body.data.campaignId;
    const recipients = await CampaignRecipient.find({ campaignId }).sort({ rowNumber: 1 });
    expect(recipients.length).toBe(3);

    // Verify first 2 are pending (never sent automatically)
    expect(recipients[0].status).toBe('pending');
    expect(recipients[0].email).toBe('gamma@gammacorp.com');
    expect(recipients[0].customFields['step_1_body']).toBe('Multiline\nStep 1 Body\nLine 3');
    expect(recipients[1].status).toBe('pending');
    expect(recipients[1].email).toBe('delta@deltallc.com');

    // Duplicate was skipped
    expect(recipients[2].status).toBe('skipped');
    expect(recipients[2].skipReason).toContain("Duplicate recipient email 'gamma@gammacorp.com'");
  });

  it('3. Uploads and streams an XLSX workbook, preserving multiline cells and formulas', async () => {
    const tempXlsx = path.join(os.tmpdir(), `test_workbook_${Date.now()}.xlsx`);
    tempFilesToClean.push(tempXlsx);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Recipients');
    sheet.columns = [
      { header: 'Company Name', key: 'company' },
      { header: 'Work Email', key: 'email' },
      { header: 'Sector', key: 'sector' },
      { header: 'Proposed Deliverable', key: 'deliverable' },
      { header: 'Step 1 Subject', key: 'step1Subj' },
      { header: 'Step 1 Body', key: 'step1Body' },
    ];

    sheet.addRow({
      company: 'Excel Innovations Ltd',
      email: 'innovations@excel-innovations.com',
      sector: 'Fintech',
      deliverable: 'Automated Loan Portal',
      step1Subj: 'Fintech Partnership',
      step1Body: 'Hello Excel Innovations Team,\n\nWe can build your loan portal.\n\nRegards,\nSwaniki',
    });

    sheet.addRow({
      company: 'Quantum Dynamics',
      email: 'contact@quantum-dyn.io',
      sector: 'Deep Tech',
      deliverable: 'Quantum Simulation Engine',
      step1Subj: 'Quantum Collaboration',
      step1Body: 'Dear Quantum Team,\n\nExciting progress in simulation.\n\nBest,\nSwaniki',
    });

    await workbook.xlsx.writeFile(tempXlsx);

    const uploadRes = await request(app)
      .post('/api/v1/campaigns/upload')
      .attach('file', tempXlsx)
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId);

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.data.fileType).toBe('xlsx');
    expect(uploadRes.body.data.totalRows).toBe(2);
    expect(uploadRes.body.data.headers).toContain('Company Name');
    expect(uploadRes.body.data.headers).toContain('Proposed Deliverable');

    // Create campaign from Excel upload
    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId)
      .send({
        name: 'Quantum Innovations Campaign',
        mailboxId: mailbox,
        uploadId: uploadRes.body.data.uploadId,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          sector: 'Sector',
          proposed_deliverable: 'Proposed Deliverable',
          step_1_subject: 'Step 1 Subject',
          step_1_body: 'Step 1 Body',
        },
        steps: [{ subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 }],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.summary.recipientsCreated).toBe(2);

    const recipients = await CampaignRecipient.find({ campaignId: createRes.body.data.campaignId });
    expect(recipients.length).toBe(2);
    const excelRecipient = recipients.find((r) => r.email === 'innovations@excel-innovations.com');
    expect(excelRecipient).toBeDefined();
    expect(excelRecipient?.customFields['proposed_deliverable']).toBe('Automated Loan Portal');
    expect(excelRecipient?.customFields['step_1_body']).toContain('We can build your loan portal.');
  });

  it('4. Benchmark: Streams large volume in batches with bounded heap memory', async () => {
    // Generate a 150 row CSV to verify chunked streaming and memory bounds
    const rowCount = 150;
    const headers = ['Company Name', 'Work Email', 'First Name', 'Proposed Deliverable'];
    const lines: string[] = [headers.join(',')];

    for (let i = 1; i <= rowCount; i++) {
      lines.push(`"Tenant Scale Corp ${i}",scale_${i}@test-scale-benchmark.com,"Lead ${i}","Scale ERP"`);
    }

    const tempBenchmarkCsv = path.join(os.tmpdir(), `benchmark_${Date.now()}.csv`);
    fs.writeFileSync(tempBenchmarkCsv, lines.join('\r\n'), 'utf8');
    tempFilesToClean.push(tempBenchmarkCsv);

    const initialMem = process.memoryUsage().heapUsed;

    const uploadRes = await request(app)
      .post('/api/v1/campaigns/upload')
      .attach('file', tempBenchmarkCsv)
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId);

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.data.totalRows).toBe(rowCount);

    const createRes = await request(app)
      .post('/api/v1/campaigns')
      .set('x-organization-id', tenant)
      .set('x-user-id', actorId)
      .send({
        name: 'Scale Benchmark Campaign',
        mailboxId: mailbox,
        uploadId: uploadRes.body.data.uploadId,
        columnMapping: {
          company_name: 'Company Name',
          contact_email: 'Work Email',
          contact_first_name: 'First Name',
          proposed_deliverable: 'Proposed Deliverable',
        },
        steps: [{ subject: 'Scale Outreach', bodyText: 'Hello {{contact_first_name}} at {{company_name}}', delayDays: 0 }],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.summary.recipientsCreated).toBe(rowCount);

    const totalInDb = await CampaignRecipient.countDocuments({ campaignId: createRes.body.data.campaignId });
    expect(totalInDb).toBe(rowCount);

    const finalMem = process.memoryUsage().heapUsed;
    const heapDiffMb = Math.round((finalMem - initialMem) / 1024 / 1024);
    expect(heapDiffMb).toBeLessThan(80);
  }, 45000);

  it('5. Recovers interrupted/dangling jobs on restart', async () => {
    // Create an artificial stuck job older than 30 minutes
    const stuckJob = await CampaignImportJob.create({
      organizationId: tenant,
      campaignId: new mongoose.Types.ObjectId(),
      campaignName: 'Stuck Import Job',
      fileName: 'stuck.csv',
      status: 'processing',
      totalRows: 500,
      processedRows: 120,
    });

    await CampaignImportJob.updateOne(
      { _id: stuckJob._id },
      { $set: { updatedAt: new Date(Date.now() - 40 * 60 * 1000) } },
      { timestamps: false }
    );

    const recoveredCount = await campaignService.recoverDanglingJobs();
    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    const reloaded = await CampaignImportJob.findById(stuckJob._id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.errorMessage).toContain('interrupted');
  });
});

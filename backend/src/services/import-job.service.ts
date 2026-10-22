import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { CSVImport, ICSVImport, ImportRowError } from '../models/CSVImport.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  createCsvRowStream,
  inspectCsvStream,
  buildCompanyCustomFields,
  createDuplicateSets,
  mapHeadersToFields,
  normalizeParsedRow,
  ColumnMapping,
  ParsedCsvRow,
} from './csv-parser.service.js';
import { boundCustomFields } from './template-interpolation.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportJobStats {
  processedRows: number;
  importedCount: number;
  updatedCount: number;
  duplicateRows: number;
  invalidRows: number;
  failedRows: number;
}

interface ReportError extends ImportRowError {
  company_name?: string;
  contact_email?: string;
}

export interface StartImportOptions {
  mapping?: Record<string, string>;
  customFieldMapping?: Record<string, string>;
  duplicateStrategy?: 'skip' | 'update';
  scaleType?: 'standard' | 'five_star' | 'ten_point';
}

type ScaleType = 'standard' | 'five_star' | 'ten_point';

/** Job ids currently executing in this process (prevents double processing). */
const runningJobs = new Set<string>();

/** Job ids flagged for cancellation */
export const cancelledImportJobIds = new Set<string>();

export const importJobEventEmitter = new EventEmitter();
importJobEventEmitter.setMaxListeners(100);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Creates the upload directory if it does not yet exist and returns its path. */
export function ensureUploadDir(): string {
  fs.mkdirSync(env.IMPORT_UPLOAD_DIR, { recursive: true });
  return env.IMPORT_UPLOAD_DIR;
}

async function safeUnlink(filePath?: string | null): Promise<void> {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    /* file already gone — nothing to clean up */
  }
}

/** RFC-4180 escapes a value for the downloadable error report. */
function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Mongoose `Map` fields can surface as Map/object depending on lean(); normalize. */
function toPlainObject(value: any): Record<string, any> {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value.entries === 'function') return Object.fromEntries(value.entries());
  if (typeof value.toObject === 'function') return value.toObject();
  return { ...value };
}

function contactDisplayName(c: ParsedCsvRow['cleaned']): string | undefined {
  return (
    c.contact_full_name ||
    [c.contact_first_name, c.contact_last_name].filter(Boolean).join(' ') ||
    undefined
  );
}

export function isImportJobRunning(jobId: string): boolean {
  return runningJobs.has(jobId);
}

// ---------------------------------------------------------------------------
// Inspection (streaming, bounded memory)
// ---------------------------------------------------------------------------

/**
 * Streams an uploaded file to detect headers, count rows and capture a bounded
 * sample — WITHOUT loading the file into memory. Creates a queued import job.
 */
export async function inspectUploadedFile(params: {
  organizationId: string;
  fileName: string;
  storedFilePath: string;
  fileBytes: number;
}): Promise<ICSVImport> {
  const { organizationId, fileName, storedFilePath, fileBytes } = params;

  const source = fs.createReadStream(storedFilePath);
  let info: Awaited<ReturnType<typeof inspectCsvStream>>;
  try {
    info = await inspectCsvStream(source, { maxPreviewRows: env.IMPORT_MAX_PREVIEW_ROWS });
  } finally {
    source.destroy();
  }

  if (info.headers.length === 0) {
    await safeUnlink(storedFilePath);
    throw new AppError(
      'No columns detected in the CSV. Check that the file is a valid CSV with a header row.',
      400,
      'EMPTY_CSV'
    );
  }

  if (info.totalRows > env.IMPORT_MAX_ROWS) {
    await safeUnlink(storedFilePath);
    throw new AppError(
      `CSV contains ${info.totalRows} rows and exceeds the configured limit of ${env.IMPORT_MAX_ROWS} rows`,
      413,
      'TOO_MANY_ROWS'
    );
  }

  const { mapping } = mapHeadersToFields(info.headers);

  return CSVImport.create({
    organizationId,
    fileName,
    status: 'queued',
    storedFilePath,
    fileBytes,
    headers: info.headers,
    sampleRows: info.sampleRows,
    totalRows: info.totalRows,
    processedRows: 0,
    lastProcessedRow: 0,
    importedCount: 0,
    updatedCount: 0,
    duplicateRows: 0,
    invalidRows: 0,
    failedRows: 0,
    errorRows: 0,
    rowErrorCount: 0,
    rowErrors: [],
    mapping,
    customFieldMapping: {},
    duplicateStrategy: 'skip',
    scaleType: 'standard',
  });
}

// ---------------------------------------------------------------------------
// Job orchestration
// ---------------------------------------------------------------------------

/** Loads a job scoped to its tenant. */
export async function getImportJob(jobId: string, organizationId: string): Promise<ICSVImport> {
  const job = await CSVImport.findOne({ _id: jobId, organizationId });
  if (!job) throw new AppError('Import job not found', 404, 'IMPORT_NOT_FOUND');
  return job;
}

/** Loads a job, applies start-time overrides and launches background processing. */
export async function startImportJob(
  jobId: string,
  organizationId: string,
  overrides: StartImportOptions = {}
): Promise<ICSVImport> {
  const job = await getImportJob(jobId, organizationId);

  if (job.status === 'processing' && isImportJobRunning(String(job._id))) {
    return job;
  }

  if (overrides.mapping && Object.keys(overrides.mapping).length > 0) job.mapping = overrides.mapping;
  if (overrides.customFieldMapping) job.customFieldMapping = overrides.customFieldMapping;
  if (overrides.duplicateStrategy) job.duplicateStrategy = overrides.duplicateStrategy;
  if (overrides.scaleType) job.scaleType = overrides.scaleType;

  if (!job.mapping || !job.mapping.company_name) {
    throw new AppError('A column must be mapped to company_name before importing.', 400, 'MAPPING_REQUIRED');
  }

  job.status = 'processing';
  job.startedAt = job.startedAt ?? new Date();
  job.errorMessage = undefined;
  await job.save();

  const id = String(job._id);
  void executeJob(id, organizationId).catch(async (err: any) => {
    await CSVImport.updateOne(
      { _id: id, organizationId },
      {
        $set: {
          status: 'failed',
          errorMessage: err?.message || 'Import processing failed unexpectedly',
          finishedAt: new Date(),
        },
      }
    );
  });

  return job;
}

/** Re-runs a stopped/failed job from its saved cursor. */
export async function retryImportJob(jobId: string, organizationId: string): Promise<ICSVImport> {
  const job = await getImportJob(jobId, organizationId);
  if (job.status === 'processing' && isImportJobRunning(String(job._id))) {
    throw new AppError('This import is already running.', 409, 'IMPORT_IN_PROGRESS');
  }
  if ((job.lastProcessedRow || 0) >= (job.totalRows || 0) && job.totalRows > 0) {
    throw new AppError('This import is already complete.', 409, 'IMPORT_COMPLETE');
  }
  return startImportJob(jobId, organizationId, {});
}

/**
 * Cancels an in-progress or queued CSV import job and rolls back partial records.
 */
export async function cancelImportJob(
  jobId: string,
  organizationId: string,
  actorId?: string
): Promise<ICSVImport> {
  const job = await getImportJob(jobId, organizationId);

  if (job.status === 'completed' || job.status === 'completed_with_errors') {
    throw new AppError('Cannot cancel an import that has already completed.', 409, 'IMPORT_ALREADY_COMPLETED');
  }
  if (job.status === 'failed') {
    throw new AppError('Cannot cancel an import that has already failed.', 409, 'IMPORT_ALREADY_FAILED');
  }
  if (job.status === 'cancelled') {
    return job;
  }
  if (job.status === 'cancellation_requested' || job.status === 'cancelling') {
    return job;
  }

  cancelledImportJobIds.add(String(job._id));

  job.status = 'cancellation_requested';
  job.cancellationRequestedAt = new Date();
  if (actorId) job.cancelledBy = actorId;
  await job.save();

  importJobEventEmitter.emit(`progress:${String(job._id)}`, {
    jobId: String(job._id),
    status: 'cancellation_requested',
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    importedCount: job.importedCount,
    updatedCount: job.updatedCount,
    duplicateRows: job.duplicateRows,
    invalidRows: job.invalidRows,
    failedRows: job.failedRows,
    errorRows: job.invalidRows,
    validRows: job.validRows || job.importedCount + job.updatedCount,
    percent: job.totalRows > 0 ? Math.round((job.processedRows / job.totalRows) * 100) : 0,
    message: 'Cancellation requested. Stopping worker...',
  });

  return await rollbackCancelledImportJob(String(job._id), organizationId);
}

/**
 * Performs idempotent rollback of partial data created by a cancelled CSV import job.
 */
export async function rollbackCancelledImportJob(
  jobId: string,
  organizationId: string
): Promise<ICSVImport> {
  const job = await CSVImport.findOne({ _id: jobId, organizationId });
  if (!job) throw new AppError('Import job not found', 404, 'IMPORT_NOT_FOUND');

  job.status = 'cancelling';
  await job.save();

  importJobEventEmitter.emit(`progress:${String(job._id)}`, {
    jobId: String(job._id),
    status: 'cancelling',
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    importedCount: job.importedCount,
    updatedCount: job.updatedCount,
    duplicateRows: job.duplicateRows,
    invalidRows: job.invalidRows,
    failedRows: job.failedRows,
    errorRows: job.invalidRows,
    validRows: job.validRows || job.importedCount + job.updatedCount,
    percent: job.totalRows > 0 ? Math.round((job.processedRows / job.totalRows) * 100) : 0,
    message: 'Rolling back uncommitted data...',
  });

  // Clean up created contacts and companies if not referenced elsewhere
  const createdContactIds = (job.createdContactIds || []) as mongoose.Types.ObjectId[];
  const createdCompanyIds = (job.createdCompanyIds || []) as mongoose.Types.ObjectId[];

  for (const contactId of createdContactIds) {
    await CompanyContact.deleteOne({ _id: contactId, organizationId }).catch(() => {});
  }

  for (const compId of createdCompanyIds) {
    const hasContacts = await CompanyContact.exists({ companyId: compId });
    if (!hasContacts) {
      await Company.deleteOne({ _id: compId, organizationId }).catch(() => {});
      await CompanyAssessment.deleteMany({ companyId: compId, organizationId }).catch(() => {});
    }
  }

  // Delete temp files
  if (job.storedFilePath) {
    await safeUnlink(job.storedFilePath);
  }
  if (job.errorReportPath) {
    await safeUnlink(job.errorReportPath);
  }

  job.status = 'cancelled';
  job.cancelledAt = new Date();
  job.finishedAt = new Date();
  job.errorMessage = 'Import was cancelled by user.';
  await job.save();

  importJobEventEmitter.emit(`progress:${String(job._id)}`, {
    jobId: String(job._id),
    status: 'cancelled',
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    importedCount: 0,
    updatedCount: 0,
    duplicateRows: job.duplicateRows,
    invalidRows: job.invalidRows,
    failedRows: job.failedRows,
    errorRows: job.invalidRows,
    validRows: 0,
    percent: 0,
    message: 'Import cancelled by user. Partial data cleaned up.',
    errorMessage: job.errorMessage,
  });

  return job;
}

async function executeJob(jobId: string, organizationId: string): Promise<void> {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  try {
    await runJob(jobId, organizationId);
  } finally {
    runningJobs.delete(jobId);
  }
}

/**
 * The core streaming processor. Reads the stored file one row at a time, batches
 * rows, and performs batched, tenant-scoped upserts. Memory stays flat regardless
 * of file size. Progress is checkpointed after every committed batch so a failed
 * job can be safely resumed from `lastProcessedRow`.
 */
async function runJob(jobId: string, organizationId: string): Promise<void> {
  const job = await CSVImport.findOne({ _id: jobId, organizationId });
  if (!job) return;

  const filePath = job.storedFilePath;
  if (!filePath || !fs.existsSync(filePath)) {
    await CSVImport.updateOne(
      { _id: job._id },
      { $set: { status: 'failed', errorMessage: 'The stored upload file is missing.', finishedAt: new Date() } }
    );
    return;
  }

  const mapping = job.mapping as unknown as ColumnMapping;
  const customFieldMapping = (job.customFieldMapping || {}) as Record<string, string>;
  const duplicateStrategy = (job.duplicateStrategy || 'skip') as 'skip' | 'update';
  const scaleType = (job.scaleType || 'standard') as ScaleType;

  const startCursor = job.lastProcessedRow || 0;
  const stats: ImportJobStats = {
    processedRows: startCursor,
    importedCount: job.importedCount || 0,
    updatedCount: job.updatedCount || 0,
    duplicateRows: job.duplicateRows || 0,
    invalidRows: job.invalidRows || 0,
    failedRows: job.failedRows || 0,
  };
  let rowErrorCount = job.rowErrorCount || 0;
  const inlineErrors: ImportRowError[] = Array.isArray(job.rowErrors)
    ? (job.rowErrors as ImportRowError[]).map((e) => ({ row: e.row, field: e.field, reason: e.reason }))
    : [];

  const errorReportPath = job.errorReportPath || path.join(env.IMPORT_UPLOAD_DIR, `${jobId}.errors.csv`);
  let reportInitialized = false;
  try {
    reportInitialized = fs.existsSync(errorReportPath) && fs.statSync(errorReportPath).size > 0;
  } catch {
    reportInitialized = false;
  }

  const appendErrorReport = async (errs: ReportError[]): Promise<void> => {
    if (errs.length === 0) return;
    if (!reportInitialized) {
      await fs.promises.writeFile(errorReportPath, 'row,field,reason,company_name,contact_email\r\n', 'utf8');
      reportInitialized = true;
    }
    const lines = errs.map((e) =>
      [e.row, csvCell(e.field), csvCell(e.reason), csvCell(e.company_name), csvCell(e.contact_email)].join(',')
    );
    await fs.promises.appendFile(errorReportPath, lines.join('\r\n') + '\r\n', 'utf8');
  };

  const recordErrors = async (errs: ReportError[]): Promise<void> => {
    if (errs.length === 0) return;
    for (const e of errs) {
      rowErrorCount++;
      if (inlineErrors.length < env.IMPORT_ERROR_SAMPLE_LIMIT) {
        inlineErrors.push({ row: e.row, field: e.field, reason: e.reason });
      }
    }
    await appendErrorReport(errs);
  };

  const checkpoint = async (status?: ICSVImport['status']): Promise<void> => {
    await CSVImport.updateOne(
      { _id: job._id, organizationId },
      {
        $set: {
          processedRows: stats.processedRows,
          lastProcessedRow: stats.processedRows,
          importedCount: stats.importedCount,
          updatedCount: stats.updatedCount,
          duplicateRows: stats.duplicateRows,
          invalidRows: stats.invalidRows,
          failedRows: stats.failedRows,
          errorRows: stats.invalidRows,
          validRows: stats.importedCount + stats.updatedCount,
          rowErrorCount,
          rowErrors: inlineErrors,
          ...(reportInitialized ? { errorReportPath } : {}),
          ...(status ? { status } : {}),
        },
      }
    );

    const currentStatus = status || 'processing';
    const percent = job.totalRows > 0
      ? Math.min(100, Math.round((stats.processedRows / job.totalRows) * 10000) / 100)
      : 0;

    importJobEventEmitter.emit(`progress:${String(job._id)}`, {
      jobId: String(job._id),
      status: currentStatus,
      totalRows: job.totalRows,
      processedRows: stats.processedRows,
      importedCount: stats.importedCount,
      updatedCount: stats.updatedCount,
      duplicateRows: stats.duplicateRows,
      invalidRows: stats.invalidRows,
      failedRows: stats.failedRows,
      errorRows: stats.invalidRows,
      validRows: stats.importedCount + stats.updatedCount,
      percent,
    });
  };

  const batchSizeClamped = Math.max(1, env.IMPORT_BATCH_SIZE);
  const inFileSets = createDuplicateSets();

  const source = fs.createReadStream(filePath);
  const rowStream = createCsvRowStream(source, { highWaterMark: batchSizeClamped });

  let rowIndex = 0;
  let consumedRows = stats.processedRows;
  let batch: ParsedCsvRow[] = [];
  let pendingErrors: ReportError[] = [];
  let fatal = false;

  const flush = async (): Promise<boolean> => {
    const rows = batch;
    batch = [];
    let ok = true;

    if (cancelledImportJobIds.has(jobId)) {
      return false;
    }

    if (rows.length > 0) {
      const result = await persistBatch({
        organizationId,
        rows,
        customFieldMapping,
        duplicateStrategy,
        stats,
      });
      ok = result.ok;
      if (result.errors.length) pendingErrors.push(...result.errors);
    }

    const toRecord = pendingErrors;
    pendingErrors = [];
    await recordErrors(toRecord);

    if (ok && !cancelledImportJobIds.has(jobId)) {
      stats.processedRows = consumedRows;
      await checkpoint();
    }
    return ok;
  };

  try {
    for await (const { rowNumber, raw } of rowStream.rows) {
      if (cancelledImportJobIds.has(jobId)) {
        break;
      }
      rowIndex++;
      if (rowIndex <= startCursor) continue;
      consumedRows++;

      const parsed = normalizeParsedRow(raw, rowNumber, job.mapping as unknown as ColumnMapping, inFileSets, scaleType);

      if (parsed.errors.length > 0) {
        stats.invalidRows++;
        for (const err of parsed.errors) {
          pendingErrors.push({
            row: rowNumber,
            field: err.field || 'validation',
            reason: err.reason,
            company_name: parsed.cleaned.company_name,
            contact_email: parsed.cleaned.contact_email || undefined,
          });
        }
        if (pendingErrors.length >= 500) {
          const chunk = pendingErrors;
          pendingErrors = [];
          await recordErrors(chunk);
        }
        continue;
      }

      batch.push(parsed);
      if (batch.length >= batchSizeClamped) {
        const ok = await flush();
        if (!ok || cancelledImportJobIds.has(jobId)) {
          fatal = true;
          break;
        }
      }
    }

    if (!fatal && !cancelledImportJobIds.has(jobId)) {
      const ok = await flush();
      if (!ok) fatal = true;
    }
  } catch (err: any) {
    if (!cancelledImportJobIds.has(jobId)) {
      fatal = true;
      await recordErrors([{ row: consumedRows, field: 'pipeline', reason: err?.message || 'Import pipeline error' }]);
    }
  } finally {
    source.destroy();
  }

  if (cancelledImportJobIds.has(jobId)) {
    await rollbackCancelledImportJob(jobId, organizationId);
    return;
  }

  if (fatal) {
    await checkpoint('failed');
    await CSVImport.updateOne(
      { _id: job._id, organizationId },
      {
        $set: {
          finishedAt: new Date(),
          errorMessage: 'Import stopped after a database error. Use Retry to resume from the last saved row.',
        },
      }
    );
    return;
  }

  const hasErrors = stats.invalidRows > 0 || stats.failedRows > 0;
  await checkpoint(hasErrors ? 'completed_with_errors' : 'completed');
  await CSVImport.updateOne({ _id: job._id, organizationId }, { $set: { finishedAt: new Date() } });
}

/**
 * Persists one batch with tenant-scoped, indexed lookups (never a full-table
 * scan). Companies/contacts are inserted with `insertMany`; existing rows use
 * fill-empty-only `bulkWrite` updates. Returns `ok: false` when the write phase
 * fails so the caller can stop and allow a resume.
 */
async function persistBatch(ctx: {
  organizationId: string;
  rows: ParsedCsvRow[];
  customFieldMapping: Record<string, string>;
  duplicateStrategy: 'skip' | 'update';
  stats: ImportJobStats;
}): Promise<{ ok: boolean; errors: ReportError[] }> {
  const { organizationId, rows, customFieldMapping, duplicateStrategy, stats } = ctx;
  const errors: ReportError[] = [];

  const domains = new Set<string>();
  const names = new Set<string>();
  const emails = new Set<string>();
  for (const r of rows) {
    if (r.cleaned.domain) domains.add(r.cleaned.domain);
    if (r.cleaned.company_name) names.add(r.cleaned.company_name);
    if (r.cleaned.contact_email) emails.add(r.cleaned.contact_email);
  }

  const companyOrs: any[] = [];
  if (domains.size) companyOrs.push({ domain: { $in: [...domains] } });
  if (names.size) companyOrs.push({ name: { $in: [...names] } });

  let existingCompanies: any[] = [];
  let existingContacts: any[] = [];
  try {
    const [companies, contacts] = await Promise.all([
      companyOrs.length
        ? Company.find({ organizationId, isArchived: false, $or: companyOrs })
            .select('name domain websiteUrl industry city country overallRating notes services customFields')
            .lean()
        : Promise.resolve([] as any[]),
      emails.size
        ? CompanyContact.find({ organizationId, email: { $in: [...emails] } })
            .select('email firstName lastName fullName phone')
            .lean()
        : Promise.resolve([] as any[]),
    ]);
    existingCompanies = companies;
    existingContacts = contacts;
  } catch (err: any) {
    const reason = err?.message || 'Database lookup failed';
    for (const r of rows) {
      errors.push({
        row: r.rowNumber,
        field: 'db_lookup',
        reason,
        company_name: r.cleaned.company_name,
        contact_email: r.cleaned.contact_email || undefined,
      });
    }
    stats.failedRows += rows.length;
    return { ok: false, errors };
  }

  const companyByDomain = new Map<string, any>();
  const companyByName = new Map<string, any>();
  for (const c of existingCompanies) {
    if (c.domain) companyByDomain.set(String(c.domain).toLowerCase(), c);
    if (c.name) companyByName.set(String(c.name).toLowerCase(), c);
  }
  const contactByEmail = new Map<string, any>();
  for (const c of existingContacts) contactByEmail.set(String(c.email).toLowerCase(), c);

  const newCompanies: any[] = [];
  const newAssessments: any[] = [];
  const newContacts: any[] = [];
  const companyUpdates: any[] = [];
  const contactUpdates: any[] = [];
  const seenCompanyKeys = new Set<string>();
  const batchContactEmails = new Set<string>();
  let localImported = 0;
  let localUpdated = 0;
  let localDuplicates = 0;

  for (const parsed of rows) {
    const c = parsed.cleaned;
    const nameKey = String(c.company_name || '').toLowerCase();
    const domainKey = c.domain ? String(c.domain).toLowerCase() : '';
    const dedupeKey = domainKey || nameKey;

    if (seenCompanyKeys.has(dedupeKey)) {
      localDuplicates++;
      continue;
    }
    seenCompanyKeys.add(dedupeKey);

    const existing = (domainKey ? companyByDomain.get(domainKey) : undefined) || companyByName.get(nameKey);

    if (existing) {
      if (duplicateStrategy === 'skip') {
        localDuplicates++;
        continue;
      }

      const updates: Record<string, any> = {};
      if (!existing.domain && c.domain) updates.domain = c.domain;
      if (!existing.websiteUrl && c.website_url) updates.websiteUrl = c.website_url;
      if (!existing.industry && c.industry) updates.industry = c.industry;
      if (!existing.city && c.city) updates.city = c.city;
      if (!existing.country && c.country) updates.country = c.country;
      if ((!existing.notes || existing.overallRating === 'unrated') && c.rating && c.rating !== 'unrated') {
        updates.overallRating = c.rating;
      }
      if (!existing.notes && c.notes) updates.notes = c.notes;
      if ((!existing.services || existing.services.length === 0) && c.services.length) updates.services = c.services;

      const rawCustom = buildCompanyCustomFields(c, parsed.raw, customFieldMapping);
      const { customFields: bounded } = boundCustomFields(rawCustom);
      const existingCF = toPlainObject(existing.customFields);
      for (const [k, v] of Object.entries(bounded)) {
        if (!(k in existingCF)) updates[`customFields.${k}`] = String(v);
      }

      if (Object.keys(updates).length > 0) {
        companyUpdates.push({ updateOne: { filter: { _id: existing._id }, update: { $set: updates } } });
      }

      if (c.contact_email) {
        const key = c.contact_email.toLowerCase();
        const existingContact = contactByEmail.get(key);
        if (existingContact) {
          const cu: Record<string, any> = {};
          if (!existingContact.firstName && c.contact_first_name) cu.firstName = c.contact_first_name;
          if (!existingContact.lastName && c.contact_last_name) cu.lastName = c.contact_last_name;
          const fullName = contactDisplayName(c);
          if (!existingContact.fullName && fullName) cu.fullName = fullName;
          if (!existingContact.phone && c.contact_phone) cu.phone = c.contact_phone;
          if (Object.keys(cu).length > 0) {
            contactUpdates.push({ updateOne: { filter: { _id: existingContact._id }, update: { $set: cu } } });
          }
        } else if (!batchContactEmails.has(key)) {
          batchContactEmails.add(key);
          newContacts.push({
            organizationId,
            companyId: existing._id,
            email: c.contact_email,
            firstName: c.contact_first_name || undefined,
            lastName: c.contact_last_name || undefined,
            fullName: contactDisplayName(c),
            phone: c.contact_phone || undefined,
            isPrimary: true,
            role: 'Executive',
          });
        }
      }

      localUpdated += 1;
      continue;
    }

    // New company
    const { customFields } = boundCustomFields(buildCompanyCustomFields(c, parsed.raw, customFieldMapping));
    const companyId = new mongoose.Types.ObjectId();
    newCompanies.push({
      _id: companyId,
      organizationId,
      name: c.company_name,
      domain: c.domain || undefined,
      websiteUrl: c.website_url || undefined,
      industry: c.industry || undefined,
      city: c.city || undefined,
      country: c.country || undefined,
      overallRating: c.rating || 'unrated',
      rawRating: c.raw_rating || undefined,
      notes: c.notes || undefined,
      services: c.services || [],
      customFields,
    });

    if (c.contact_email) {
      const key = c.contact_email.toLowerCase();
      if (!contactByEmail.has(key) && !batchContactEmails.has(key)) {
        batchContactEmails.add(key);
        newContacts.push({
          organizationId,
          companyId,
          email: c.contact_email,
          firstName: c.contact_first_name || undefined,
          lastName: c.contact_last_name || undefined,
          fullName: contactDisplayName(c),
          phone: c.contact_phone || undefined,
          isPrimary: true,
          role: 'Executive',
        });
      }
    }

    if (c.rating && c.rating !== 'unrated') {
      newAssessments.push({
        organizationId,
        companyId,
        normalizedRating: c.rating,
        scaleUsed: 'csv_import',
        source: 'CSV Import Batch',
        notes: c.notes || undefined,
      });
    }

    localImported += 1;
  }

  try {
    if (newCompanies.length) await Company.insertMany(newCompanies, { ordered: false });
    if (newContacts.length) await CompanyContact.insertMany(newContacts, { ordered: false });
    if (newAssessments.length) await CompanyAssessment.insertMany(newAssessments, { ordered: false });
    if (companyUpdates.length) await Company.bulkWrite(companyUpdates, { ordered: false });
    if (contactUpdates.length) await CompanyContact.bulkWrite(contactUpdates, { ordered: false });
    stats.importedCount += localImported;
    stats.updatedCount += localUpdated;
    stats.duplicateRows += localDuplicates;
    return { ok: true, errors };
  } catch (err: any) {
    const reason = err?.message || 'Database write failed';
    for (const r of rows) {
      errors.push({
        row: r.rowNumber,
        field: 'db_write',
        reason,
        company_name: r.cleaned.company_name,
        contact_email: r.cleaned.contact_email || undefined,
      });
    }
    // Duplicates required no write; everything else in the batch failed.
    stats.duplicateRows += localDuplicates;
    stats.failedRows += localImported + localUpdated;
    return { ok: false, errors };
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Deletes temp uploads + error reports older than the configured TTL. */
export async function cleanupExpiredImports(): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - env.IMPORT_TEMP_TTL_HOURS * 60 * 60 * 1000);
  const stale = await CSVImport.find({
    updatedAt: { $lt: cutoff },
    $or: [{ storedFilePath: { $exists: true } }, { errorReportPath: { $exists: true } }],
  })
    .select('storedFilePath errorReportPath')
    .lean();

  let removed = 0;
  for (const job of stale) {
    await safeUnlink(job.storedFilePath);
    await safeUnlink(job.errorReportPath);
    await CSVImport.updateOne({ _id: job._id }, { $unset: { storedFilePath: 1, errorReportPath: 1 } });
    removed++;
  }
  return { removed };
}

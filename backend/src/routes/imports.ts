import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { CSVImport } from '../models/CSVImport.js';
import { env } from '../config/env.js';
import {
  parseCsvDetailed,
  validateAndNormalizeRows,
  buildCompanyCustomFields,
  mapHeadersToFields,
  assertByteLimit,
  assertRowLimit,
  ColumnMapping,
  CleanedCsvRow,
} from '../services/csv-parser.service.js';
import { boundCustomFields } from '../services/template-interpolation.service.js';
import {
  ensureUploadDir,
  inspectUploadedFile,
  startImportJob,
  retryImportJob,
  cancelImportJob,
  getImportJob,
  importJobEventEmitter,
} from '../services/import-job.service.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/session.js';

const router = Router();

// Every import endpoint requires an authenticated tenant identity.
router.use(requireAuth);

const mappingSchema = z
  .record(z.string())
  .refine((m) => typeof m.company_name === 'string' && m.company_name.trim().length > 0, {
    message: 'A column must be mapped to company_name',
  });

const inspectSchema = z.object({
  csvContent: z.string().min(1, 'CSV content is required'),
  fileName: z.string().max(400).nullish(),
});

const previewImportSchema = z.object({
  csvContent: z.string().min(1, 'CSV content is required'),
  mapping: mappingSchema,
  customFieldMapping: z.record(z.string()).optional(),
  scaleType: z.enum(['standard', 'five_star', 'ten_point']).default('standard'),
});

const commitImportSchema = z.object({
  fileName: z.string().max(400).nullish().transform((v) => v || 'uploaded.csv'),
  rows: z.array(z.any()).max(env.IMPORT_MAX_ROWS + 1, 'Too many rows supplied'),
  mapping: z.record(z.string()).default({}),
  customFieldMapping: z.record(z.string()).optional(),
  duplicateStrategy: z.enum(['skip', 'update']).default('skip'),
});

/** Enforces configured byte/row limits and parses with a real CSV parser. */
function parseAndGuard(csvContent: string) {
  assertByteLimit(csvContent, env.IMPORT_MAX_FILE_BYTES);
  const { headers, rows, errors } = parseCsvDetailed(csvContent);
  assertRowLimit(rows.length, env.IMPORT_MAX_ROWS);
  return { headers, rows, errors };
}

// POST /api/v1/imports/inspect  (detected columns + suggested mapping, no writes)
router.post('/inspect', (req: Request, res: Response, next: NextFunction) => {
  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      payload = { csvContent: payload, fileName: (req.query.fileName as string) || null };
    } else if (payload && typeof payload === 'object' && !payload.csvContent) {
      const fallback = payload.content || payload.csv || payload.fileContent || payload.data;
      if (typeof fallback === 'string') {
        payload = { ...payload, csvContent: fallback };
      }
    }
    const { csvContent, fileName } = inspectSchema.parse(payload);
    const { headers, rows, errors } = parseAndGuard(csvContent);

    if (headers.length === 0) {
      throw new AppError('No columns detected in the CSV. Check that the file is a valid CSV with a header row.', 400, 'EMPTY_CSV');
    }

    const { mapping, unmapped, missingRequired } = mapHeadersToFields(headers);
    const byteLength = Buffer.byteLength(csvContent, 'utf8');

    res.status(200).json({
      success: true,
      data: {
        fileName: fileName || null,
        byteLength,
        rowCount: rows.length,
        totalRows: rows.length,
        headers,
        detectedMapping: mapping,
        unmappedHeaders: unmapped,
        missingRequiredFields: missingRequired,
        sampleRows: rows.slice(0, 5),
        parseErrors: errors,
        limits: { maxFileBytes: env.IMPORT_MAX_FILE_BYTES, maxRows: env.IMPORT_MAX_ROWS },
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/imports/preview  (validate + normalize + duplicate preview; no writes)
router.post('/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { csvContent, mapping, scaleType } = previewImportSchema.parse(req.body);
    const orgId = req.organizationId;

    const { headers, rows: rawRows, errors: parseErrors } = parseAndGuard(csvContent);

    const [existingCompanies, existingContacts] = await Promise.all([
      Company.find({ organizationId: orgId, isArchived: false }).select('name domain').lean(),
      CompanyContact.find({ organizationId: orgId }).select('email').lean(),
    ]);

    const existingDomains = new Set(existingCompanies.map((c) => c.domain).filter(Boolean) as string[]);
    const existingNames = new Set(existingCompanies.map((c) => String(c.name).toLowerCase()));
    const existingEmails = new Set(existingContacts.map((c) => String(c.email).toLowerCase()));

    const summary = validateAndNormalizeRows(
      rawRows,
      mapping as unknown as ColumnMapping,
      existingDomains,
      existingNames,
      existingEmails,
      scaleType
    );

    res.status(200).json({
      success: true,
      data: {
        headers,
        parseErrors,
        unmappedHeaders: mapHeadersToFields(headers).unmapped,
        summary,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Finds an existing company for the tenant by domain (preferred) or name. */
async function findExistingCompany(orgId: string, cleaned: CleanedCsvRow) {
  const ors: any[] = [];
  if (cleaned.domain) ors.push({ domain: cleaned.domain });
  if (cleaned.company_name) ors.push({ name: cleaned.company_name });
  if (ors.length === 0) return null;
  return Company.findOne({ organizationId: orgId, $or: ors });
}

// POST /api/v1/imports/commit  (idempotent, tenant-scoped, safe duplicates)
router.post('/commit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fileName, rows, mapping, customFieldMapping = {}, duplicateStrategy } = commitImportSchema.parse(req.body);
    const orgId = req.organizationId;

    let importedCount = 0;
    let updatedCount = 0;
    const errors: { row: number; field: string; reason: string }[] = [];

    for (const parsedRow of rows) {
      if (parsedRow.errors && parsedRow.errors.length > 0) {
        errors.push(...parsedRow.errors.map((e: any) => ({ row: parsedRow.rowNumber, ...e })));
        continue;
      }

      const cleaned: CleanedCsvRow = parsedRow.cleaned;
      const rawCustom = buildCompanyCustomFields(cleaned, parsedRow.raw || {}, customFieldMapping);

      try {
        if (parsedRow.isDuplicate && duplicateStrategy === 'skip') {
          continue;
        }

        const existing = parsedRow.isDuplicate ? await findExistingCompany(orgId, cleaned) : null;

        if (existing && duplicateStrategy === 'update') {
          // Fill empty fields only — never overwrite existing tenant data.
          const updates: Record<string, any> = {};
          if (!existing.domain && cleaned.domain) updates.domain = cleaned.domain;
          if (!existing.websiteUrl && cleaned.website_url) updates.websiteUrl = cleaned.website_url;
          if (!existing.industry && cleaned.industry) updates.industry = cleaned.industry;
          if (!existing.city && cleaned.city) updates.city = cleaned.city;
          if (!existing.country && cleaned.country) updates.country = cleaned.country;
          if ((!existing.notes || existing.overallRating === 'unrated') && cleaned.rating && cleaned.rating !== 'unrated') {
            updates.overallRating = cleaned.rating;
          }
          if (!existing.notes && cleaned.notes) updates.notes = cleaned.notes;
          if ((!existing.services || existing.services.length === 0) && cleaned.services.length) updates.services = cleaned.services;

          if (Object.keys(updates).length > 0) await Company.updateOne({ _id: existing._id }, { $set: updates });

          for (const [k, v] of Object.entries(rawCustom)) {
            if (!existing.customFields?.get(k)) existing.customFields.set(k, String(v));
          }
          await existing.save();

          if (cleaned.contact_email) {
            const contact = await CompanyContact.findOne({ organizationId: orgId, email: cleaned.contact_email });
            if (contact) {
              if (!contact.firstName && cleaned.contact_first_name) contact.firstName = cleaned.contact_first_name;
              if (!contact.lastName && cleaned.contact_last_name) contact.lastName = cleaned.contact_last_name;
              if (!contact.fullName) contact.fullName = cleaned.contact_full_name || undefined;
              if (!contact.phone && cleaned.contact_phone) contact.phone = cleaned.contact_phone;
              await contact.save();
            } else {
              await createContact(orgId, existing._id, cleaned);
            }
          }
          updatedCount++;
          continue;
        }

        // New company.
        const { customFields } = boundCustomFields(rawCustom);
        const company = await Company.create({
          organizationId: orgId,
          name: cleaned.company_name,
          domain: cleaned.domain || undefined,
          websiteUrl: cleaned.website_url || undefined,
          industry: cleaned.industry || undefined,
          city: cleaned.city || undefined,
          country: cleaned.country || undefined,
          overallRating: cleaned.rating || 'unrated',
          rawRating: cleaned.raw_rating || undefined,
          notes: cleaned.notes || undefined,
          services: cleaned.services || [],
          customFields,
        });

        if (cleaned.contact_email) {
          const existingContact = await CompanyContact.findOne({ organizationId: orgId, email: cleaned.contact_email });
          if (!existingContact) {
            await createContact(orgId, company._id, cleaned);
          }
        }

        if (cleaned.rating && cleaned.rating !== 'unrated') {
          await CompanyAssessment.create({
            organizationId: orgId,
            companyId: company._id,
            normalizedRating: cleaned.rating,
            scaleUsed: 'csv_import',
            source: 'CSV Import Batch',
            notes: cleaned.notes || undefined,
          });
        }

        importedCount++;
      } catch (insertErr: any) {
        errors.push({
          row: parsedRow.rowNumber,
          field: 'db_insert',
          reason: insertErr.message || 'Database error during record insertion',
        });
      }
    }

    const importLog = await CSVImport.create({
      organizationId: orgId,
      fileName,
      totalRows: rows.length,
      validRows: importedCount + updatedCount,
      errorRows: errors.length,
      duplicateRows: rows.filter((r: any) => r.isDuplicate).length,
      importedCount,
      status: errors.length > 0 && importedCount === 0 && updatedCount === 0 ? 'failed' : 'completed',
      rowErrors: errors,
      mapping,
    });

    res.status(201).json({
      success: true,
      data: {
        ...importLog.toObject(),
        importedCount,
        updatedCount,
        duplicatePolicy: duplicateStrategy,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Creates a primary contact for a company from a cleaned CSV row. */
async function createContact(orgId: string, companyId: any, cleaned: CleanedCsvRow) {
  await CompanyContact.create({
    organizationId: orgId,
    companyId,
    firstName: cleaned.contact_first_name || undefined,
    lastName: cleaned.contact_last_name || undefined,
    fullName:
      cleaned.contact_full_name ||
      [cleaned.contact_first_name, cleaned.contact_last_name].filter(Boolean).join(' ') ||
      undefined,
    email: cleaned.contact_email,
    phone: cleaned.contact_phone || undefined,
    isPrimary: true,
  });
}

// GET /api/v1/imports/active  (reconnect recovery for active background imports)
router.get('/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const activeJob = await CSVImport.findOne({
      organizationId: req.organizationId,
      status: { $in: ['queued', 'processing', 'pending'] },
    })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ success: true, data: activeJob || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/imports
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const history = await CSVImport.find({ organizationId: req.organizationId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.status(200).json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Streaming / resumable import jobs
//
// These endpoints are the large-file path: the CSV is uploaded to disk (never
// buffered in memory), inspected by streaming, then processed in bounded batches
// with progress polling and a downloadable error report. The legacy JSON
// inspect/preview/commit endpoints above remain available and unchanged.
// ---------------------------------------------------------------------------

const uploadDir = ensureUploadDir();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const safeName = String(file.originalname || 'upload.csv')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 120);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeName}`);
    },
  }),
  limits: { fileSize: env.IMPORT_MAX_FILE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const nameOk = /\.csv$/i.test(file.originalname || '');
    const mimeOk = /(text\/csv|text\/plain|application\/vnd\.ms-excel|application\/octet-stream|application\/csv)/i.test(
      file.mimetype || ''
    );
    cb(null, nameOk || mimeOk);
  },
});

const startJobSchema = z.object({
  mapping: mappingSchema.optional(),
  customFieldMapping: z.record(z.string()).optional(),
  duplicateStrategy: z.enum(['skip', 'update']).optional(),
  scaleType: z.enum(['standard', 'five_star', 'ten_point']).optional(),
});

function jobResponse(job: any) {
  const total = job.totalRows || 0;
  const processed = job.processedRows || 0;
  return {
    ...job,
    jobId: String(job._id),
    rowCount: job.totalRows,
    byteLength: job.fileBytes,
    progressPct: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    limits: { maxFileBytes: env.IMPORT_MAX_FILE_BYTES, maxRows: env.IMPORT_MAX_ROWS },
  };
}

// POST /api/v1/imports/jobs  (multipart upload + streaming inspect; no row writes)
router.post('/jobs', (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, async (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = (env.IMPORT_MAX_FILE_BYTES / (1024 * 1024)).toFixed(0);
        return next(new AppError(`CSV file exceeds the configured limit of ${mb} MB`, 413, 'FILE_TOO_LARGE'));
      }
      return next(err);
    }
    try {
      if (!req.file) {
        throw new AppError('No file uploaded. Attach a CSV file as the "file" form field.', 400, 'FILE_REQUIRED');
      }

      const job = await inspectUploadedFile({
        organizationId: req.organizationId,
        fileName: req.file.originalname || 'uploaded.csv',
        storedFilePath: req.file.path,
        fileBytes: req.file.size,
      });

      const { mapping, unmapped, missingRequired } = mapHeadersToFields(job.headers);

      res.status(201).json({
        success: true,
        data: {
          ...job.toObject(),
          jobId: String(job._id),
          fileName: job.fileName,
          rowCount: job.totalRows,
          byteLength: job.fileBytes,
          headers: job.headers,
          sampleRows: job.sampleRows,
          detectedMapping: mapping,
          unmappedHeaders: unmapped,
          missingRequiredFields: missingRequired,
          limits: { maxFileBytes: env.IMPORT_MAX_FILE_BYTES, maxRows: env.IMPORT_MAX_ROWS },
        },
      });
    } catch (err) {
      next(err);
    }
  });
});

// POST /api/v1/imports/jobs/:id/start  (kick off background processing)
router.post('/jobs/:id/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const overrides = startJobSchema.parse(req.body || {});
    const job = await startImportJob(req.params.id, req.organizationId, overrides);
    res.status(202).json({ success: true, data: job.toObject() });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/imports/jobs/:id  (progress + counters)
router.get('/jobs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getImportJob(req.params.id, req.organizationId);
    const obj = job.toObject();
    const percent =
      job.totalRows > 0
        ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 10000) / 100)
        : 0;
    res.status(200).json({ success: true, data: { ...obj, percent } });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/imports/jobs/:id/stream  (Server-Sent Events real-time progress)
router.get('/jobs/:id/stream', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getImportJob(req.params.id, req.organizationId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const percent =
      job.totalRows > 0
        ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 10000) / 100)
        : 0;

    const initial = {
      jobId: String(job._id),
      status: job.status,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      importedCount: job.importedCount,
      updatedCount: job.updatedCount,
      duplicateRows: job.duplicateRows,
      invalidRows: job.invalidRows,
      failedRows: job.failedRows,
      errorRows: job.invalidRows,
      validRows: job.validRows || job.importedCount + job.updatedCount,
      percent,
      errorMessage: job.errorMessage,
    };
    res.write(`data: ${JSON.stringify(initial)}\n\n`);

    if (!['queued', 'processing', 'pending', 'cancellation_requested', 'cancelling'].includes(job.status)) {
      res.end();
      return;
    }

    const onProgress = (update: any) => {
      res.write(`data: ${JSON.stringify(update)}\n\n`);
      if (!['queued', 'processing', 'pending', 'cancellation_requested', 'cancelling'].includes(update.status)) {
        importJobEventEmitter.off(`progress:${req.params.id}`, onProgress);
        res.end();
      }
    };

    importJobEventEmitter.on(`progress:${req.params.id}`, onProgress);

    req.on('close', () => {
      importJobEventEmitter.off(`progress:${req.params.id}`, onProgress);
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/imports/jobs/:id/errors  (downloadable CSV report, or JSON sample)
router.get('/jobs/:id/errors', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getImportJob(req.params.id, req.organizationId);

    if (req.query.format === 'json' || !job.errorReportPath || !fs.existsSync(job.errorReportPath)) {
      res.status(200).json({
        success: true,
        data: { count: job.rowErrorCount || job.rowErrors?.length || 0, errors: job.rowErrors || [] },
      });
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="import_errors_${String(job._id)}.csv"`
    );
    fs.createReadStream(job.errorReportPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/imports/jobs/:id/retry  (resume from the last committed row)
router.post('/jobs/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await retryImportJob(req.params.id, req.organizationId);
    res.status(202).json({ success: true, data: job.toObject() });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/imports/jobs/:id/cancel  (halt and rollback partial data)
router.post('/jobs/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await cancelImportJob(req.params.id, req.organizationId, req.userId);
    res.status(200).json({ success: true, data: job.toObject(), message: 'Import cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

export default router;

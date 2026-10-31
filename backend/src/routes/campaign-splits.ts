import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { Campaign } from '../models/Campaign.js';
import { CampaignSplitJob } from '../models/CampaignSplitJob.js';
import {
  campaignSplitService,
  formatSplitJobResponse,
} from '../services/campaign-split.service.js';
import {
  ensureUploadDir,
  inspectSpreadsheetFile,
  safeUnlinkFile,
  initChunkedUploadSession,
  writeUploadChunk,
  getUploadSessionStatus,
  finalizeUploadSession,
  abortUploadSession,
} from '../services/spreadsheet-stream.service.js';
import { requireAuth } from '../middleware/session.js';
import { AppError } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';

const router = Router();

// Every split job, upload session and child campaign is tenant-scoped and
// requires a real authenticated session. No header/dev-mock fallbacks here.
router.use(requireAuth);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ensureUploadDir()),
  filename: (_req, file, cb) => {
    const uniquePrefix = `upl_split_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uniquePrefix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: env.IMPORT_MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.xlsx', '.xls', '.txt'].includes(ext)) cb(null, true);
    else cb(new AppError('Only CSV and Excel (.xlsx, .xls) files are supported', 400, 'UNSUPPORTED_FILE_TYPE'));
  },
});

/** Converts multer's limit error into the API's deliberate 413 shape. */
function acceptFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: any) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return next(
        new AppError(
          `File exceeds the ${(env.IMPORT_MAX_FILE_BYTES / (1024 * 1024 * 1024)).toFixed(0)} GB upload limit.`,
          413,
          'FILE_TOO_LARGE'
        )
      );
    }
    next(err);
  });
}

router.post('/upload', acceptFile, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE_UPLOADED');
    const uploadId = path.basename(req.file.filename, path.extname(req.file.filename));
    const inspection = await inspectSpreadsheetFile(req.file.path, req.file.originalname, {
      maxPreviewRows: env.IMPORT_MAX_PREVIEW_ROWS,
    });
    res.status(200).json({
      success: true,
      data: {
        uploadId,
        fileName: req.file.originalname,
        fileType: inspection.fileType,
        fileSize: req.file.size,
        headers: inspection.headers,
        sampleRows: inspection.sampleRows,
        totalRows: inspection.totalRows,
        totalRowsIsExact: inspection.totalRowsIsExact,
        delimiter: inspection.delimiter,
        maxUploadBytes: env.IMPORT_MAX_FILE_BYTES,
        chunkSizeBytes: env.IMPORT_CHUNK_SIZE_BYTES,
      },
    });
  } catch (err) {
    if (req.file?.path) await safeUnlinkFile(req.file.path);
    next(err);
  }
});

const initUploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
  chunkSize: z.number().int().positive().optional(),
});

router.post('/upload/init', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = initUploadSchema.parse(req.body);
    const session = await initChunkedUploadSession(body.fileName, body.fileSize, body.chunkSize);
    res.status(200).json({ success: true, data: session });
  } catch (err) {
    next(err);
  }
});

const MAX_ACCEPTED_CHUNK_BYTES = Math.min(64 * 1024 * 1024, env.IMPORT_CHUNK_SIZE_BYTES * 2 + 1024 * 1024);
const chunkMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ACCEPTED_CHUNK_BYTES },
});

router.put(
  '/upload/:uploadId/chunk',
  (req: Request, res: Response, next: NextFunction) => {
    if (req.is('multipart/form-data')) {
      chunkMemoryUpload.single('chunk')(req, res, (err: any) => {
        if (err?.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError('Chunk exceeds the maximum allowed size.', 413, 'CHUNK_TOO_LARGE'));
        }
        next(err);
      });
      return;
    }

    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > MAX_ACCEPTED_CHUNK_BYTES) {
      return next(new AppError('Chunk exceeds the maximum allowed size.', 413, 'CHUNK_TOO_LARGE'));
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let finished = false;
    const fail = (err: any) => {
      if (finished) return;
      finished = true;
      chunks.length = 0;
      next(err);
    };
    req.on('data', (data: Buffer) => {
      if (finished) return;
      received += data.length;
      if (received > MAX_ACCEPTED_CHUNK_BYTES) {
        req.pause();
        fail(new AppError('Chunk exceeds the maximum allowed size.', 413, 'CHUNK_TOO_LARGE'));
        return;
      }
      chunks.push(data);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      (req as any).rawBuffer = Buffer.concat(chunks);
      next();
    });
    req.on('error', fail);
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const chunkIndex = parseInt(String(req.query.chunkIndex ?? req.body?.chunkIndex ?? ''), 10);
      if (Number.isNaN(chunkIndex)) {
        throw new AppError('chunkIndex query parameter is required', 400, 'INVALID_CHUNK_INDEX');
      }
      let buffer: Buffer | undefined;
      if (req.file?.buffer) buffer = req.file.buffer;
      else if ((req as any).rawBuffer) buffer = (req as any).rawBuffer;
      if (!buffer || buffer.length === 0) {
        throw new AppError('No chunk data received', 400, 'EMPTY_CHUNK');
      }
      const result = await writeUploadChunk(req.params.uploadId, chunkIndex, buffer);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/upload/:uploadId/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getUploadSessionStatus(req.params.uploadId);
    res.status(200).json({ success: true, data: status });
  } catch (err) {
    next(err);
  }
});

router.post('/upload/:uploadId/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await finalizeUploadSession(req.params.uploadId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.delete('/upload/:uploadId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await abortUploadSession(req.params.uploadId);
    res.status(200).json({ success: true, message: 'Upload session aborted and cleaned up' });
  } catch (err) {
    next(err);
  }
});

const stepSchema = z.object({
  subject: z.string().min(1, 'Step subject is required').max(300),
  bodyText: z.string().min(1, 'Step body is required').max(20000),
  delayDays: z.number().int().min(0).max(90).optional(),
});

const createSplitSchema = z.object({
  uploadId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  groupName: z.string().trim().min(1, 'A parent group name is required').max(120),
  campaignNamePattern: z
    .string()
    .max(200)
    .refine((pattern) => pattern.includes('{number}'), 'The naming pattern must include {number}')
    .optional(),
  contactsPerCampaign: z.number().int().min(1).max(10000).optional(),
  mailboxId: z.string().min(1, 'A sending mailbox is required').max(254),
  senderAccountIds: z.array(z.string().min(1)).max(20).optional(),
  tone: z.string().max(40).optional(),
  generationMode: z.enum(['template', 'ai']).default('template'),
  targetService: z.string().max(200).optional(),
  steps: z.array(stepSchema).min(1, 'At least one email step is required').max(10),
  columnMapping: z
    .record(z.string())
    .refine((mapping) => typeof mapping.company_name === 'string' && mapping.company_name.trim().length > 0, {
      message: 'A column must be mapped to company_name',
    }),
  customFieldMapping: z.record(z.string()).optional(),
  scaleType: z.enum(['standard', 'five_star', 'ten_point']).default('standard'),
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createSplitSchema.parse(req.body);
    const job = await campaignSplitService.createJob({
      organizationId: req.organizationId,
      actorId: req.userId,
      ...body,
    });
    res.status(202).json({ success: true, data: formatSplitJobResponse(job) });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '25'), 10) || 25, 100));
    const jobs = await CampaignSplitJob.find({ organizationId: req.organizationId })
      .sort({ createdAt: -1 })
      .limit(limit);
    res.status(200).json({ success: true, data: jobs.map(formatSplitJobResponse) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await campaignSplitService.getJob(req.organizationId, req.params.id);
    res.status(200).json({ success: true, data: formatSplitJobResponse(job) });
  } catch (err) {
    next(err);
  }
});

const planSchema = z.object({
  contactsPerCampaign: z.number().int().min(1, 'At least one contact per campaign').max(10000),
  groupName: z.string().trim().min(1).max(120).optional(),
  campaignNamePattern: z
    .string()
    .max(200)
    .refine((pattern) => pattern.includes('{number}'), 'The naming pattern must include {number}')
    .optional(),
});

router.post('/:id/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = planSchema.parse(req.body);
    const job = await campaignSplitService.confirmPlan(req.organizationId, req.params.id, body);
    res.status(200).json({ success: true, data: formatSplitJobResponse(job) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await campaignSplitService.startGeneration(req.organizationId, req.params.id);
    res.status(202).json({ success: true, data: formatSplitJobResponse(job) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await campaignSplitService.requestCancellation(
      req.organizationId,
      req.params.id,
      req.userId
    );
    res.status(200).json({ success: true, data: formatSplitJobResponse(job) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await campaignSplitService.retry(req.organizationId, req.params.id);
    res.status(202).json({ success: true, data: formatSplitJobResponse(job) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await campaignSplitService.getJob(req.organizationId, req.params.id);
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200));
    const filter = { organizationId: req.organizationId, parentImportId: job._id };

    const [campaigns, total] = await Promise.all([
      Campaign.find(filter)
        .select('name status stats campaignNumber groupName createdAt updatedAt schedule')
        .sort({ campaignNumber: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Campaign.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: {
        campaigns: campaigns.map((campaign) => ({
          id: String(campaign._id),
          name: campaign.name,
          campaignNumber: campaign.campaignNumber,
          status: campaign.status,
          stats: campaign.stats,
          createdAt: campaign.createdAt,
          updatedAt: campaign.updatedAt,
          schedule: campaign.schedule
            ? { startAt: campaign.schedule.startAt, timezone: campaign.schedule.timezone }
            : undefined,
        })),
        total,
        page,
        limit,
        expectedCampaigns: job.expectedCampaigns,
        failedCampaignNumbers: job.failedCampaignNumbers || [],
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/recipients/integrity', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await campaignSplitService.auditRecipients(req.organizationId, req.params.id);
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/recipients/repair', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await campaignSplitService.repairRecipients(req.organizationId, req.params.id);
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/errors', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await campaignSplitService.getJob(req.organizationId, req.params.id);
    const reportPath = job.errorReportPath;
    if (!reportPath || !fs.existsSync(reportPath)) {
      throw new AppError('No rejected-contact report exists for this import.', 404, 'NO_ERROR_REPORT');
    }
    const baseName = (job.groupName || 'split-import')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'split-import';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}-invalid-contacts.csv"`);
    fs.createReadStream(reportPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

export default router;

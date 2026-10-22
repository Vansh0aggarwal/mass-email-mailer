import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { campaignService, campaignJobEventEmitter } from '../services/campaign.service.js';
import { campaignSchedulerService } from '../services/campaign-scheduler.service.js';
import { replyAssociationService } from '../services/reply-association.service.js';
import { senderAccountService } from '../services/sender-account.service.js';
import { senderAllocationService } from '../services/sender-allocation.service.js';
import { senderQueueService } from '../services/sender-queue.service.js';
import { parseCsvDetailed, assertByteLimit, assertRowLimit } from '../services/csv-parser.service.js';
import {
  ensureUploadDir,
  inspectSpreadsheetFile,
  safeUnlinkFile,
  resolveUploadedFilePath,
  initChunkedUploadSession,
  writeUploadChunk,
  getUploadSessionStatus,
  finalizeUploadSession,
  abortUploadSession,
} from '../services/spreadsheet-stream.service.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, ensureUploadDir());
  },
  filename: (_req, file, cb) => {
    const uniquePrefix = `upl_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uniquePrefix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: env.IMPORT_MAX_FILE_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.xlsx', '.xls', '.txt'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new AppError('Only CSV and Excel (.xlsx, .xls) files are supported', 400, 'UNSUPPORTED_FILE_TYPE'));
    }
  },
});

const stepSchema = z.object({
  subject: z.string().min(1, 'Step subject is required').max(300),
  bodyText: z.string().min(1, 'Step body is required').max(20000),
  delayDays: z.number().int().min(0).max(90).optional(),
});

const createCampaignSchema = z
  .object({
    name: z.string().min(1, 'Campaign name is required').max(200),
    mailboxId: z.string().min(1, 'A sending mailbox is required'),
    tone: z.string().max(40).optional(),
    generationMode: z.enum(['template', 'ai']).default('template'),
    targetService: z.string().max(200).optional(),
    senderName: z.string().max(120).optional(),
    steps: z.array(stepSchema).min(1, 'At least one email step is required').max(10),
    csvContent: z.string().optional(),
    uploadId: z.string().optional(),
    columnMapping: z
      .record(z.string())
      .refine((m) => typeof m.company_name === 'string' && m.company_name.trim().length > 0, {
        message: 'A column must be mapped to company_name',
      }),
    customFieldMapping: z.record(z.string()).optional(),
    scaleType: z.enum(['standard', 'five_star', 'ten_point']).default('standard'),
    duplicateStrategy: z.enum(['skip', 'include']).default('skip'),
    senderAccountIds: z
      .array(z.string().min(1))
      .max(20, 'A campaign may use at most 20 sender accounts')
      .optional(),
  })
  .refine((data) => data.uploadId || data.csvContent, {
    message: 'Either uploadId or csvContent must be provided',
    path: ['uploadId'],
  });

const chunkMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per chunk limit
});

// POST /api/v1/campaigns/upload (direct streaming multipart upload for CSV and XLSX)
router.post('/upload', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      throw new AppError('No file uploaded', 400, 'NO_FILE_UPLOADED');
    }
    const uploadId = path.basename(req.file.filename, path.extname(req.file.filename));
    const inspection = await inspectSpreadsheetFile(req.file.path, req.file.originalname, {
      maxPreviewRows: env.IMPORT_MAX_PREVIEW_ROWS,
    });

    res.status(200).json({
      success: true,
      data: {
        uploadId,
        storedFilePath: req.file.path,
        fileName: req.file.originalname,
        fileType: inspection.fileType,
        fileSize: req.file.size,
        headers: inspection.headers,
        sampleRows: inspection.sampleRows,
        totalRows: inspection.totalRows,
        totalRowsIsExact: inspection.totalRowsIsExact,
        delimiter: inspection.delimiter,
      },
    });
  } catch (err) {
    if (req.file?.path) {
      await safeUnlinkFile(req.file.path);
    }
    next(err);
  }
});

// POST /api/v1/campaigns/upload/init (resumable chunked upload initialization)
router.post('/upload/init', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fileName, fileSize, chunkSize } = z
      .object({
        fileName: z.string().min(1, 'fileName is required'),
        fileSize: z.number().int().positive('fileSize must be positive'),
        chunkSize: z.number().int().positive().optional(),
      })
      .parse(req.body);

    const session = await initChunkedUploadSession(fileName, fileSize, chunkSize);
    res.status(200).json({ success: true, data: session });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/campaigns/upload/:uploadId/chunk (upload single chunk slice with retry support)
router.put(
  '/upload/:uploadId/chunk',
  (req: Request, res: Response, next: NextFunction) => {
    if (req.is('multipart/form-data')) {
      chunkMemoryUpload.single('chunk')(req, res, next);
    } else {
      const chunks: Buffer[] = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        (req as any).rawBuffer = Buffer.concat(chunks);
        next();
      });
      req.on('error', next);
    }
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { uploadId } = req.params;
      const rawIndex = req.query.chunkIndex ?? req.body?.chunkIndex;
      const chunkIndex = parseInt(String(rawIndex ?? ''), 10);
      if (isNaN(chunkIndex)) {
        throw new AppError('chunkIndex query parameter is required', 400, 'INVALID_CHUNK_INDEX');
      }

      let buffer: Buffer | undefined;
      if (req.file?.buffer) {
        buffer = req.file.buffer;
      } else if ((req as any).rawBuffer) {
        buffer = (req as any).rawBuffer;
      }

      if (!buffer || buffer.length === 0) {
        throw new AppError('No chunk data received', 400, 'EMPTY_CHUNK');
      }

      const result = await writeUploadChunk(uploadId, chunkIndex, buffer);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/campaigns/upload/:uploadId/status (check received chunks for resume)
router.get('/upload/:uploadId/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getUploadSessionStatus(req.params.uploadId);
    res.status(200).json({ success: true, data: status });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/upload/:uploadId/complete (assemble and verify multi-GB file)
router.post('/upload/:uploadId/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await finalizeUploadSession(req.params.uploadId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/campaigns/upload/:uploadId (abort chunked upload session and clean disk parts)
router.delete('/upload/:uploadId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await abortUploadSession(req.params.uploadId);
    res.status(200).json({ success: true, message: 'Upload session aborted and cleaned up' });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/preview  (headers + sample rows for the mapping wizard)
router.post('/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { csvContent, uploadId } = z
      .object({
        csvContent: z.string().optional(),
        uploadId: z.string().optional(),
      })
      .refine((d) => d.csvContent || d.uploadId, {
        message: 'Either uploadId or csvContent is required',
      })
      .parse(req.body);

    if (uploadId) {
      const resolved = resolveUploadedFilePath(uploadId);
      if (!resolved) {
        throw new AppError('Uploaded file not found or expired', 400, 'FILE_NOT_FOUND');
      }
      const inspection = await inspectSpreadsheetFile(resolved.filePath, path.basename(resolved.filePath), {
        maxPreviewRows: env.IMPORT_MAX_PREVIEW_ROWS,
      });
      return res.status(200).json({
        success: true,
        data: {
          headers: inspection.headers,
          sampleRows: inspection.sampleRows,
          totalRows: inspection.totalRows,
        },
      });
    }

    assertByteLimit(csvContent!, env.IMPORT_MAX_FILE_BYTES);
    const { headers, rows } = parseCsvDetailed(csvContent!);
    assertRowLimit(rows.length, env.IMPORT_MAX_ROWS);

    if (headers.length === 0) throw new AppError('No columns detected in the CSV', 400, 'EMPTY_CSV');

    res.status(200).json({
      success: true,
      data: { headers, sampleRows: rows.slice(0, 5), totalRows: rows.length },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns (supports ?async=true for live progress jobs)
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createCampaignSchema.parse(req.body);
    if (req.query.async === 'true') {
      const job = await campaignService.startCampaignCreationJob({
        organizationId: req.organizationId,
        actorId: req.userId,
        ...body,
      });
      return res.status(202).json({ success: true, data: job });
    }

    const result = await campaignService.createCampaign({
      organizationId: req.organizationId,
      actorId: req.userId,
      ...body,
    });
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/jobs (asynchronous creation with live progress tracking)
router.post('/jobs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createCampaignSchema.parse(req.body);
    const job = await campaignService.startCampaignCreationJob({
      organizationId: req.organizationId,
      actorId: req.userId,
      ...body,
    });
    res.status(202).json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/jobs/active (fetch in-progress creation job for tenant)
router.get('/jobs/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const active = await campaignService.getActiveCampaignCreationJob(req.organizationId);
    res.status(200).json({ success: true, data: active });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/jobs/:jobId (poll progress counters)
router.get('/jobs/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await campaignService.getCampaignCreationJob(req.params.jobId, req.organizationId);
    res.status(200).json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/jobs/:jobId/cancel (safely cancel active import and rollback data)
router.post('/jobs/:jobId/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await campaignService.cancelCampaignCreationJob(
      req.params.jobId,
      req.organizationId,
      req.userId
    );
    res.status(200).json({ success: true, data: job, message: 'Import cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/jobs/:jobId/errors (download disk-persisted CSV error log)
router.get('/jobs/:jobId/errors', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filePath, fileName } = await campaignService.getJobErrorReport(
      req.params.jobId,
      req.organizationId
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/jobs/:jobId/stream (Server-Sent Events real-time progress)
router.get('/jobs/:jobId/stream', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await campaignService.getCampaignCreationJob(req.params.jobId, req.organizationId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Send immediate initial progress state
    res.write(`data: ${JSON.stringify(job)}\n\n`);

    if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status)) {
      res.end();
      return;
    }

    const onProgress = (update: any) => {
      try {
        res.write(`data: ${JSON.stringify(update)}\n\n`);
        if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(update.status)) {
          campaignJobEventEmitter.off(`progress:${req.params.jobId}`, onProgress);
          res.end();
        }
      } catch {
        campaignJobEventEmitter.off(`progress:${req.params.jobId}`, onProgress);
      }
    };

    campaignJobEventEmitter.on(`progress:${req.params.jobId}`, onProgress);

    req.on('close', () => {
      campaignJobEventEmitter.off(`progress:${req.params.jobId}`, onProgress);
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaigns = await Campaign.find({ organizationId: req.organizationId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.status(200).json({ success: true, data: campaigns });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/sender-accounts
// Every connected account of the organization that may act as a campaign sender.
// Registered before `/:id` so the literal path wins over the id route.
router.get('/sender-accounts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await senderAccountService.listSenderAccounts(req.organizationId);
    res.status(200).json({ success: true, data: accounts });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, organizationId: req.organizationId }).lean();
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    res.status(200).json({ success: true, data: campaign });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/:id/progress
router.get('/:id/progress', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const progress = await campaignService.getProgress(req.organizationId, req.params.id);
    res.status(200).json({ success: true, data: progress });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/:id/recipients  (review queue with complete pagination)
router.get('/:id/recipients', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';

    // Build filter query scoped to organization and campaign
    const filterQuery: any = {
      organizationId: req.organizationId,
      campaignId: campaign._id,
    };

    if (status && status !== 'all') {
      filterQuery.status = status;
    }

    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filterQuery.$or = [
        { email: searchRegex },
        { companyName: searchRegex },
        { name: searchRegex },
      ];
    }

    const [recipients, total] = await Promise.all([
      CampaignRecipient.find(filterQuery)
        .sort({ rowNumber: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CampaignRecipient.countDocuments(filterQuery),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    // Attach the generated step drafts so the UI can show previews.
    const draftIds = recipients.flatMap((r: any) => (r.stepDrafts || []).map((d: any) => d.draftId)).filter(Boolean);
    const drafts = draftIds.length
      ? await EmailDraft.find({ _id: { $in: draftIds }, organizationId: req.organizationId }).lean()
      : [];
    const draftMap = new Map(drafts.map((d: any) => [String(d._id), d]));

    const enriched = recipients.map((r: any) => ({
      ...r,
      stepDrafts: (r.stepDrafts || []).map((d: any) => ({
        ...d,
        draft: d.draftId ? draftMap.get(String(d.draftId)) || null : null,
      })),
    }));

    res.status(200).json({
      success: true,
      data: {
        recipients: enriched,
        total,
        page,
        limit,
        totalPages,
        hasNextPage,
        hasPreviousPage,
        steps: campaign.steps,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/generate  (batched, resumable)
router.post('/:id/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { batchSize, senderName } = z
      .object({ batchSize: z.number().int().positive().max(200).optional(), senderName: z.string().max(120).optional() })
      .parse(req.body || {});

    const result = await campaignService.generateDraftsBatch(req.organizationId, req.params.id, batchSize, senderName);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/approve
router.post('/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { recipientIds } = z.object({ recipientIds: z.array(z.string()).optional() }).parse(req.body || {});
    const result = await campaignService.approveRecipients(req.organizationId, req.params.id, recipientIds);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/campaigns/:id/recipients/:recipientId/steps/:stepIndex
router.patch('/:id/recipients/:recipientId/steps/:stepIndex', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { subject, bodyText } = z
      .object({ subject: z.string().min(1).max(300), bodyText: z.string().min(1).max(20000) })
      .parse(req.body);
    const stepIndex = Number(req.params.stepIndex);

    const result = await campaignService.editStepDraft(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      stepIndex,
      subject,
      bodyText
    );
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/:id/recipients/:recipientId
router.get('/:id/recipients/:recipientId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await campaignService.getEnrichedRecipient(
      req.organizationId,
      req.params.id,
      req.params.recipientId
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/generate
router.post('/:id/recipients/:recipientId/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { senderName } = z.object({ senderName: z.string().max(120).optional() }).parse(req.body || {});
    const data = await campaignService.generateRecipientDrafts(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      senderName
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/steps/:stepIndex/restore-original
router.post('/:id/recipients/:recipientId/steps/:stepIndex/restore-original', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stepIndex = Number(req.params.stepIndex);
    const data = await campaignService.restoreOriginalStepDraft(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      stepIndex
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/steps/:stepIndex/regenerate
router.post('/:id/recipients/:recipientId/steps/:stepIndex/regenerate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stepIndex = Number(req.params.stepIndex);
    const { mode } = z.object({ mode: z.enum(['personalized', 'ai']).optional() }).parse(req.body || {});
    const data = await campaignService.regenerateStepDraft(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      stepIndex,
      mode
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/steps/:stepIndex/repair
router.post('/:id/recipients/:recipientId/steps/:stepIndex/repair', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stepIndex = Number(req.params.stepIndex);
    const data = await campaignService.repairStepDraft(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      stepIndex
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/steps/:stepIndex/approve
router.post('/:id/recipients/:recipientId/steps/:stepIndex/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stepIndex = Number(req.params.stepIndex);
    const data = await campaignService.approveRecipientStepDraft(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      stepIndex
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/steps/:stepIndex/send
router.post('/:id/recipients/:recipientId/steps/:stepIndex/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stepIndex = Number(req.params.stepIndex);
    const data = await campaignService.sendRecipientStepDraft(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      stepIndex,
      req.userId
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/steps/:stepIndex/test
router.post('/:id/recipients/:recipientId/steps/:stepIndex/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { targetEmail } = z.object({ targetEmail: z.string().email() }).parse(req.body);
    const stepIndex = Number(req.params.stepIndex);
    const data = await campaignService.sendTestEmail(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      stepIndex,
      targetEmail,
      req.userId
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/cancel-followups
router.post('/:id/recipients/:recipientId/cancel-followups', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await campaignService.cancelRecipientFollowups(
      req.organizationId,
      req.params.id,
      req.params.recipientId
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/campaigns/:id/schedule-settings
router.patch('/:id/schedule-settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      stepDelays: z
        .array(z.object({ stepIndex: z.number().int().min(0), delayDays: z.number().int().min(0).max(90) }))
        .optional(),
      schedule: z
        .object({
          startAt: z.string().optional(),
          timezone: z.string().optional(),
          batchSize: z.number().int().min(1).max(200).optional(),
          paceMinutes: z.number().int().min(0).max(1440).optional(),
          windowStartHour: z.number().int().min(0).max(23).optional(),
          windowEndHour: z.number().int().min(0).max(23).optional(),
          allowedWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
          minIntervalSeconds: z.number().int().min(0).max(86400).optional(),
          jitterSeconds: z.number().int().min(0).max(3600).optional(),
          maxPerHour: z.number().int().min(0).max(2000).optional(),
          dailySendCap: z.number().int().min(0).max(2000).optional(),
        })
        .optional(),
    });
    const validated = schema.parse(req.body);
    const data = await campaignService.updateScheduleSettings(
      req.organizationId,
      req.params.id,
      validated
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/associate-reply
// Manually links an inbox thread to a campaign recipient when auto-matching
// could not confidently associate it.
router.post('/:id/recipients/:recipientId/associate-reply', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { threadId } = z.object({ threadId: z.string().min(1).max(200) }).parse(req.body);
    const result = await replyAssociationService.associateManually(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      threadId
    );
    if (!result.associated) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/recipients/:recipientId/retry
router.post('/:id/recipients/:recipientId/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const recipient = await campaignService.retryRecipient(
      req.organizationId,
      req.params.id,
      req.params.recipientId
    );
    res.status(200).json({ success: true, data: recipient });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/campaigns/:id/recipients/:recipientId
router.patch('/:id/recipients/:recipientId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      email: z.string().email().optional(),
      name: z.string().optional(),
      companyName: z.string().optional(),
    });
    const validated = schema.parse(req.body);
    const recipient = await campaignService.updateRecipient(
      req.organizationId,
      req.params.id,
      req.params.recipientId,
      validated
    );
    res.status(200).json({ success: true, data: recipient });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/send  (batched through the pre-flight pipeline)
router.post('/:id/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const { mailboxId, batchSize } = z
      .object({ mailboxId: z.string().optional(), batchSize: z.number().int().positive().max(200).optional() })
      .parse(req.body || {});

    const result = await campaignService.sendBatch(
      req.organizationId,
      req.params.id,
      (mailboxId || campaign.mailboxId).toLowerCase(),
      batchSize,
      req.userId
    );
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/pause
router.post('/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $set: { status: 'paused' } },
      { new: true }
    );
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');
    res.status(200).json({ success: true, data: { status: campaign.status } });
  } catch (err) {
    next(err);
  }
});

const scheduleSchema = z.object({
  startAt: z.string().min(1, 'A start date/time is required'),
  timezone: z.string().max(64).optional(),
  batchSize: z.number().int().min(1).max(200).optional(),
  paceMinutes: z.number().int().min(0).max(1440).optional(),
  windowStartHour: z.number().int().min(0).max(23).optional(),
  windowEndHour: z.number().int().min(0).max(23).optional(),
  allowedWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  minIntervalSeconds: z.number().int().min(0).max(86400).optional(),
  jitterSeconds: z.number().int().min(0).max(3600).optional(),
  maxPerHour: z.number().int().min(0).max(2000).optional(),
  dailySendCap: z.number().int().min(0).max(2000).optional(),
  label: z.string().max(120).optional(),
});

// POST /api/v1/campaigns/:id/schedule  (durable, restart-safe)
router.post('/:id/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = scheduleSchema.parse(req.body);
    const result = await campaignSchedulerService.schedule(req.organizationId, req.params.id, req.userId, body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/resume
router.post('/:id/resume', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await campaignSchedulerService.resume(req.organizationId, req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/cancel
router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await campaignSchedulerService.cancel(req.organizationId, req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// --- Multi-account sender roster -------------------------------------------

// GET /api/v1/campaigns/:id/sender-accounts
// The campaign's roster plus the live per-account queue state.
router.get('/:id/sender-accounts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const accounts = await senderQueueService.describe(req.organizationId, req.params.id);
    res.status(200).json({
      success: true,
      data: {
        roster: campaign.senderAccounts || [],
        accounts,
        legacyMailboxId: campaign.mailboxId,
      },
    });
  } catch (err) {
    next(err);
  }
});

const senderAccountEntrySchema = z.object({
  accountId: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  dailySendCap: z.number().int().min(0).max(2000).optional(),
  maxPerHour: z.number().int().min(0).max(2000).optional(),
  minIntervalSeconds: z.number().int().min(0).max(86400).optional(),
  jitterSeconds: z.number().int().min(0).max(3600).optional(),
});

// PUT /api/v1/campaigns/:id/sender-accounts
// Replaces the campaign's sender roster. Only authorized accounts of the
// organization can be selected.
router.put('/:id/sender-accounts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({ accounts: z.array(senderAccountEntrySchema).min(1, 'Select at least one sender account') })
      .parse(req.body);

    const campaign = await Campaign.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const roster = await senderAccountService.buildRoster(
      req.organizationId,
      body.accounts,
      campaign.senderAccounts || []
    );

    campaign.senderAccounts = roster as any;
    // The legacy single mailbox stays in sync with the first roster entry so
    // older clients keep working.
    if (roster.length > 0) campaign.mailboxId = roster[0].emailAddress;
    await campaign.save();

    res.status(200).json({ success: true, data: { roster: campaign.senderAccounts } });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/sender-accounts/allocate
// Distributes the campaign's recipients over the roster (balanced, stable).
router.post('/:id/sender-accounts/allocate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ redistribute: z.boolean().optional().default(false) }).parse(req.body || {});
    const result = await senderAllocationService.allocate(req.organizationId, req.params.id, req.userId, {
      redistribute: body.redistribute,
    });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/sender-accounts/rebalance
// Moves unsent recipients between accounts (owner/admin only).
router.post('/:id/sender-accounts/rebalance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        fromAccountId: z.string().optional(),
        toAccountId: z.string().optional(),
        balance: z.boolean().optional().default(false),
      })
      .parse(req.body || {});
    const result = await senderAllocationService.rebalance(
      req.organizationId,
      req.params.id,
      req.userId,
      req.userRole,
      body
    );
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/campaigns/:id/sender-accounts/:accountId/toggle
// Enables or disables a single sender account of the campaign.
router.post('/:id/sender-accounts/:accountId/toggle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ enabled: z.boolean() }).parse(req.body || {});
    const campaign = await Campaign.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const entry = (campaign.senderAccounts || []).find((e: any) => e.accountId === req.params.accountId);
    if (!entry) throw new AppError('Sender account not part of this campaign', 404, 'SENDER_ACCOUNT_NOT_IN_CAMPAIGN');

    entry.enabled = body.enabled;
    await campaign.save();

    res.status(200).json({ success: true, data: { roster: campaign.senderAccounts } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/campaigns/:id  (cascades recipients, drafts, attempts)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    // Cancel active or scheduled jobs so background workers immediately abort
    if (['scheduled', 'paused', 'sending', 'ready_for_review'].includes(campaign.status)) {
      try {
        await campaignSchedulerService.cancel(req.organizationId, req.params.id);
      } catch {
        // Continue with deletion even if already stopped
      }
    }

    const recipients = await CampaignRecipient.find({
      organizationId: req.organizationId,
      campaignId: campaign._id,
    }).select('stepDrafts');

    const draftIds = recipients.flatMap((r: any) => (r.stepDrafts || []).map((d: any) => d.draftId)).filter(Boolean);

    await Promise.all([
      draftIds.length ? EmailDraft.deleteMany({ _id: { $in: draftIds }, organizationId: req.organizationId }) : Promise.resolve(),
      draftIds.length ? EmailSendAttempt.deleteMany({ draftId: { $in: draftIds }, organizationId: req.organizationId }) : Promise.resolve(),
      CampaignRecipient.deleteMany({ organizationId: req.organizationId, campaignId: campaign._id }),
    ]);
    await Campaign.deleteOne({ _id: campaign._id, organizationId: req.organizationId });

    res.status(200).json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/campaigns/:id/export (Downloadable campaign CSV report)
router.get('/:id/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const recipients = await CampaignRecipient.find({
      organizationId: req.organizationId,
      campaignId: campaign._id,
    })
      .sort({ rowNumber: 1 })
      .lean();

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = [
      'Row Number',
      'Company Name',
      'Contact Name',
      'Email',
      'Status',
      'Completed Steps',
      'Last Sent At',
      'Replied',
      'Replied At',
      'Reply Subject',
      'Reply Snippet',
      'Skip Reason',
      'Last Error',
    ];

    const stepCount = campaign.steps?.length || 1;
    for (let i = 0; i < stepCount; i++) {
      headers.push(`Step ${i + 1} Status`);
      headers.push(`Step ${i + 1} Sent At`);
      headers.push(`Step ${i + 1} Message ID`);
      headers.push(`Step ${i + 1} Error`);
    }

    const rows: string[] = [headers.join(',')];

    for (const r of recipients) {
      const line = [
        escapeCsv(r.rowNumber),
        escapeCsv(r.companyName || ''),
        escapeCsv(r.name || ''),
        escapeCsv(r.email),
        escapeCsv(r.status),
        escapeCsv(r.completedSteps),
        escapeCsv(r.lastSentAt ? new Date(r.lastSentAt).toISOString() : ''),
        escapeCsv(r.replied ? 'Yes' : 'No'),
        escapeCsv(r.repliedAt ? new Date(r.repliedAt).toISOString() : ''),
        escapeCsv(r.replySubject || ''),
        escapeCsv(r.replySnippet || ''),
        escapeCsv(r.skipReason || ''),
        escapeCsv(r.lastError || ''),
      ];

      for (let i = 0; i < stepCount; i++) {
        const slot = r.stepDrafts?.find((s: any) => s.stepIndex === i);
        line.push(escapeCsv(slot?.status || 'pending'));
        line.push(escapeCsv(slot?.sentAt ? new Date(slot.sentAt).toISOString() : ''));
        line.push(escapeCsv(slot?.providerMessageId || ''));
        line.push(escapeCsv(slot?.error || ''));
      }

      rows.push(line.join(','));
    }

    const csvOutput = '\uFEFF' + rows.join('\r\n');
    const safeName = campaign.name.replace(/[^a-zA-Z0-9_-]/g, '_');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_report.csv"`);
    res.status(200).send(csvOutput);
  } catch (err) {
    next(err);
  }
});

export default router;

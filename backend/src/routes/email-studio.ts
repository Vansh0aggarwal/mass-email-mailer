import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { emailDesignDocumentSchema, EMAIL_TONES } from '../email-design/types.js';
import {
  emailStudioService,
  studioDraftSchema,
  studioPersonalizeSchema,
} from '../services/email-studio.service.js';
import { strictAiRateLimiter } from '../middleware/rateLimiter.js';
import { requireAuth } from '../middleware/session.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

const variablesSchema = z
  .object({
    companyName: z.string().trim().max(160).optional(),
    recipientName: z.string().trim().max(120).optional(),
    senderName: z.string().trim().max(120).optional(),
    senderTitle: z.string().trim().max(120).optional(),
    service: z.string().trim().max(160).optional(),
  })
  .optional();

// GET /api/v1/email-studio/config — brand, presets and guarantees (no secrets)
router.get('/config', (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: emailStudioService.getConfig() });
});

// GET /api/v1/email-studio/templates — built-in presets + saved templates
router.get('/templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await emailStudioService.listTemplates(req.organizationId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/email-studio/templates
router.post('/templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = z
      .object({
        name: z.string().trim().min(1, 'A template name is required').max(120),
        description: z.string().trim().max(400).optional(),
        tone: z.enum(EMAIL_TONES).optional(),
        subject: z.string().trim().min(1).max(220),
        design: emailDesignDocumentSchema,
      })
      .parse(req.body);

    const template = await emailStudioService.saveTemplate(req.organizationId, req.userId, input);
    res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/email-studio/templates/:id
router.delete('/templates/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await emailStudioService.deleteTemplate(req.organizationId, req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/email-studio/preview — renders the exact HTML that will be sent
router.post('/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = z
      .object({
        design: emailDesignDocumentSchema,
        variables: variablesSchema,
        subject: z.string().trim().max(220).optional(),
      })
      .parse(req.body);

    const data = emailStudioService.preview(input);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/email-studio/personalize — grounded AI copy (no invented metrics)
router.post('/personalize', strictAiRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = studioPersonalizeSchema.parse(req.body);
    const data = await emailStudioService.personalize(input);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/email-studio/drafts — studio history with the latest send attempt
router.get('/drafts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const data = await emailStudioService.listDrafts(req.organizationId, limit);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/email-studio/drafts/:id — reload a studio draft into the editor
router.get('/drafts/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const draft = await EmailDraft.findOne({
      _id: req.params.id,
      organizationId: req.organizationId,
      surface: 'studio',
    }).lean();
    if (!draft) throw new AppError('Studio draft not found', 404, 'DRAFT_NOT_FOUND');
    res.status(200).json({ success: true, data: emailStudioService.serializeDraft(draft) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/email-studio/drafts — persist an editable, unapproved draft
router.post('/drafts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = studioDraftSchema.parse(req.body);
    const draft = await emailStudioService.createDraft(req.organizationId, req.userId, input);
    res.status(201).json({ success: true, data: draft });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/email-studio/drafts/:id — edit (invalidates any prior approval)
router.put('/drafts/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = studioDraftSchema.parse(req.body);
    const draft = await emailStudioService.updateDraft(req.organizationId, req.params.id, input);
    res.status(200).json({ success: true, data: draft });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/email-studio/drafts/:id/approve — human approval gate
router.post('/drafts/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const draft = await emailStudioService.approveDraft(req.organizationId, req.params.id);
    res.status(200).json({ success: true, data: draft });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/email-studio/send — dispatch an approved draft through the pipeline
router.post('/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = z
      .object({
        draftId: z.string().min(1),
        mailboxEmail: z.string().email('Select a valid mailbox'),
        idempotencyKey: z.string().trim().min(8).max(120).optional(),
      })
      .parse(req.body);

    const data = await emailStudioService.sendDraft({
      organizationId: req.organizationId,
      actorId: req.userId,
      ...input,
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;

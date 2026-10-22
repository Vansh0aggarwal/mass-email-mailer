import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { EmailDraft } from '../models/EmailDraft.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { aiGroundingService } from '../providers/ai/ai-grounding.service.js';
import { replyAssistantService } from '../services/reply-assistant.service.js';
import { buildAuditContextLines } from '../services/website-audit.service.js';
import { strictAiRateLimiter } from '../middleware/rateLimiter.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

/** Normalizes a Mongoose Map / plain object of company custom fields to a string record. */
function normalizeCustomFields(value: any): Record<string, string> {
  if (!value) return {};
  const entries: [string, any][] =
    typeof value.entries === 'function' ? Array.from(value.entries()) : Object.entries(value);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (v !== null && v !== undefined && String(v).trim().length > 0) out[String(k)] = String(v);
  }
  return out;
}

const replyAssistSchema = z.object({
  mailboxEmail: z.string().email('Valid mailbox email required'),
  threadId: z.string().min(1, 'Thread id is required'),
  recipientEmail: z.string().email().optional(),
  recipientName: z.string().optional(),
  companyId: z.string().optional(),
  targetService: z.string().optional(),
  tone: z.enum(['professional', 'friendly', 'concise', 'consultative', 'urgent']).default('professional'),
  action: z
    .enum(['generate', 'shorter', 'detailed', 'change_tone', 'answer_question', 'next_step', 'clarify'])
    .default('generate'),
  instruction: z.string().max(600).optional(),
  senderName: z.string().optional(),
});

// POST /api/v1/drafts/reply-assistant  (AI-assisted, editable reply draft)
router.post('/reply-assistant', strictAiRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = replyAssistSchema.parse(req.body);
    const result = await replyAssistantService.generateReplyDraft({
      organizationId: req.organizationId,
      ...validated,
    });

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

const generateDraftSchema = z.object({
  campaignId: z.string().optional(),
  recipientId: z.string().optional(),
  companyId: z.string().optional(),
  companyName: z.string().min(1, 'Company name is required'),
  contactId: z.string().optional(),
  recipientEmail: z.string().email('Valid recipient email required'),
  recipientName: z.string().optional(),
  recipientRole: z.string().optional(),
  targetService: z.string().min(1, 'Target service is required'),
  serviceValueProposition: z.string().optional(),
  tone: z.enum(['professional', 'friendly', 'concise', 'consultative', 'urgent']).default('consultative'),
  objective: z.string().optional(),
  senderName: z.string().optional(),
});

// POST /api/v1/drafts/generate
router.post('/generate', strictAiRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = generateDraftSchema.parse(req.body);
    const orgId = req.organizationId;

    let companyDoc: any = null;
    if (validated.companyId) {
      companyDoc = await Company.findOne({ _id: validated.companyId, organizationId: orgId }).lean();
    }

    // Surface imported CSV columns (website audit, sector, state/ROC, proposed
    // deliverable, campaign steps, etc.) to the AI as grounded context.
    const customFieldContext = normalizeCustomFields(companyDoc?.customFields);
    const auditContext = buildAuditContextLines({
      statusRaw: customFieldContext.website_status,
      auditTypeRaw: customFieldContext.site_audit_type,
      httpCodeRaw: customFieldContext.http_code,
    });
    const mergedCustom: Record<string, string> = { ...customFieldContext };
    auditContext.forEach((line, i) => {
      mergedCustom[`audit_note_${i + 1}`] = line;
    });

    const aiResult = await aiGroundingService.generateEmailDraft({
      companyName: companyDoc?.name || validated.companyName,
      recipientEmail: validated.recipientEmail,
      recipientName: validated.recipientName,
      recipientRole: validated.recipientRole,
      domain: companyDoc?.domain,
      industry: companyDoc?.industry,
      overallRating: companyDoc?.overallRating,
      explicitNeeds: companyDoc?.services,
      notes: companyDoc?.notes,
      targetService: validated.targetService,
      serviceValueProposition: validated.serviceValueProposition,
      tone: validated.tone,
      objective: validated.objective,
      senderName: validated.senderName,
      customFieldContext: Object.keys(mergedCustom).length ? mergedCustom : undefined,
    });

    const draft = await EmailDraft.create({
      organizationId: orgId,
      campaignId: validated.campaignId ? (validated.campaignId as any) : undefined,
      recipientId: validated.recipientId ? (validated.recipientId as any) : undefined,
      companyId: companyDoc?._id || undefined,
      companyName: companyDoc?.name || validated.companyName,
      contactId: validated.contactId || undefined,
      recipientEmail: validated.recipientEmail,
      recipientName: validated.recipientName,
      subject: aiResult.output.subject,
      bodyText: aiResult.output.bodyText,
      tone: validated.tone,
      status: 'draft',
      recommendedServiceName: aiResult.output.recommendedService,
      recommendationExplanation: aiResult.output.explanation,
      factsUsed: aiResult.output.factsUsed,
      missingInformation: aiResult.output.missingInformation,
      warnings: aiResult.output.warnings,
      estimatedCostUsd: aiResult.costUsd,
      isFallbackTemplate: aiResult.isFallback,
    });

    res.status(201).json({
      success: true,
      data: draft,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/drafts
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, companyId } = req.query;
    const query: any = { organizationId: req.organizationId };

    if (status) {
      query.status = status;
    }
    if (companyId) {
      query.companyId = companyId;
    }

    const drafts = await EmailDraft.find(query).sort({ createdAt: -1 }).limit(100).lean();

    res.status(200).json({
      success: true,
      data: drafts,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/drafts/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const draft = await EmailDraft.findOne({
      _id: req.params.id,
      organizationId: req.organizationId,
    }).lean();

    if (!draft) {
      throw new AppError('Draft not found', 404, 'NOT_FOUND');
    }

    res.status(200).json({
      success: true,
      data: draft,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/drafts/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updateSchema = z.object({
      subject: z.string().min(1).optional(),
      bodyText: z.string().min(1).optional(),
    });

    const validated = updateSchema.parse(req.body);

    const draft = await EmailDraft.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $set: validated },
      { new: true }
    );

    if (!draft) {
      throw new AppError('Draft not found', 404, 'NOT_FOUND');
    }

    res.status(200).json({
      success: true,
      data: draft,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/drafts/:id/approve
router.post('/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const draft = await EmailDraft.findOne({
      _id: req.params.id,
      organizationId: req.organizationId,
    });

    if (!draft) {
      throw new AppError('Draft not found', 404, 'NOT_FOUND');
    }

    draft.status = 'approved';
    await draft.save();

    // Synchronize approval with CampaignRecipient lifecycle
    const recipient = await CampaignRecipient.findOne({
      organizationId: req.organizationId,
      $or: [
        { 'stepDrafts.draftId': draft._id },
        ...(draft.recipientId ? [{ _id: draft.recipientId }] : []),
      ],
    });

    if (recipient) {
      for (const slot of recipient.stepDrafts) {
        if (slot.draftId && String(slot.draftId) === String(draft._id)) {
          slot.status = 'approved';
        }
      }
      const hasApprovedDraft = recipient.stepDrafts.some((s) => s.status === 'approved');
      if (hasApprovedDraft && ['pending', 'prepared'].includes(recipient.status)) {
        recipient.status = 'approved';
      }
      await recipient.save();
    }

    res.status(200).json({
      success: true,
      data: {
        id: draft._id,
        status: draft.status,
        message: 'Draft approved successfully and ready for dispatch',
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;

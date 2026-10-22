import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { WorkspaceSettings } from '../models/WorkspaceSettings.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/session.js';

const router = Router();
router.use(requireAuth);

const updateSenderSettingsSchema = z.object({
  senderDisplayName: z.string().min(1).max(120).optional(),
  businessName: z.string().min(1).max(120).optional(),
  businessDescription: z.string().max(500).optional(),
  authorizedMailbox: z.string().email().optional().or(z.literal('')),
  defaultGreeting: z.string().min(1).max(120).optional(),
  missingNameFallback: z.string().min(1).max(120).optional(),
  defaultSignOff: z.string().min(1).max(120).optional(),
  emailSignature: z.string().max(2000).optional(),
  contactDetails: z.string().max(200).optional(),
  defaultTimezone: z.string().min(1).max(64).optional(),
  sendingWindowStartHour: z.number().int().min(0).max(23).optional(),
  sendingWindowEndHour: z.number().int().min(0).max(23).optional(),
  dailySendCap: z.number().int().min(1).max(2000).optional(),
  batchSize: z.number().int().min(1).max(200).optional(),
  paceMinutes: z.number().int().min(0).max(1440).optional(),
  defaultFollowUpIntervalDays: z.number().int().min(1).max(90).optional(),
  preferredTone: z.enum(['professional', 'friendly', 'concise', 'consultative', 'urgent']).optional(),
  preferredLength: z.enum(['short', 'medium', 'detailed']).optional(),
  preferredLanguage: z.string().max(10).optional(),
  defaultServiceOffering: z.string().max(200).optional(),
});

// GET /api/v1/settings/sender
router.get('/sender', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    let settings = await WorkspaceSettings.findOne({ organizationId: orgId });

    if (!settings) {
      settings = await WorkspaceSettings.create({
        organizationId: orgId,
      });
    }

    res.status(200).json({
      success: true,
      data: settings,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/settings/sender
router.put('/sender', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const data = updateSenderSettingsSchema.parse(req.body);

    if (data.authorizedMailbox) {
      const email = data.authorizedMailbox.toLowerCase().trim();
      const account = await EmailAccount.findOne({
        organizationId: orgId,
        emailAddress: email,
      });
      if (!account) {
        throw new AppError(
          `Mailbox '${email}' is not an authorized connection for this workspace. Please connect it first via Integrations.`,
          400,
          'UNAUTHORIZED_MAILBOX'
        );
      }
    }

    const updated = await WorkspaceSettings.findOneAndUpdate(
      { organizationId: orgId },
      { $set: data },
      { new: true, upsert: true }
    );

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

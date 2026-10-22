import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { deliverabilityService } from '../services/deliverability.service.js';
import { Suppression } from '../models/Suppression.js';
import { requireAuth } from '../middleware/session.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/v1/deliverability/overview
router.get('/overview', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const overview = await deliverabilityService.getOverview(req.organizationId);
    res.status(200).json({
      success: true,
      data: overview,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/deliverability/suppressions
router.get('/suppressions', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, reason, page = '1', limit = '50' } = req.query;
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const query: any = { organizationId: req.organizationId };
    if (reason && reason !== 'all') {
      query.reason = String(reason);
    }
    if (q && String(q).trim()) {
      query.email = { $regex: String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const [suppressions, total] = await Promise.all([
      Suppression.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Suppression.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: suppressions,
      meta: {
        page: pageNum,
        limit: limitNum,
        total,
        hasMore: skip + suppressions.length < total,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/deliverability/suppressions
router.post('/suppressions', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, reason } = z
      .object({
        email: z.string().email('Invalid email address'),
        reason: z.enum(['unsubscribed', 'bounced', 'manual_block', 'competitor']).default('manual_block'),
      })
      .parse(req.body);

    const doc = await Suppression.findOneAndUpdate(
      { organizationId: req.organizationId, email: email.toLowerCase().trim() },
      { $set: { reason } },
      { upsert: true, new: true }
    );

    res.status(201).json({
      success: true,
      data: doc,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/deliverability/suppressions/:email
router.delete('/suppressions/:email', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase().trim();
    const result = await Suppression.deleteOne({
      organizationId: req.organizationId,
      email,
    });

    if (result.deletedCount === 0) {
      throw new AppError('Suppression entry not found', 404, 'NOT_FOUND');
    }

    res.status(200).json({
      success: true,
      data: { email, removed: true },
    });
  } catch (err) {
    next(err);
  }
});

export default router;

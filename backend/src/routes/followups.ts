import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { FollowUpTask } from '../models/FollowUpTask.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/v1/follow-ups
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query;
    const query: any = { organizationId: req.organizationId };

    if (status) {
      query.status = status;
    }

    const tasks = await FollowUpTask.find(query).sort({ dueDate: 1 }).limit(100).lean();

    res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/follow-ups
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const createTaskSchema = z.object({
      companyId: z.string().optional(),
      companyName: z.string().optional(),
      contactEmail: z.string().email(),
      threadId: z.string().optional(),
      dueDate: z.string().or(z.date()),
      notes: z.string().default(''),
      priority: z.enum(['low', 'medium', 'high']).default('medium'),
    });

    const validated = createTaskSchema.parse(req.body);

    const task = await FollowUpTask.create({
      ...validated,
      dueDate: new Date(validated.dueDate),
      organizationId: req.organizationId,
      status: 'pending',
    });

    res.status(201).json({
      success: true,
      data: task,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/follow-ups/:id
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updateSchema = z.object({
      status: z.enum(['pending', 'completed', 'cancelled']).optional(),
      dueDate: z.string().or(z.date()).optional(),
      notes: z.string().optional(),
    });

    const validated = updateSchema.parse(req.body);
    const updateData: any = { ...validated };
    if (validated.dueDate) {
      updateData.dueDate = new Date(validated.dueDate);
    }

    const task = await FollowUpTask.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      { $set: updateData },
      { new: true }
    );

    if (!task) {
      throw new AppError('Follow-up task not found', 404, 'NOT_FOUND');
    }

    res.status(200).json({
      success: true,
      data: task,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

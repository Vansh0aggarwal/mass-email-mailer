import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { StickyNote, NOTE_COLORS } from '../models/StickyNote.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/session.js';

const router = Router();

router.use(requireAuth);

const noteSchema = z.object({
  title: z.string().trim().max(120).optional(),
  content: z.string().max(8000).optional(),
  color: z.enum(NOTE_COLORS).optional(),
  position: z.number().finite().optional(),
});

const reorderSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
});

function assertValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError('Note not found', 404, 'NOT_FOUND');
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/v1/notes — the caller's sticky notes, newest position first.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query: Record<string, unknown> = {
      organizationId: req.organizationId,
      userId: req.userId,
    };
    const q = String(req.query.q || '').trim();
    if (q) {
      const pattern = new RegExp(escapeRegex(q), 'i');
      query.$or = [{ title: pattern }, { content: pattern }];
    }

    const notes = await StickyNote.find(query)
      .sort({ position: 1, createdAt: -1 })
      .limit(300)
      .lean();

    res.status(200).json({ success: true, data: notes });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/notes
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = noteSchema.parse(req.body);
    const position =
      body.position ??
      (await StickyNote.countDocuments({
        organizationId: req.organizationId,
        userId: req.userId,
      }));

    const note = await StickyNote.create({
      organizationId: req.organizationId,
      userId: req.userId,
      title: body.title || '',
      content: body.content || '',
      color: body.color || 'yellow',
      position,
    });

    res.status(201).json({ success: true, data: note.toObject() });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/notes/reorder — persists the board order after a drag.
router.patch('/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = reorderSchema.parse(req.body);
    const validIds = ids.filter((id) => mongoose.isValidObjectId(id));
    if (validIds.length === 0) {
      throw new AppError('No valid note ids supplied', 400, 'EMPTY_ORDER');
    }

    const owned = await StickyNote.find({
      _id: { $in: validIds },
      organizationId: req.organizationId,
      userId: req.userId,
    })
      .select('_id')
      .lean();
    const ownedIds = new Set(owned.map((note) => String(note._id)));

    const operations = validIds
      .filter((id) => ownedIds.has(id))
      .map((id, index) => ({
        updateOne: {
          filter: { _id: id, organizationId: req.organizationId, userId: req.userId },
          update: { $set: { position: index } },
        },
      }));

    if (operations.length > 0) {
      await StickyNote.bulkWrite(operations as any, { ordered: false });
    }

    res.status(200).json({ success: true, data: { reordered: operations.length } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/notes/:id
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertValidId(req.params.id);
    const body = noteSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      throw new AppError('No note changes supplied', 400, 'EMPTY_UPDATE');
    }

    const note = await StickyNote.findOne({
      _id: req.params.id,
      organizationId: req.organizationId,
      userId: req.userId,
    });
    if (!note) throw new AppError('Note not found', 404, 'NOT_FOUND');

    if (body.title !== undefined) note.title = body.title;
    if (body.content !== undefined) note.content = body.content;
    if (body.color !== undefined) note.color = body.color;
    if (body.position !== undefined) note.position = body.position;
    await note.save();

    res.status(200).json({ success: true, data: note.toObject() });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/notes/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertValidId(req.params.id);
    const note = await StickyNote.findOneAndDelete({
      _id: req.params.id,
      organizationId: req.organizationId,
      userId: req.userId,
    });
    if (!note) throw new AppError('Note not found', 404, 'NOT_FOUND');

    res.status(200).json({ success: true, data: { id: note._id, deleted: true } });
  } catch (err) {
    next(err);
  }
});

export default router;

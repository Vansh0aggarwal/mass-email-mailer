import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  Project,
  PROJECT_COLORS,
  PROJECT_ICONS,
} from '../models/Project.js';
import { TodoItem } from '../models/TodoItem.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/session.js';

const router = Router();

router.use(requireAuth);

const projectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(80),
  description: z.string().trim().max(1000).nullable().optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  icon: z.enum(PROJECT_ICONS).optional(),
  archived: z.boolean().optional(),
  position: z.number().finite().optional(),
});

const updateProjectSchema = projectSchema.partial();

function assertValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError('Project not found', 404, 'NOT_FOUND');
  }
}

type ProjectProgress = { taskCount: number; completedCount: number; openCount: number };

async function loadProgress(
  organizationId: string,
  userId: string,
  projectIds: mongoose.Types.ObjectId[]
): Promise<Map<string, ProjectProgress>> {
  const progress = new Map<string, ProjectProgress>();
  if (projectIds.length === 0) return progress;

  const rows = await TodoItem.aggregate<{
    _id: { projectId: string; status: string };
    count: number;
  }>([
    {
      $match: {
        organizationId,
        projectId: { $in: projectIds.map((id) => String(id)) },
        $or: [{ assignedTo: userId }, { createdBy: userId }],
      },
    },
    { $group: { _id: { projectId: '$projectId', status: '$status' }, count: { $sum: 1 } } },
  ]);

  for (const row of rows) {
    const projectId = String(row._id.projectId);
    const entry = progress.get(projectId) || { taskCount: 0, completedCount: 0, openCount: 0 };
    entry.taskCount += row.count;
    if (row._id.status === 'completed') entry.completedCount += row.count;
    else entry.openCount += row.count;
    progress.set(projectId, entry);
  }
  return progress;
}

function withProgress(project: any, progress: Map<string, ProjectProgress>) {
  const stats = progress.get(String(project._id)) || {
    taskCount: 0,
    completedCount: 0,
    openCount: 0,
  };
  return {
    ...project,
    ...stats,
    progress:
      stats.taskCount === 0 ? 0 : Math.round((stats.completedCount / stats.taskCount) * 100),
  };
}

// GET /api/v1/projects — the caller's projects with live task progress.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const includeArchived =
      req.query.includeArchived === '1' || req.query.includeArchived === 'true';
    const query: Record<string, unknown> = {
      organizationId: req.organizationId,
      userId: req.userId,
    };
    if (!includeArchived) query.archived = false;

    const projects = await Project.find(query)
      .sort({ archived: 1, position: 1, createdAt: -1 })
      .lean();
    const progress = await loadProgress(
      req.organizationId,
      req.userId,
      projects.map((project) => project._id)
    );

    res.status(200).json({
      success: true,
      data: projects.map((project) => withProgress(project, progress)),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/projects
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = projectSchema.parse(req.body);
    const position =
      body.position ??
      (await Project.countDocuments({ organizationId: req.organizationId, userId: req.userId }));

    const project = await Project.create({
      organizationId: req.organizationId,
      userId: req.userId,
      name: body.name,
      description: body.description || undefined,
      color: body.color || 'slate',
      icon: body.icon || 'folder',
      archived: body.archived === true,
      position,
    });

    res.status(201).json({
      success: true,
      data: withProgress(project.toObject(), new Map()),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/projects/:id
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertValidId(req.params.id);
    const body = updateProjectSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      throw new AppError('No project changes supplied', 400, 'EMPTY_UPDATE');
    }

    const project = await Project.findOne({
      _id: req.params.id,
      organizationId: req.organizationId,
      userId: req.userId,
    });
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');

    if (body.name !== undefined) project.name = body.name;
    if (body.description !== undefined) project.description = body.description || undefined;
    if (body.color !== undefined) project.color = body.color;
    if (body.icon !== undefined) project.icon = body.icon;
    if (body.archived !== undefined) project.archived = body.archived;
    if (body.position !== undefined) project.position = body.position;
    await project.save();

    const progress = await loadProgress(req.organizationId, req.userId, [project._id]);
    res.status(200).json({
      success: true,
      data: withProgress(project.toObject(), progress),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/projects/:id — removes the project and detaches its tasks.
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertValidId(req.params.id);
    const project = await Project.findOneAndDelete({
      _id: req.params.id,
      organizationId: req.organizationId,
      userId: req.userId,
    });
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');

    await TodoItem.updateMany(
      {
        organizationId: req.organizationId,
        projectId: String(project._id),
        $or: [{ assignedTo: req.userId }, { createdBy: req.userId }],
      },
      { $unset: { projectId: '' } }
    );

    res.status(200).json({ success: true, data: { id: project._id, deleted: true } });
  } catch (err) {
    next(err);
  }
});

export default router;

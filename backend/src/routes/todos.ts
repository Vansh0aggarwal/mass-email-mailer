import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { TodoItem } from '../models/TodoItem.js';
import { TodoList, DEFAULT_TODO_LIST_TITLE } from '../models/TodoList.js';
import { Project } from '../models/Project.js';
import { User } from '../models/User.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/session.js';
import { pushTaskToGoogle } from '../services/productivity-sync.service.js';
import {
  loadUserDisplaySummaries,
  withUserDisplay,
} from '../services/user-display.service.js';

const router = Router();

router.use(requireAuth);

const PRIORITIES = ['low', 'medium', 'high'] as const;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const subtaskSchema = z.object({
  _id: z.string().optional(),
  title: z.string().trim().min(1, 'Subtask title is required').max(160),
  completed: z.boolean().default(false),
});

const meetLinkSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => parseMeetLink(value) !== null, {
    message: 'Use a Google Meet link such as https://meet.google.com/abc-defg-hij',
  });

function parseMeetLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com') return null;
    if (!url.pathname || url.pathname === '/') return null;
    return url.toString();
  } catch {
    return null;
  }
}

const taskFields = {
  title: z.string().trim().min(1, 'Title is required').max(200),
  notes: z.string().trim().max(2000).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  dueDate: z.string().nullable().optional(),
  scheduledTime: z.string().regex(TIME_PATTERN, 'Use HH:mm').nullable().optional(),
  scheduledEndTime: z.string().regex(TIME_PATTERN, 'Use HH:mm').nullable().optional(),
  timezone: z.string().trim().max(60).optional(),
  addToCalendar: z.boolean().optional(),
  addMeetLink: z.boolean().optional(),
  googleMeetLink: meetLinkSchema.nullable().optional(),
  reminderEnabled: z.boolean().optional(),
  reminderMinutes: z.number().int().min(0).max(10080).optional(),
  category: z.string().trim().max(60).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  projectId: z.string().nullable().optional(),
  subtasks: z.array(subtaskSchema).max(100).optional(),
  position: z.number().finite().optional(),
  assignedTo: z.string().optional(),
};

const createTodoSchema = z.object(taskFields);

const updateTodoSchema = z.object({
  ...taskFields,
  title: taskFields.title.optional(),
  status: z.enum(['open', 'completed']).optional(),
});

const listSettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  timezone: z.string().trim().max(60).optional(),
});

function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const trimmed = value.trim();
  // Calendar dates are stored at 12:00 UTC so they never shift across timezones.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T12:00:00.000Z`)
    : new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new AppError('Invalid due date', 400, 'INVALID_DUE_DATE');
  }
  return date;
}

/** A time block must have a start and end after it on the same calendar day. */
function assertTimeRange(start?: string | null, end?: string | null): void {
  if (end && !start) {
    throw new AppError('Set a start time before an end time', 400, 'INVALID_TIME_RANGE');
  }
  if (start && end && end <= start) {
    throw new AppError('End time must be after the start time', 400, 'INVALID_TIME_RANGE');
  }
}

function serverDayRange(): { from: Date; to: Date } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

function dayRange(req: Request): { from: Date; to: Date } {
  const fallback = serverDayRange();
  const from = req.query.from ? new Date(String(req.query.from)) : fallback.from;
  const to = req.query.to ? new Date(String(req.query.to)) : fallback.to;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new AppError('Invalid day range', 400, 'INVALID_RANGE');
  }
  return { from, to };
}

/** Rejects assignees that are not members of the requesting organization. */
async function assertAssignable(organizationId: string, userId: string): Promise<void> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new AppError('Assignee must be a member of this workspace', 400, 'INVALID_ASSIGNEE');
  }
  const member = await User.exists({
    _id: userId,
    'organizations.organizationId': organizationId,
  });
  if (!member) {
    throw new AppError('Assignee must be a member of this workspace', 400, 'INVALID_ASSIGNEE');
  }
}

async function assertProject(organizationId: string, userId: string, projectId: string) {
  if (!mongoose.isValidObjectId(projectId)) {
    throw new AppError('Project not found', 400, 'INVALID_PROJECT');
  }
  const project = await Project.exists({ _id: projectId, organizationId, userId });
  if (!project) {
    throw new AppError('Project not found', 400, 'INVALID_PROJECT');
  }
}

async function enrichTodos(todos: any[], organizationId: string) {
  const summaries = await loadUserDisplaySummaries(
    todos.flatMap((todo) => [todo.assignedTo, todo.createdBy]),
    organizationId
  );

  const projectIds = [...new Set(todos.map((todo) => todo.projectId).filter(Boolean))];
  const projects = projectIds.length
    ? await Project.find({ _id: { $in: projectIds }, organizationId })
        .select('name color icon')
        .lean()
    : [];
  const projectMap = new Map(projects.map((project: any) => [String(project._id), project]));

  return todos.map((todo) => {
    const withUsers = withUserDisplay(
      withUserDisplay(todo, 'assignedTo', 'assignedToUser', summaries),
      'createdBy',
      'createdByUser',
      summaries
    );
    const project = todo.projectId ? projectMap.get(String(todo.projectId)) : null;
    return {
      id: String(todo._id),
      ...withUsers,
      userId: todo.assignedTo,
      isCompleted: todo.status === 'completed',
      project: project ? { _id: String(project._id), name: project.name, color: project.color, icon: project.icon } : null,
    };
  });
}

function findOwnedTodo(req: Request) {
  return {
    _id: req.params.id,
    organizationId: req.organizationId,
    ...personalScope(req),
  };
}

function personalScope(req: Request) {
  return { $or: [{ assignedTo: req.userId }, { createdBy: req.userId }] };
}

function assertValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError('To-do item not found', 404, 'NOT_FOUND');
  }
}

function sortTasks(tasks: any[], sort: string): any[] {
  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const dueValue = (task: any) => (task.dueDate ? new Date(task.dueDate).getTime() : Number.MAX_SAFE_INTEGER);
  const sorted = [...tasks];
  if (sort === 'priority') {
    sorted.sort((a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1) || dueValue(a) - dueValue(b));
  } else if (sort === 'title') {
    sorted.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  } else if (sort === 'created') {
    sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } else {
    sorted.sort((a, b) => dueValue(a) - dueValue(b) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  return sorted;
}

// GET /api/v1/todos/settings — the caller's list name and timezone.
router.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await TodoList.findOneAndUpdate(
      { organizationId: req.organizationId, userId: req.userId },
      {
        $setOnInsert: {
          organizationId: req.organizationId,
          userId: req.userId,
          title: DEFAULT_TODO_LIST_TITLE,
          timezone: 'UTC',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    res.status(200).json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/todos/settings — rename the list; an empty name restores the default.
router.patch('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = listSettingsSchema.parse(req.body);
    const title = (body.title || '').trim() || DEFAULT_TODO_LIST_TITLE;
    const settings = await TodoList.findOneAndUpdate(
      { organizationId: req.organizationId, userId: req.userId },
      {
        $set: {
          title,
          ...(body.timezone !== undefined ? { timezone: body.timezone || 'UTC' } : {}),
        },
        $setOnInsert: { organizationId: req.organizationId, userId: req.userId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    res.status(200).json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/todos/daily — today's open tasks plus tasks completed today.
router.get('/daily', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = dayRange(req);
    const base: Record<string, any> = {
      organizationId: req.organizationId,
      assignedTo: req.userId,
    };

    const [open, completed] = await Promise.all([
      TodoItem.find({ ...base, status: 'open', dueDate: { $lt: to } }).sort({ dueDate: 1 }).lean(),
      TodoItem.find({
        ...base,
        status: 'completed',
        completedAt: { $gte: from, $lt: to },
      })
        .sort({ completedAt: -1 })
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      data: await enrichTodos([...open, ...completed], req.organizationId),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/todos — the caller's shared task set with filters, search and sorting.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, q, filter, projectId, sort } = req.query;
    const query: any = {
      organizationId: req.organizationId,
      ...personalScope(req),
    };

    if (projectId && mongoose.isValidObjectId(String(projectId))) {
      query.projectId = String(projectId);
    }
    if (status === 'open' || status === 'completed') {
      query.status = status;
    }
    if (req.query.reminder === '1') {
      query.reminderEnabled = true;
      query.status = 'open';
    }
    if (q && String(q).trim()) {
      const pattern = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$and = [
        ...(query.$and || []),
        { $or: [{ title: pattern }, { notes: pattern }, { description: pattern }, { category: pattern }, { tags: pattern }] },
      ];
    }

    if (filter === 'today' || filter === 'overdue' || filter === 'upcoming') {
      const range = dayRange(req);
      if (filter === 'today') {
        // Open undated tasks belong to today's simple list; completed tasks
        // only appear on the day they were completed.
        query.$and = [
          ...(query.$and || []),
          {
            $or: [
              {
                status: 'open',
                $or: [{ dueDate: { $gte: range.from, $lt: range.to } }, { dueDate: null }],
              },
              { status: 'completed', completedAt: { $gte: range.from, $lt: range.to } },
            ],
          },
        ];
      } else if (filter === 'overdue') {
        query.status = 'open';
        query.dueDate = { $lt: range.from };
      } else {
        query.status = 'open';
        query.dueDate = { $gte: range.to };
      }
    } else if (filter === 'completed') {
      query.status = 'completed';
    }

    const todos = await TodoItem.find(query)
      .sort({ status: -1, dueDate: 1, createdAt: -1 })
      .limit(400)
      .lean();

    res.status(200).json({
      success: true,
      data: await enrichTodos(sortTasks(todos, String(sort || 'due')), req.organizationId),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/todos
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createTodoSchema.parse(req.body);
    const assignedTo = body.assignedTo?.trim() || req.userId;
    await assertAssignable(req.organizationId, assignedTo);

    const dueDate = parseDate(body.dueDate);
    assertTimeRange(body.scheduledTime, body.scheduledEndTime);
    const meetLink = parseMeetLink(body.googleMeetLink);
    let projectId: string | undefined;

    if (body.projectId) {
      await assertProject(req.organizationId, req.userId, body.projectId);
      projectId = body.projectId;
    }

    const todo = await TodoItem.create({
      organizationId: req.organizationId,
      title: body.title,
      notes: body.notes || undefined,
      description: body.description || undefined,
      priority: body.priority || 'medium',
      dueDate: dueDate || undefined,
      scheduledTime: body.scheduledTime || undefined,
      scheduledEndTime: body.scheduledEndTime || undefined,
      timezone: body.timezone || undefined,
      addToCalendar: body.addToCalendar !== false,
      addMeetLink: body.addMeetLink === true,
      googleMeetLink: meetLink || undefined,
      googleMeetSource: meetLink ? 'manual' : undefined,
      reminderEnabled: body.reminderEnabled === true,
      reminderMinutes: body.reminderMinutes ?? 10,
      category: body.category || undefined,
      tags: body.tags || [],
      projectId,
      subtasks: (body.subtasks || []).map((subtask) => ({
        title: subtask.title,
        completed: subtask.completed,
      })),
      position: body.position ?? 0,
      assignedTo,
      createdBy: req.userId,
      status: 'open',
    });

    const sync = await pushTaskToGoogle(todo).catch((err) => ({
      synced: false,
      warning: err.message as string,
    }));
    const [enriched] = await enrichTodos([todo.toObject()], req.organizationId);
    res.status(201).json({ success: true, data: { ...enriched, sync } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/todos/:id
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertValidId(req.params.id);
    const body = updateTodoSchema.parse(req.body);
    const todo = await TodoItem.findOne(findOwnedTodo(req));
    if (!todo) throw new AppError('To-do item not found', 404, 'NOT_FOUND');

    if (body.assignedTo !== undefined) {
      const assignedTo = body.assignedTo.trim();
      await assertAssignable(req.organizationId, assignedTo);
      todo.assignedTo = assignedTo;
    }
    if (body.title !== undefined) todo.title = body.title;
    if (body.notes !== undefined) todo.notes = body.notes || undefined;
    if (body.description !== undefined) todo.description = body.description || undefined;
    if (body.priority !== undefined) todo.priority = body.priority;
    if (body.dueDate !== undefined) {
      todo.dueDate = parseDate(body.dueDate) || undefined;
    }
    if (body.scheduledTime !== undefined) {
      todo.scheduledTime = body.scheduledTime || undefined;
      if (!body.scheduledTime && body.scheduledEndTime === undefined) {
        todo.scheduledEndTime = undefined;
      }
    }
    if (body.scheduledEndTime !== undefined) {
      todo.scheduledEndTime = body.scheduledEndTime || undefined;
    }
    assertTimeRange(todo.scheduledTime, todo.scheduledEndTime);
    if (body.timezone !== undefined) todo.timezone = body.timezone || undefined;
    if (body.addToCalendar !== undefined) todo.addToCalendar = body.addToCalendar;
    if (body.addMeetLink !== undefined) todo.addMeetLink = body.addMeetLink;
    if (body.googleMeetLink !== undefined) {
      const meetLink = parseMeetLink(body.googleMeetLink);
      todo.googleMeetLink = meetLink || undefined;
      todo.googleMeetSource = meetLink ? 'manual' : undefined;
    }
    if (body.reminderEnabled !== undefined) todo.reminderEnabled = body.reminderEnabled;
    if (body.reminderMinutes !== undefined) todo.reminderMinutes = body.reminderMinutes;
    if (body.category !== undefined) todo.category = body.category || undefined;
    if (body.tags !== undefined) todo.tags = body.tags;
    if (body.projectId !== undefined) {
      if (body.projectId) {
        await assertProject(req.organizationId, req.userId, body.projectId);
        todo.projectId = body.projectId;
      } else {
        todo.projectId = undefined;
      }
    }
    if (body.subtasks !== undefined) {
      todo.subtasks = body.subtasks.map((subtask) => ({
        title: subtask.title,
        completed: subtask.completed,
      })) as any;
    }
    if (body.position !== undefined) todo.position = body.position;
    if (body.status !== undefined) {
      todo.status = body.status;
      todo.completedAt = body.status === 'completed' ? new Date() : undefined;
      if (body.status === 'open') todo.reminderSentAt = undefined;
    }

    await todo.save();
    const sync = await pushTaskToGoogle(todo).catch((err) => ({
      synced: false,
      warning: err.message as string,
    }));
    const [enriched] = await enrichTodos([todo.toObject()], req.organizationId);
    res.status(200).json({ success: true, data: { ...enriched, sync } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/todos/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertValidId(req.params.id);
    const deleted = await TodoItem.findOneAndDelete(findOwnedTodo(req));
    if (!deleted) throw new AppError('To-do item not found', 404, 'NOT_FOUND');

    await pushTaskToGoogle(deleted, 'delete').catch((err) => ({
      synced: false,
      warning: err.message as string,
    }));
    res.status(200).json({ success: true, data: { id: deleted._id, deleted: true } });
  } catch (err) {
    next(err);
  }
});

export default router;

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { TodoItem } from '../models/TodoItem.js';
import { TodoList, DEFAULT_TODO_LIST_TITLE } from '../models/TodoList.js';
import { Project } from '../models/Project.js';
import { StickyNote } from '../models/StickyNote.js';
import { CalendarAccount } from '../models/CalendarAccount.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/session.js';

const router = Router();

router.use(requireAuth);

const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function personalScope(userId: string) {
  return { $or: [{ assignedTo: userId }, { createdBy: userId }] };
}

/** Which productivity window best opens a task (a UI hint, not a task partition). */
function viewTarget(task: { dueDate?: Date | null }, todayKey: string): 'todo' | 'daily' {
  if (!task.dueDate) return 'todo';
  return new Date(task.dueDate).toISOString().slice(0, 10) <= todayKey ? 'todo' : 'daily';
}

async function googleStatus(organizationId: string, userId: string) {
  const account = await CalendarAccount.findOne({
    organizationId,
    userId,
    provider: 'google',
  })
    .select('-encryptedAccessToken -encryptedRefreshToken -calendarSyncToken')
    .sort({ createdAt: -1 })
    .lean();

  if (!account) {
    return {
      connected: false as const,
      email: null,
      syncTasks: false,
      syncCalendar: false,
      syncMeet: false,
      autoSync: false,
      lastSyncedAt: null,
      lastSyncError: null,
      tasksScopeGranted: false,
      calendarId: null,
      taskListId: null,
      taskListName: null,
    };
  }

  return {
    connected: account.status === 'connected',
    email: account.emailAddress,
    syncTasks: account.syncTasks !== false,
    syncCalendar: account.syncCalendar !== false,
    syncMeet: account.syncMeet !== false,
    autoSync: account.autoSync !== false,
    lastSyncedAt: account.lastSyncedAt || null,
    lastSyncError: account.lastSyncError || null,
    tasksScopeGranted: (account.grantedScopes || []).includes(TASKS_SCOPE),
    calendarId: account.calendarId || 'primary',
    taskListId: account.taskListId || '@default',
    taskListName: account.taskListName || null,
  };
}

// GET /api/v1/productivity/summary — dashboard cards, today's schedule, sync status.
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = dayRange(req);
    const org = req.organizationId;
    const userId = req.userId;

    const [
      listSettings,
      todoOpen,
      todoCompleted,
      dailyOpen,
      dailyCompletedToday,
      dailyOverdue,
      dailyUpcoming,
      activeProjects,
      openProjectTasks,
      notesCount,
      schedule,
      google,
    ] = await Promise.all([
      TodoList.findOne({ organizationId: org, userId }).lean(),
      TodoItem.countDocuments({
        organizationId: org,
        assignedTo: userId,
        status: 'open',
        $or: [{ dueDate: { $gte: from, $lt: to } }, { dueDate: null }],
      }),
      TodoItem.countDocuments({
        organizationId: org,
        assignedTo: userId,
        status: 'completed',
        completedAt: { $gte: from, $lt: to },
      }),
      TodoItem.countDocuments({
        organizationId: org,
        assignedTo: userId,
        status: 'open',
      }),
      TodoItem.countDocuments({
        organizationId: org,
        assignedTo: userId,
        status: 'completed',
      }),
      TodoItem.countDocuments({
        organizationId: org,
        assignedTo: userId,
        status: 'open',
        dueDate: { $lt: from },
      }),
      TodoItem.countDocuments({
        organizationId: org,
        assignedTo: userId,
        status: 'open',
        dueDate: { $gte: to },
      }),
      Project.find({ organizationId: org, userId, archived: false })
        .select('_id name color icon')
        .sort({ position: 1, createdAt: -1 })
        .lean(),
      Project.find({ organizationId: org, userId, archived: false })
        .select('_id')
        .lean()
        .then(async (projects) => {
          if (projects.length === 0) return 0;
          return TodoItem.countDocuments({
            organizationId: org,
            status: 'open',
            projectId: { $in: projects.map((project) => String(project._id)) },
            ...personalScope(userId),
          });
        }),
      StickyNote.countDocuments({ organizationId: org, userId }),
      TodoItem.find({
        organizationId: org,
        assignedTo: userId,
        dueDate: { $gte: from, $lt: to },
        scheduledTime: { $exists: true, $ne: null },
      })
        .select('title dueDate scheduledTime scheduledEndTime status priority projectId')
        .sort({ scheduledTime: 1 })
        .limit(50)
        .lean(),
      googleStatus(org, userId),
    ]);

    const todoTotal = todoOpen + todoCompleted;
    const dailyTotal = dailyOpen + dailyCompletedToday;

    res.status(200).json({
      success: true,
      data: {
        range: { from: from.toISOString(), to: to.toISOString() },
        todoList: {
          title: listSettings?.title || DEFAULT_TODO_LIST_TITLE,
          timezone: listSettings?.timezone || 'UTC',
          openCount: todoOpen,
          completedCount: todoCompleted,
          totalCount: todoTotal,
          progress: todoTotal === 0 ? 0 : Math.round((todoCompleted / todoTotal) * 100),
        },
        daily: {
          openCount: dailyOpen,
          completedCount: dailyCompletedToday,
          totalCount: dailyTotal,
          overdueCount: dailyOverdue,
          upcomingCount: dailyUpcoming,
          progress: dailyTotal === 0 ? 0 : Math.round((dailyCompletedToday / dailyTotal) * 100),
        },
        projects: {
          activeCount: activeProjects.length,
          openTaskCount: openProjectTasks,
          items: activeProjects.map((project) => ({
            _id: String(project._id),
            name: project.name,
            color: project.color,
            icon: project.icon,
          })),
        },
        notes: { count: notesCount },
        schedule,
        google,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/productivity/notifications — honest, derived alerts (no fabricated items).
router.get('/notifications', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = dayRange(req);
    const org = req.organizationId;
    const userId = req.userId;
    const todayKey = new Date().toISOString().slice(0, 10);

    const [overdue, reminders, account] = await Promise.all([
      TodoItem.find({
        organizationId: org,
        assignedTo: userId,
        status: 'open',
        dueDate: { $lt: from },
      })
        .select('title dueDate priority')
        .sort({ dueDate: 1 })
        .limit(8)
        .lean(),
      TodoItem.find({
        organizationId: org,
        assignedTo: userId,
        status: 'open',
        reminderEnabled: true,
        scheduledTime: { $exists: true, $ne: null },
        dueDate: { $gte: from, $lt: to },
      })
        .select('title dueDate scheduledTime priority')
        .sort({ scheduledTime: 1 })
        .limit(8)
        .lean(),
      CalendarAccount.findOne({ organizationId: org, userId, provider: 'google' })
        .select('lastSyncError emailAddress')
        .lean(),
    ]);

    const notifications: Array<{
      id: string;
      type: 'overdue' | 'reminder' | 'integration';
      title: string;
      message: string;
      taskId?: string;
      target?: 'todo' | 'daily';
      at?: string;
    }> = [];

    for (const task of overdue) {
      const dueLabel = task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : 'earlier';
      notifications.push({
        id: `overdue-${task._id}`,
        type: 'overdue',
        title: 'Overdue task',
        message: `"${task.title}" was due ${dueLabel}.`,
        taskId: String(task._id),
        target: viewTarget(task, todayKey),
        at: task.dueDate ? new Date(task.dueDate).toISOString() : undefined,
      });
    }

    for (const task of reminders) {
      const dueKey = task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : 'today';
      notifications.push({
        id: `reminder-${task._id}-${dueKey}-${task.scheduledTime}`,
        type: 'reminder',
        title: 'Task reminder',
        message: `"${task.title}" is scheduled at ${task.scheduledTime}.`,
        taskId: String(task._id),
        target: viewTarget(task, todayKey),
        at: task.dueDate ? new Date(task.dueDate).toISOString() : undefined,
      });
    }

    if (account?.lastSyncError) {
      notifications.push({
        id: 'google-sync-error',
        type: 'integration',
        title: 'Google sync needs attention',
        message: account.lastSyncError,
      });
    }

    res.status(200).json({
      success: true,
      data: {
        count: notifications.length,
        overdueCount: overdue.length,
        notifications,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/productivity/search?q= — tasks, projects and notes for the caller.
router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.status(200).json({
        success: true,
        data: { query: q, total: 0, tasks: [], projects: [], notes: [] },
      });
      return;
    }

    const org = req.organizationId;
    const userId = req.userId;
    const todayKey = new Date().toISOString().slice(0, 10);
    const pattern = new RegExp(escapeRegex(q), 'i');

    const [tasks, projects, notes] = await Promise.all([
      TodoItem.find({
        organizationId: org,
        $and: [
          personalScope(userId),
          {
            $or: [
              { title: pattern },
              { notes: pattern },
              { description: pattern },
              { tags: pattern },
            ],
          },
        ],
      })
        .select('title status priority dueDate scheduledTime projectId')
        .sort({ updatedAt: -1 })
        .limit(12)
        .lean(),
      Project.find({
        organizationId: org,
        userId,
        $or: [{ name: pattern }, { description: pattern }],
      })
        .select('name color icon archived')
        .limit(8)
        .lean(),
      StickyNote.find({
        organizationId: org,
        userId,
        $or: [{ title: pattern }, { content: pattern }],
      })
        .select('title content color')
        .limit(8)
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        query: q,
        total: tasks.length + projects.length + notes.length,
        tasks: tasks.map((task) => ({
          id: String(task._id),
          type: 'task' as const,
          title: task.title,
          subtitle: [
            task.status === 'completed'
              ? 'Completed'
              : task.dueDate && new Date(task.dueDate).toISOString().slice(0, 10) < todayKey
                ? 'Overdue'
                : task.dueDate && new Date(task.dueDate).toISOString().slice(0, 10) === todayKey
                  ? 'Today'
                  : 'Upcoming',
            task.priority,
          ]
            .filter(Boolean)
            .join(' · '),
          badge: task.priority,
          target: viewTarget(task, todayKey),
        })),
        projects: projects.map((project) => ({
          id: String(project._id),
          type: 'project' as const,
          title: project.name,
          subtitle: project.archived ? 'Archived project' : 'Project',
          badge: project.color,
        })),
        notes: notes.map((note) => ({
          id: String(note._id),
          type: 'note' as const,
          title: note.title || 'Untitled note',
          subtitle: note.content.slice(0, 90),
          badge: note.color,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;

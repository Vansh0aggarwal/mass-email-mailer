import { CalendarAccount } from '../models/CalendarAccount.js';
import { TodoItem } from '../models/TodoItem.js';
import { googleTasksService } from './google-tasks.service.js';
import { googleCalendarService } from './google-calendar.service.js';

const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
const SYNC_OVERLAP_MS = 2 * 60 * 1000;

export interface TaskSyncResult {
  synced: boolean;
  warning?: string;
}

export interface PullResult {
  tasksChanged: number;
  eventsChanged: number;
  imported: number;
  errors: string[];
  lastSyncedAt: Date;
}

function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function googleDue(date?: Date): string | undefined {
  return date ? `${dateKeyOf(date)}T00:00:00.000Z` : undefined;
}

function addMinutesToTime(dateKey: string, time: string, minutes: number): { date: string; time: string } {
  const [hour, minute] = time.split(':').map(Number);
  const base = new Date(Date.UTC(
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(5, 7)) - 1,
    Number(dateKey.slice(8, 10)),
    hour,
    minute + minutes
  ));
  return {
    date: base.toISOString().slice(0, 10),
    time: base.toISOString().slice(11, 16),
  };
}

function scheduleWindow(task: any): { startTime: string; endTime: string; timezone: string } | null {
  if (!task.dueDate || !task.scheduledTime) return null;
  const dateKey = dateKeyOf(task.dueDate);
  const end =
    task.scheduledEndTime && task.scheduledEndTime > task.scheduledTime
      ? { date: dateKey, time: task.scheduledEndTime }
      : addMinutesToTime(dateKey, task.scheduledTime, 30);
  return {
    startTime: `${dateKey}T${task.scheduledTime}:00`,
    endTime: `${end.date}T${end.time}:00`,
    timezone: task.timezone || 'UTC',
  };
}

/** Clears a Meet link only when the app generated it; manual links are user data. */
function clearGeneratedMeetLink(task: any): void {
  if (task.googleMeetSource === 'google') {
    task.googleMeetLink = undefined;
    task.googleMeetSource = undefined;
  }
}

async function syncAccount(organizationId: string, userId: string, accountId?: string): Promise<any | null> {
  if (accountId) {
    return CalendarAccount.findOne({
      _id: accountId,
      organizationId,
      userId,
      provider: 'google',
      status: 'connected',
    });
  }
  return CalendarAccount.findOne({
    organizationId,
    userId,
    provider: 'google',
    status: 'connected',
  });
}

/**
 * Pushes one task (and its optional calendar time block) to Google.
 * Failures never block local persistence; they are recorded on the task and
 * returned as a warning so the UI can surface an honest error state.
 */
export async function pushTaskToGoogle(
  task: any,
  action: 'upsert' | 'delete' = 'upsert'
): Promise<TaskSyncResult> {
  const account = await syncAccount(task.organizationId, task.assignedTo, task.calendarAccountId);
  if (!account) return { synced: false };

  const errors: string[] = [];

  if (account.syncTasks !== false) {
    try {
      const scopes: string[] = account.grantedScopes || [];
      if (!scopes.includes(TASKS_SCOPE)) {
        throw new Error('Reconnect Google to grant the Tasks permission.');
      }

      if (action === 'delete') {
        if (task.googleTaskId) await googleTasksService.deleteTask(account, task.googleTaskId);
        task.googleTaskId = undefined;
        task.googleTaskListId = undefined;
        task.calendarAccountId = undefined;
      } else {
        const payload = {
          title: task.title,
          notes: [task.description, task.notes].filter(Boolean).join('\n\n') || undefined,
          due: googleDue(task.dueDate),
          completed: task.status === 'completed',
        };

        if (task.googleTaskId && String(task.calendarAccountId) === String(account._id)) {
          try {
            const remote = await googleTasksService.patchTask(account, task.googleTaskId, payload);
            task.googleUpdatedAt = remote.updated ? new Date(remote.updated) : new Date();
          } catch {
            const remote = await googleTasksService.insertTask(account, payload);
            task.googleTaskId = remote.id;
            task.googleTaskListId = account.taskListId || '@default';
            task.calendarAccountId = String(account._id);
            task.googleUpdatedAt = remote.updated ? new Date(remote.updated) : new Date();
          }
        } else {
          const remote = await googleTasksService.insertTask(account, payload);
          task.googleTaskId = remote.id;
          task.googleTaskListId = account.taskListId || '@default';
          task.calendarAccountId = String(account._id);
          task.googleUpdatedAt = remote.updated ? new Date(remote.updated) : new Date();
        }
      }
    } catch (err: any) {
      errors.push(err.message || 'Google Tasks sync failed');
    }
  }

  if (account.syncCalendar !== false) {
    const window = scheduleWindow(task);
    const calendarId = task.googleCalendarId || account.calendarId || 'primary';
    const meetRequested = Boolean(task.addMeetLink && account.syncMeet !== false);

    const createEvent = async () => {
      const created = await googleCalendarService.createCalendarEvent({
        organizationId: task.organizationId,
        userId: task.assignedTo,
        calendarAccountId: String(account._id),
        summary: task.title,
        description: task.description || task.notes,
        ...window!,
        addMeetLink: meetRequested,
      });
      task.googleEventId = created.eventId;
      task.googleCalendarId = calendarId;
      task.calendarAccountId = String(account._id);
      if (created.meetLink && !task.googleMeetLink) {
        task.googleMeetLink = created.meetLink;
        task.googleMeetSource = 'google';
      }
    };

    try {
      if (action === 'delete') {
        if (task.googleEventId) {
          await googleCalendarService.deleteCalendarEvent({
            organizationId: task.organizationId,
            userId: task.assignedTo,
            calendarAccountId: String(account._id),
            calendarId,
            eventId: task.googleEventId,
          });
        }
        task.googleEventId = undefined;
        task.googleCalendarId = undefined;
        clearGeneratedMeetLink(task);
      } else if (window && task.addToCalendar !== false) {
        if (task.googleEventId) {
          const removeMeet = !meetRequested && task.googleMeetSource === 'google';
          try {
            const updated = await googleCalendarService.updateCalendarEvent({
              organizationId: task.organizationId,
              userId: task.assignedTo,
              calendarAccountId: String(account._id),
              calendarId,
              eventId: task.googleEventId,
              summary: task.title,
              description: task.description || task.notes,
              ...window,
              addMeetLink: meetRequested && !task.googleMeetLink,
              removeMeet,
            });
            task.googleEventId = updated.eventId;
            task.googleCalendarId = calendarId;
            task.calendarAccountId = String(account._id);
            if (updated.meetLink && !task.googleMeetLink) {
              task.googleMeetLink = updated.meetLink;
              task.googleMeetSource = 'google';
            }
            if (removeMeet) clearGeneratedMeetLink(task);
          } catch (err: any) {
            if (err?.code !== 'CALENDAR_EVENT_NOT_FOUND') throw err;
            // The remote event was removed; create a fresh one instead of looping.
            task.googleEventId = undefined;
            await createEvent();
          }
        } else {
          await createEvent();
        }
      } else if (task.googleEventId) {
        await googleCalendarService.deleteCalendarEvent({
          organizationId: task.organizationId,
          userId: task.assignedTo,
          calendarAccountId: String(account._id),
          calendarId,
          eventId: task.googleEventId,
        });
        task.googleEventId = undefined;
        task.googleCalendarId = undefined;
        clearGeneratedMeetLink(task);
      }
    } catch (err: any) {
      errors.push(err.message || 'Google Calendar sync failed');
    }
  }

  // Deleted documents must not be saved again (Mongoose would fail or resurrect it).
  if (action !== 'delete') {
    task.lastSyncedAt = new Date();
    task.lastSyncError = errors[0];
    if (typeof task.save === 'function') {
      await task.save();
    }
  }

  return errors.length === 0 ? { synced: true } : { synced: false, warning: errors.join(' · ') };
}

function parseRemoteDate(remoteDue?: string): Date | undefined {
  if (!remoteDue) return undefined;
  const dateKey = remoteDue.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return undefined;
  return new Date(`${dateKey}T12:00:00.000Z`);
}

function timeFromDateTime(value?: string): string | undefined {
  if (!value) return undefined;
  const match = value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : undefined;
}

function dateFromDateTime(value?: string): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

/**
 * Pulls remote Google Tasks and Calendar changes for the caller's account.
 * Conflict policy: if the local task changed since it was last pushed, the
 * local version wins and is pushed; otherwise the remote version is applied.
 */
export async function pullGoogleChanges(
  organizationId: string,
  userId: string
): Promise<PullResult> {
  const account = await syncAccount(organizationId, userId);
  if (!account) {
    return {
      tasksChanged: 0,
      eventsChanged: 0,
      imported: 0,
      errors: ['Google account is not connected.'],
      lastSyncedAt: new Date(),
    };
  }

  const errors: string[] = [];
  let tasksChanged = 0;
  let eventsChanged = 0;
  let imported = 0;

  if (account.syncTasks !== false) {
    try {
      const scopes: string[] = account.grantedScopes || [];
      if (!scopes.includes(TASKS_SCOPE)) {
        throw new Error('Reconnect Google to grant the Tasks permission.');
      }

      const updatedMin = account.lastSyncedAt
        ? new Date(account.lastSyncedAt.getTime() - SYNC_OVERLAP_MS).toISOString()
        : undefined;
      const remoteTasks = await googleTasksService.listTasks(account, updatedMin);

      for (const remote of remoteTasks) {
        const local = await TodoItem.findOne({
          organizationId,
          googleTaskId: remote.id,
          assignedTo: userId,
        });

        if (!local) {
          if (remote.deleted || remote.status === 'completed' || !remote.title) continue;
          await TodoItem.create({
            organizationId,
            title: remote.title,
            notes: remote.notes,
            dueDate: parseRemoteDate(remote.due),
            status: 'open',
            priority: 'medium',
            assignedTo: userId,
            createdBy: userId,
            googleTaskId: remote.id,
            googleTaskListId: account.taskListId || '@default',
            calendarAccountId: String(account._id),
            googleUpdatedAt: remote.updated ? new Date(remote.updated) : new Date(),
            lastSyncedAt: new Date(),
          });
          imported += 1;
          continue;
        }

        if (remote.deleted) {
          await TodoItem.deleteOne({ _id: local._id });
          tasksChanged += 1;
          continue;
        }

        const localDirty =
          !local.lastSyncedAt || local.updatedAt.getTime() > local.lastSyncedAt.getTime() + 1000;
        const remoteNewer =
          !local.googleUpdatedAt ||
          !remote.updated ||
          new Date(remote.updated).getTime() > local.googleUpdatedAt.getTime();

        if (localDirty) {
          await pushTaskToGoogle(local, 'upsert');
          continue;
        }
        if (!remoteNewer) continue;

        local.title = remote.title || local.title;
        if (remote.notes !== undefined) local.notes = remote.notes || undefined;
        local.dueDate = parseRemoteDate(remote.due) || local.dueDate;
        local.status = remote.status === 'completed' ? 'completed' : 'open';
        local.completedAt =
          remote.status === 'completed'
            ? remote.completed
              ? new Date(remote.completed)
              : local.completedAt || new Date()
            : undefined;
        local.googleUpdatedAt = remote.updated ? new Date(remote.updated) : new Date();
        local.lastSyncedAt = new Date();
        await local.save();
        tasksChanged += 1;
      }
    } catch (err: any) {
      errors.push(err.message || 'Google Tasks sync failed');
    }
  }

  if (account.syncCalendar !== false) {
    try {
      const timeMin = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const timeMax = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

      let changes;
      try {
        changes = await googleCalendarService.listEventChanges({
          organizationId,
          userId,
          calendarAccountId: String(account._id),
          syncToken: account.calendarSyncToken || undefined,
          timeMin,
          timeMax,
        });
      } catch (err: any) {
        if (err.code !== 'CALENDAR_SYNC_EXPIRED') throw err;
        account.calendarSyncToken = undefined;
        changes = await googleCalendarService.listEventChanges({
          organizationId,
          userId,
          calendarAccountId: String(account._id),
          timeMin,
          timeMax,
        });
      }

      for (const event of changes.events) {
        const task = await TodoItem.findOne({
          organizationId,
          googleEventId: event.id,
          assignedTo: userId,
        });
        if (!task) continue;

        if (event.status === 'cancelled') {
          task.googleEventId = undefined;
          task.googleCalendarId = undefined;
          task.scheduledTime = undefined;
          task.scheduledEndTime = undefined;
          clearGeneratedMeetLink(task);
          task.lastSyncedAt = new Date();
          await task.save();
          eventsChanged += 1;
          continue;
        }

        const localDirty =
          !task.lastSyncedAt || task.updatedAt.getTime() > task.lastSyncedAt.getTime() + 1000;
        if (localDirty) continue;

        const date = dateFromDateTime(event.startDateTime);
        const time = timeFromDateTime(event.startDateTime);
        const endTime = timeFromDateTime(event.endDateTime);
        if (!date || !time) continue;

        const nextDue = new Date(`${date}T12:00:00.000Z`);
        const changed =
          task.scheduledTime !== time ||
          (endTime !== undefined && task.scheduledEndTime !== endTime) ||
          !task.dueDate ||
          task.dueDate.toISOString().slice(0, 10) !== date ||
          (event.summary && event.summary !== task.title) ||
          (event.description !== undefined && (event.description || undefined) !== task.description) ||
          (event.meetLink !== undefined && event.meetLink !== task.googleMeetLink);

        if (!changed) continue;

        task.scheduledTime = time;
        if (endTime) task.scheduledEndTime = endTime;
        task.dueDate = nextDue;
        if (event.summary) task.title = event.summary;
        if (event.description !== undefined) task.description = event.description || undefined;
        if (event.timeZone) task.timezone = event.timeZone;
        if (event.meetLink) {
          task.googleMeetLink = event.meetLink;
          task.googleMeetSource = 'google';
        }
        task.googleCalendarId = account.calendarId || 'primary';
        task.lastSyncedAt = new Date();
        await task.save();
        eventsChanged += 1;
      }

      account.calendarSyncToken = changes.nextSyncToken;
    } catch (err: any) {
      errors.push(err.message || 'Google Calendar sync failed');
    }
  }

  const lastSyncedAt = new Date();
  account.lastSyncedAt = lastSyncedAt;
  account.lastSyncError = errors[0];
  await account.save();

  return { tasksChanged, eventsChanged, imported, errors, lastSyncedAt };
}

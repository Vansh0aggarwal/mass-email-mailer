import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { User } from '../models/User.js';
import { TodoItem } from '../models/TodoItem.js';
import { TodoList } from '../models/TodoList.js';
import { Project } from '../models/Project.js';
import { StickyNote } from '../models/StickyNote.js';
import { CalendarAccount } from '../models/CalendarAccount.js';

const ORG_A = 'productivity-org-a';
const ORG_B = 'productivity-org-b';
const ORG_M = 'productivity-org-metrics';
const ORGS = [ORG_A, ORG_B, ORG_M];

let app: Express;
let userA: InstanceType<typeof User>;
let userB: InstanceType<typeof User>;
let userC: InstanceType<typeof User>;
let userM: InstanceType<typeof User>;

function headers(user: { _id: unknown }, org = ORG_A): Record<string, string> {
  return { 'x-organization-id': org, 'x-user-id': String(user._id) };
}

function dateKey(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function todayRange(): { from: string; to: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

describe('Productivity APIs', () => {
  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    await Promise.all([
      TodoItem.deleteMany({ organizationId: { $in: ORGS } }),
      TodoList.deleteMany({ organizationId: { $in: ORGS } }),
      Project.deleteMany({ organizationId: { $in: ORGS } }),
      StickyNote.deleteMany({ organizationId: { $in: ORGS } }),
      CalendarAccount.deleteMany({ organizationId: { $in: ORGS } }),
      User.deleteMany({ email: /@productivity\.test$/ }),
    ]);

    [userA, userB, userC, userM] = await Promise.all([
      User.create({
        email: 'owner@productivity.test',
        fullName: 'Owner Productive',
        organizations: [{ organizationId: ORG_A, role: 'owner' }],
      }),
      User.create({
        email: 'member@productivity.test',
        fullName: 'Member Productive',
        organizations: [{ organizationId: ORG_A, role: 'manager' }],
      }),
      User.create({
        email: 'outsider@productivity.test',
        fullName: 'Outsider Productive',
        organizations: [{ organizationId: ORG_B, role: 'owner' }],
      }),
      User.create({
        email: 'metrics@productivity.test',
        fullName: 'Metrics Productive',
        organizations: [{ organizationId: ORG_M, role: 'owner' }],
      }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      TodoItem.deleteMany({ organizationId: { $in: ORGS } }),
      TodoList.deleteMany({ organizationId: { $in: ORGS } }),
      Project.deleteMany({ organizationId: { $in: ORGS } }),
      StickyNote.deleteMany({ organizationId: { $in: ORGS } }),
      CalendarAccount.deleteMany({ organizationId: { $in: ORGS } }),
      User.deleteMany({ email: /@productivity\.test$/ }),
    ]);
    await disconnectDatabase();
  });

  it('persists the customizable list name with a default and per-user isolation', async () => {
    const initial = await request(app).get('/api/v1/todos/settings').set(headers(userA));
    expect(initial.status).toBe(200);
    expect(initial.body.data.title).toBe('My To-Do List');
    expect(initial.body.data.timezone).toBe('UTC');

    const renamed = await request(app)
      .patch('/api/v1/todos/settings')
      .set(headers(userA))
      .send({ title: 'Focus List', timezone: 'Asia/Kolkata' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.title).toBe('Focus List');
    expect(renamed.body.data.timezone).toBe('Asia/Kolkata');

    const persisted = await request(app).get('/api/v1/todos/settings').set(headers(userA));
    expect(persisted.body.data.title).toBe('Focus List');

    const otherUser = await request(app).get('/api/v1/todos/settings').set(headers(userB));
    expect(otherUser.body.data.title).toBe('My To-Do List');

    const restored = await request(app)
      .patch('/api/v1/todos/settings')
      .set(headers(userA))
      .send({ title: '   ' });
    expect(restored.body.data.title).toBe('My To-Do List');
  });

  it('keeps one shared task set behind both the To-Do and Daily views', async () => {
    const created = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({
        title: 'Send pricing follow-up',
        priority: 'high',
        dueDate: dateKey(),
        scheduledTime: '14:30',
        scheduledEndTime: '15:15',
        reminderEnabled: true,
        reminderMinutes: 15,
      });

    expect(created.status).toBe(201);
    expect(created.body.data.priority).toBe('high');
    expect(created.body.data.scheduledTime).toBe('14:30');
    expect(created.body.data.scheduledEndTime).toBe('15:15');
    expect(created.body.data.reminderEnabled).toBe(true);
    expect(created.body.data.isCompleted).toBe(false);
    expect(created.body.data.sync).toBeDefined();

    const normal = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'Default priority task', dueDate: dateKey() });
    expect(normal.body.data.priority).toBe('medium');

    const future = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'Next week planning', dueDate: dateKey(4) });
    expect(future.status).toBe(201);

    const range = todayRange();
    const todayList = await request(app)
      .get(`/api/v1/todos?filter=today&from=${range.from}&to=${range.to}`)
      .set(headers(userA));
    expect(todayList.status).toBe(200);
    const todayTitles = todayList.body.data.map((task: any) => task.title);
    expect(todayTitles).toContain('Send pricing follow-up');
    expect(todayTitles).toContain('Default priority task');
    expect(todayTitles).not.toContain('Next week planning');

    // The same records, not copies, are visible in the Daily workspace.
    const dailyList = await request(app).get('/api/v1/todos').set(headers(userA));
    const dailyIds = dailyList.body.data.map((task: any) => task._id);
    expect(dailyIds).toContain(created.body.data._id);
    expect(dailyIds).toContain(normal.body.data._id);
    expect(dailyIds).toContain(future.body.data._id);
    expect(dailyList.body.data).toHaveLength(3);

    // An edit made through either surface is immediately visible in both.
    const renamed = await request(app)
      .patch(`/api/v1/todos/${created.body.data._id}`)
      .set(headers(userA))
      .send({ title: 'Send revised pricing follow-up', scheduledEndTime: '15:45' });
    expect(renamed.status).toBe(200);

    const [todayAfterRename, dailyAfterRename] = await Promise.all([
      request(app)
        .get(`/api/v1/todos?filter=today&from=${range.from}&to=${range.to}`)
        .set(headers(userA)),
      request(app).get('/api/v1/todos').set(headers(userA)),
    ]);
    for (const list of [todayAfterRename.body.data, dailyAfterRename.body.data]) {
      const row = list.find((task: any) => task._id === created.body.data._id);
      expect(row.title).toBe('Send revised pricing follow-up');
      expect(row.scheduledEndTime).toBe('15:45');
    }

    const completed = await request(app)
      .patch(`/api/v1/todos/${created.body.data._id}`)
      .set(headers(userA))
      .send({ status: 'completed' });
    expect(completed.body.data.status).toBe('completed');

    // Completed tasks stay in today's list on the day they were completed.
    const afterCompletion = await request(app)
      .get(`/api/v1/todos?filter=today&from=${range.from}&to=${range.to}`)
      .set(headers(userA));
    expect(afterCompletion.body.data.map((task: any) => task._id)).toContain(
      created.body.data._id
    );

    const invalidTime = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'Bad time', scheduledTime: '25:99' });
    expect(invalidTime.status).toBe(400);

    const endWithoutStart = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'End only', dueDate: dateKey(), scheduledEndTime: '11:00' });
    expect(endWithoutStart.status).toBe(400);
    expect(endWithoutStart.body.error.code).toBe('INVALID_TIME_RANGE');

    const backwardsRange = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({
        title: 'Backwards block',
        dueDate: dateKey(),
        scheduledTime: '15:00',
        scheduledEndTime: '14:00',
      });
    expect(backwardsRange.status).toBe(400);
    expect(backwardsRange.body.error.code).toBe('INVALID_TIME_RANGE');
  });

  it('validates manually attached Google Meet links and keeps them in both views', async () => {
    const rejected = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'External call', googleMeetLink: 'https://zoom.us/j/123' });
    expect(rejected.status).toBe(400);

    const accepted = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({
        title: 'Client sync',
        dueDate: dateKey(),
        scheduledTime: '09:00',
        googleMeetLink: 'https://meet.google.com/abc-defg-hij',
      });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.googleMeetLink).toBe('https://meet.google.com/abc-defg-hij');
    expect(accepted.body.data.googleMeetSource).toBe('manual');

    const range = todayRange();
    const [todayList, dailyList] = await Promise.all([
      request(app)
        .get(`/api/v1/todos?filter=today&from=${range.from}&to=${range.to}`)
        .set(headers(userA)),
      request(app).get('/api/v1/todos').set(headers(userA)),
    ]);
    for (const list of [todayList.body.data, dailyList.body.data]) {
      const row = list.find((task: any) => task._id === accepted.body.data._id);
      expect(row.googleMeetLink).toBe('https://meet.google.com/abc-defg-hij');
    }

    const cleared = await request(app)
      .patch(`/api/v1/todos/${accepted.body.data._id}`)
      .set(headers(userA))
      .send({ googleMeetLink: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.googleMeetLink).toBeUndefined();
    expect(cleared.body.data.googleMeetSource).toBeUndefined();
  });

  it('manages projects with live task progress and detaches tasks on delete', async () => {
    const project = await request(app)
      .post('/api/v1/projects')
      .set(headers(userA))
      .send({ name: 'Q4 launch', description: 'Launch sequence', color: 'blue', icon: 'briefcase' });
    expect(project.status).toBe(201);
    expect(project.body.data.progress).toBe(0);
    const projectId = project.body.data._id;

    const task = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'Project task', projectId, dueDate: dateKey() });
    expect(task.status).toBe(201);
    expect(task.body.data.project.name).toBe('Q4 launch');

    const withProgress = await request(app).get('/api/v1/projects').set(headers(userA));
    const row = withProgress.body.data.find((item: any) => item._id === projectId);
    expect(row.taskCount).toBe(1);
    expect(row.openCount).toBe(1);
    expect(row.progress).toBe(0);

    await request(app)
      .patch(`/api/v1/todos/${task.body.data._id}`)
      .set(headers(userA))
      .send({ status: 'completed' });

    const completedProgress = await request(app).get('/api/v1/projects').set(headers(userA));
    const completedRow = completedProgress.body.data.find((item: any) => item._id === projectId);
    expect(completedRow.progress).toBe(100);

    const archived = await request(app)
      .patch(`/api/v1/projects/${projectId}`)
      .set(headers(userA))
      .send({ archived: true, name: 'Q4 launch (archived)' });
    expect(archived.status).toBe(200);

    const activeOnly = await request(app).get('/api/v1/projects').set(headers(userA));
    expect(activeOnly.body.data.map((item: any) => item._id)).not.toContain(projectId);

    const withArchived = await request(app)
      .get('/api/v1/projects?includeArchived=1')
      .set(headers(userA));
    expect(withArchived.body.data.map((item: any) => item._id)).toContain(projectId);

    const deleted = await request(app)
      .delete(`/api/v1/projects/${projectId}`)
      .set(headers(userA));
    expect(deleted.status).toBe(200);

    const detached = await request(app)
      .get(`/api/v1/todos?q=${encodeURIComponent('Project task')}`)
      .set(headers(userA));
    expect(detached.body.data[0].project).toBeNull();
  });

  it('stores sticky notes and persists board order', async () => {
    const first = await request(app)
      .post('/api/v1/notes')
      .set(headers(userA))
      .send({ title: 'Ideas', content: 'Positioning for Q4', color: 'pink' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/notes')
      .set(headers(userA))
      .send({ title: 'Numbers', content: 'Pipeline review', color: 'blue' });
    expect(second.status).toBe(201);

    const updated = await request(app)
      .patch(`/api/v1/notes/${second.body.data._id}`)
      .set(headers(userA))
      .send({ content: 'Pipeline review — Friday', color: 'green' });
    expect(updated.body.data.color).toBe('green');

    const search = await request(app)
      .get('/api/v1/notes?q=positioning')
      .set(headers(userA));
    expect(search.body.data).toHaveLength(1);
    expect(search.body.data[0].title).toBe('Ideas');

    const reordered = await request(app)
      .patch('/api/v1/notes/reorder')
      .set(headers(userA))
      .send({ ids: [second.body.data._id, first.body.data._id] });
    expect(reordered.status).toBe(200);

    const board = await request(app).get('/api/v1/notes').set(headers(userA));
    expect(board.body.data.map((note: any) => note._id)).toEqual([
      second.body.data._id,
      first.body.data._id,
    ]);

    const removed = await request(app)
      .delete(`/api/v1/notes/${first.body.data._id}`)
      .set(headers(userA));
    expect(removed.status).toBe(200);
    expect((await request(app).get('/api/v1/notes').set(headers(userA))).body.data).toHaveLength(1);
  });

  it('summarizes the shared task set, schedule, notifications and search from real data', async () => {
    const todoOpen = await request(app)
      .post('/api/v1/todos')
      .set(headers(userM, ORG_M))
      .send({ title: 'Morning review', dueDate: dateKey(), priority: 'high' });
    const todoDone = await request(app)
      .post('/api/v1/todos')
      .set(headers(userM, ORG_M))
      .send({ title: 'Inbox cleanup', dueDate: dateKey() });
    await request(app)
      .patch(`/api/v1/todos/${todoDone.body.data._id}`)
      .set(headers(userM, ORG_M))
      .send({ status: 'completed' });

    await request(app)
      .post('/api/v1/todos')
      .set(headers(userM, ORG_M))
      .send({
        title: 'Prepare roadmap',
        dueDate: dateKey(),
        scheduledTime: '10:15',
        scheduledEndTime: '11:00',
        reminderEnabled: true,
      });
    await request(app)
      .post('/api/v1/todos')
      .set(headers(userM, ORG_M))
      .send({ title: 'Late invoice', dueDate: dateKey(-2) });
    await request(app)
      .post('/api/v1/todos')
      .set(headers(userM, ORG_M))
      .send({ title: 'Next week planning', dueDate: dateKey(3) });

    const range = todayRange();
    const summary = await request(app)
      .get(`/api/v1/productivity/summary?from=${range.from}&to=${range.to}`)
      .set(headers(userM, ORG_M));

    expect(summary.status).toBe(200);
    const data = summary.body.data;
    expect(data.todoList.title).toBe('My To-Do List');
    // To-Do: open tasks due today (or undated) plus tasks completed today.
    expect(data.todoList.openCount).toBe(2);
    expect(data.todoList.completedCount).toBe(1);
    expect(data.todoList.totalCount).toBe(3);
    expect(data.todoList.progress).toBe(33);
    // Daily: the same records, unfiltered by day.
    expect(data.daily.openCount).toBe(4);
    expect(data.daily.completedCount).toBe(1);
    expect(data.daily.totalCount).toBe(5);
    expect(data.daily.overdueCount).toBe(1);
    expect(data.daily.upcomingCount).toBe(1);
    expect(data.daily.progress).toBe(20);
    expect(data.projects.activeCount).toBe(0);
    expect(data.notes.count).toBe(0);
    expect(data.schedule).toHaveLength(1);
    expect(data.schedule[0].title).toBe('Prepare roadmap');
    expect(data.schedule[0].scheduledTime).toBe('10:15');
    expect(data.schedule[0].scheduledEndTime).toBe('11:00');
    expect(data.google.connected).toBe(false);

    const notifications = await request(app)
      .get(`/api/v1/productivity/notifications?from=${range.from}&to=${range.to}`)
      .set(headers(userM, ORG_M));
    expect(notifications.status).toBe(200);
    expect(notifications.body.data.overdueCount).toBe(1);
    const types = notifications.body.data.notifications.map((item: any) => item.type);
    expect(types).toContain('overdue');
    expect(types).toContain('reminder');
    expect(
      notifications.body.data.notifications.find((item: any) => item.type === 'overdue').taskId
    ).toBeTruthy();

    const search = await request(app)
      .get('/api/v1/productivity/search?q=roadmap')
      .set(headers(userM, ORG_M));
    expect(search.status).toBe(200);
    expect(search.body.data.tasks.map((task: any) => task.title)).toContain('Prepare roadmap');
    expect(search.body.data.tasks[0].target).toBe('todo');

    const emptySearch = await request(app)
      .get('/api/v1/productivity/search')
      .set(headers(userM, ORG_M));
    expect(emptySearch.body.data.total).toBe(0);

    expect(todoOpen.body.data.id).toBe(String(todoOpen.body.data._id));
    expect(todoOpen.body.data.userId).toBe(String(userM._id));
    expect(todoOpen.body.data.space).toBeUndefined();
  });

  it('isolates productivity data across tenants', async () => {
    const foreignProject = await request(app)
      .post('/api/v1/projects')
      .set(headers(userA))
      .send({ name: 'Private roadmap' });
    const foreignNote = await request(app)
      .post('/api/v1/notes')
      .set(headers(userA))
      .send({ title: 'Private note', content: 'Secret' });

    expect((await request(app).get('/api/v1/projects').set(headers(userC, ORG_B))).body.data).toHaveLength(0);
    expect((await request(app).get('/api/v1/notes').set(headers(userC, ORG_B))).body.data).toHaveLength(0);
    expect(
      (await request(app).get('/api/v1/productivity/search?q=Private').set(headers(userC, ORG_B))).body
        .data.total
    ).toBe(0);

    const patchProject = await request(app)
      .patch(`/api/v1/projects/${foreignProject.body.data._id}`)
      .set(headers(userC, ORG_B))
      .send({ name: 'Hijacked' });
    expect(patchProject.status).toBe(404);

    const patchNote = await request(app)
      .patch(`/api/v1/notes/${foreignNote.body.data._id}`)
      .set(headers(userC, ORG_B))
      .send({ content: 'Hijacked' });
    expect(patchNote.status).toBe(404);

    const deleteNote = await request(app)
      .delete(`/api/v1/notes/${foreignNote.body.data._id}`)
      .set(headers(userC, ORG_B));
    expect(deleteNote.status).toBe(404);

    const invalidProject = await request(app)
      .patch('/api/v1/projects/not-an-id')
      .set(headers(userA))
      .send({ name: 'Nope' });
    expect(invalidProject.status).toBe(404);
  });

  it('exposes honest Google integration settings without leaking tokens', async () => {
    const disconnected = await request(app)
      .get('/api/v1/calendar/integration-settings')
      .set(headers(userA));
    expect(disconnected.status).toBe(200);
    expect(disconnected.body.data.connected).toBe(false);
    expect(disconnected.body.data.syncTasks).toBe(false);
    expect(disconnected.body.data.syncMeet).toBe(false);

    const patchWithoutAccount = await request(app)
      .patch('/api/v1/calendar/integration-settings')
      .set(headers(userA))
      .send({ syncTasks: true });
    expect(patchWithoutAccount.status).toBe(400);
    expect(patchWithoutAccount.body.error.code).toBe('GOOGLE_NOT_CONNECTED');

    const syncWithoutAccount = await request(app)
      .post('/api/v1/calendar/sync')
      .set(headers(userA));
    expect(syncWithoutAccount.status).toBe(400);
    expect(syncWithoutAccount.body.error.code).toBe('GOOGLE_NOT_CONNECTED');

    await CalendarAccount.create({
      organizationId: ORG_A,
      userId: String(userA._id),
      displayName: 'Owner Productive',
      emailAddress: 'owner@productivity.test',
      provider: 'google',
      status: 'connected',
      encryptedAccessToken: 'enc-access',
      encryptedRefreshToken: 'enc-refresh',
      grantedScopes: ['https://www.googleapis.com/auth/calendar.events'],
    });

    const settings = await request(app)
      .get('/api/v1/calendar/integration-settings')
      .set(headers(userA));
    expect(settings.status).toBe(200);
    expect(settings.body.data.connected).toBe(true);
    expect(settings.body.data.email).toBe('owner@productivity.test');
    expect(settings.body.data.tasksScopeGranted).toBe(false);
    expect(settings.body.data.syncMeet).toBe(true);
    expect(settings.body.data.encryptedRefreshToken).toBeUndefined();
    expect(settings.body.data.encryptedAccessToken).toBeUndefined();

    const patched = await request(app)
      .patch('/api/v1/calendar/integration-settings')
      .set(headers(userA))
      .send({
        calendarId: 'team@group.calendar.google.com',
        taskListId: 'MTIzNDU2',
        taskListName: 'Swaniki Tasks',
        syncTasks: false,
        syncCalendar: false,
        syncMeet: false,
        autoSync: false,
      });
    expect(patched.status).toBe(200);
    expect(patched.body.data.taskListName).toBe('Swaniki Tasks');
    expect(patched.body.data.syncCalendar).toBe(false);
    expect(patched.body.data.syncMeet).toBe(false);

    const summary = await request(app)
      .get('/api/v1/productivity/summary')
      .set(headers(userA));
    expect(summary.body.data.google.connected).toBe(true);
    expect(summary.body.data.google.syncTasks).toBe(false);
    expect(summary.body.data.google.syncMeet).toBe(false);
    expect(summary.body.data.google.email).toBe('owner@productivity.test');

    // With both sync switches off, a manual sync is a safe no-op.
    const noopSync = await request(app).post('/api/v1/calendar/sync').set(headers(userA));
    expect(noopSync.status).toBe(200);
    expect(noopSync.body.data.errors).toEqual([]);
  });
});

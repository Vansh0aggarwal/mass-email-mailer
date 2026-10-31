import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { User } from '../models/User.js';
import { TodoItem } from '../models/TodoItem.js';

const ORG_A = 'todos-org-a';
const ORG_B = 'todos-org-b';

let app: Express;
let userA: InstanceType<typeof User>;
let userB: InstanceType<typeof User>;
let outsider: InstanceType<typeof User>;

function headers(user: { _id: unknown }, org = ORG_A): Record<string, string> {
  return { 'x-organization-id': org, 'x-user-id': String(user._id) };
}

function todayRange(): { from: string; to: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

describe('To-do list and daily tasks', () => {
  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    await TodoItem.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } });
    await User.deleteMany({ email: /@todos\.test$/ });

    [userA, userB, outsider] = await Promise.all([
      User.create({
        email: 'alice@todos.test',
        fullName: 'Alice ToDo',
        organizations: [{ organizationId: ORG_A, role: 'owner' }],
      }),
      User.create({
        email: 'bob@todos.test',
        fullName: 'Bob ToDo',
        organizations: [{ organizationId: ORG_A, role: 'manager' }],
      }),
      User.create({
        email: 'carl@todos.test',
        fullName: 'Carl Outsider',
        organizations: [{ organizationId: ORG_B, role: 'owner' }],
      }),
    ]);
  });

  afterAll(async () => {
    await TodoItem.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } });
    await User.deleteMany({ email: /@todos\.test$/ });
    await disconnectDatabase();
  });

  it('creates a personal task and resolves its actor profiles', async () => {
    const res = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'Prepare Q4 report', priority: 'high' });

    expect(res.status).toBe(201);
    expect(res.body.data.title).toBe('Prepare Q4 report');
    expect(res.body.data.status).toBe('open');
    expect(res.body.data.assignedTo).toBe(String(userA._id));
    expect(res.body.data.createdBy).toBe(String(userA._id));
    expect(res.body.data.assignedToUser.fullName).toBe('Alice ToDo');
    expect(res.body.data.createdByUser.fullName).toBe('Alice ToDo');
  });

  it('supports assigned tasks, completion and reopening', async () => {
    const created = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({
        title: 'Call the prospect',
        assignedTo: String(userB._id),
        dueDate: new Date().toISOString(),
      });
    expect(created.status).toBe(201);
    expect(created.body.data.assignedTo).toBe(String(userB._id));
    expect(created.body.data.assignedToUser.fullName).toBe('Bob ToDo');

    const id = created.body.data._id;

    // The assignee sees the task in both the list and today's tasks.
    const list = await request(app).get('/api/v1/todos').set(headers(userB));
    expect(list.status).toBe(200);
    expect(list.body.data.map((t: any) => t._id)).toContain(id);

    const range = todayRange();
    const daily = await request(app)
      .get(`/api/v1/todos/daily?from=${range.from}&to=${range.to}`)
      .set(headers(userB));
    expect(daily.status).toBe(200);
    expect(daily.body.data.map((t: any) => t._id)).toContain(id);

    const completed = await request(app)
      .patch(`/api/v1/todos/${id}`)
      .set(headers(userB))
      .send({ status: 'completed' });
    expect(completed.status).toBe(200);
    expect(completed.body.data.status).toBe('completed');
    expect(completed.body.data.completedAt).toBeTruthy();

    // Completed today still shows in today's daily list, as a completed row.
    const dailyAfter = await request(app)
      .get(`/api/v1/todos/daily?from=${range.from}&to=${range.to}`)
      .set(headers(userB));
    expect(dailyAfter.body.data.map((t: any) => t._id)).toContain(id);

    const reopened = await request(app)
      .patch(`/api/v1/todos/${id}`)
      .set(headers(userB))
      .send({ status: 'open' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.completedAt).toBeUndefined();
  });

  it('keeps future tasks out of today while showing overdue work', async () => {
    const future = new Date();
    future.setDate(future.getDate() + 3);
    const overdue = new Date();
    overdue.setDate(overdue.getDate() - 2);

    const [futureRes, overdueRes] = await Promise.all([
      request(app)
        .post('/api/v1/todos')
        .set(headers(userA))
        .send({ title: 'Future task', dueDate: future.toISOString() }),
      request(app)
        .post('/api/v1/todos')
        .set(headers(userA))
        .send({ title: 'Overdue task', dueDate: overdue.toISOString() }),
    ]);

    const range = todayRange();
    const daily = await request(app)
      .get(`/api/v1/todos/daily?from=${range.from}&to=${range.to}`)
      .set(headers(userA));
    const titles = daily.body.data.map((t: any) => t.title);
    expect(titles).toContain('Overdue task');
    expect(titles).not.toContain('Future task');
    expect(titles).not.toContain('Prepare Q4 report'); // no due date

    await request(app).delete(`/api/v1/todos/${futureRes.body.data._id}`).set(headers(userA));
    await request(app).delete(`/api/v1/todos/${overdueRes.body.data._id}`).set(headers(userA));
  });

  it('rejects assignees outside the organization', async () => {
    const res = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'Sneaky assignment', assignedTo: String(outsider._id) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ASSIGNEE');
  });

  it('isolates tasks across tenants and rejects foreign ids', async () => {
    const created = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'Tenant private task' });
    const id = created.body.data._id;

    const outsiderList = await request(app).get('/api/v1/todos').set(headers(outsider, ORG_B));
    expect(outsiderList.status).toBe(200);
    expect(outsiderList.body.data).toHaveLength(0);

    const outsiderPatch = await request(app)
      .patch(`/api/v1/todos/${id}`)
      .set(headers(outsider, ORG_B))
      .send({ title: 'Hijacked' });
    expect(outsiderPatch.status).toBe(404);

    const outsiderDelete = await request(app)
      .delete(`/api/v1/todos/${id}`)
      .set(headers(outsider, ORG_B));
    expect(outsiderDelete.status).toBe(404);

    const invalidId = await request(app)
      .patch('/api/v1/todos/not-an-id')
      .set(headers(userA))
      .send({ title: 'Nope' });
    expect(invalidId.status).toBe(404);
  });

  it('validates input and supports deletion', async () => {
    const empty = await request(app).post('/api/v1/todos').set(headers(userA)).send({ title: '  ' });
    expect(empty.status).toBe(400);

    const invalidDate = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'Bad date', dueDate: 'not-a-date' });
    expect(invalidDate.status).toBe(400);

    const created = await request(app)
      .post('/api/v1/todos')
      .set(headers(userA))
      .send({ title: 'Delete me' });
    const deleted = await request(app)
      .delete(`/api/v1/todos/${created.body.data._id}`)
      .set(headers(userA));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.deleted).toBe(true);
    expect(await TodoItem.findById(created.body.data._id)).toBeNull();
  });
});

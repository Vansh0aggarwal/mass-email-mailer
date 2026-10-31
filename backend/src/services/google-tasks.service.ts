import { google } from 'googleapis';
import { env } from '../config/env.js';
import { CalendarAccount } from '../models/CalendarAccount.js';
import { decryptToken } from '../utils/crypto.js';
import { AppError } from '../middleware/errorHandler.js';

export interface GoogleTaskSummary {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: 'needsAction' | 'completed';
  completed?: string;
  updated?: string;
  deleted?: boolean;
}

export interface GoogleTaskListSummary {
  id: string;
  title: string;
}

export class GoogleTasksService {
  private getOAuthClient() {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError(
        'Google OAuth credentials not configured in environment.',
        500,
        'OAUTH_NOT_CONFIGURED'
      );
    }
    return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  }

  public async findConnectedAccount(options: {
    organizationId: string;
    userId: string;
    calendarAccountId?: string;
  }): Promise<any> {
    const account = options.calendarAccountId
      ? await CalendarAccount.findOne({
          _id: options.calendarAccountId,
          organizationId: options.organizationId,
          userId: options.userId,
        })
      : await CalendarAccount.findOne({
          organizationId: options.organizationId,
          userId: options.userId,
          status: 'connected',
        });

    if (!account || account.provider !== 'google' || !account.encryptedRefreshToken) {
      throw new AppError(
        'Connect a Google account before synchronizing tasks.',
        400,
        'GOOGLE_NOT_CONNECTED'
      );
    }
    const scopes: string[] = account.grantedScopes || [];
    if (!scopes.includes('https://www.googleapis.com/auth/tasks')) {
      throw new AppError(
        'Reconnect your Google account to grant the Google Tasks permission.',
        400,
        'GOOGLE_TASKS_SCOPE_MISSING'
      );
    }
    return account;
  }

  private client(account: any) {
    const client = this.getOAuthClient();
    client.setCredentials({ refresh_token: decryptToken(account.encryptedRefreshToken) });
    return google.tasks({ version: 'v1', auth: client });
  }

  private taskListId(account: any): string {
    return account.taskListId || '@default';
  }

  public async listTaskLists(options: {
    organizationId: string;
    userId: string;
    calendarAccountId?: string;
  }): Promise<GoogleTaskListSummary[]> {
    const account = await this.findConnectedAccount(options);
    try {
      const tasks = this.client(account);
      const res = await tasks.tasklists.list({ maxResults: 100 });
      return (res.data.items || [])
        .filter((item) => item.id)
        .map((item) => ({ id: item.id as string, title: item.title || 'Tasks' }));
    } catch (err: any) {
      throw new AppError(`Google Tasks provider error: ${err.message}`, 502, 'TASKS_PROVIDER_ERROR');
    }
  }

  public async insertTask(
    account: any,
    input: { title: string; notes?: string; due?: string; completed?: boolean }
  ): Promise<GoogleTaskSummary> {
    try {
      const tasks = this.client(account);
      const res = await tasks.tasks.insert({
        tasklist: this.taskListId(account),
        requestBody: {
          title: input.title,
          notes: input.notes,
          due: input.due,
          status: input.completed ? 'completed' : 'needsAction',
        },
      });
      return this.toSummary(res.data);
    } catch (err: any) {
      throw new AppError(`Google Tasks provider error: ${err.message}`, 502, 'TASKS_PROVIDER_ERROR');
    }
  }

  public async patchTask(
    account: any,
    taskId: string,
    input: { title?: string; notes?: string; due?: string | null; completed?: boolean }
  ): Promise<GoogleTaskSummary> {
    try {
      const tasks = this.client(account);
      const res = await tasks.tasks.patch({
        tasklist: this.taskListId(account),
        task: taskId,
        requestBody: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.due !== undefined ? { due: input.due || undefined } : {}),
          ...(input.completed !== undefined
            ? {
                status: input.completed ? 'completed' : 'needsAction',
                completed: input.completed ? new Date().toISOString() : undefined,
              }
            : {}),
        },
      });
      return this.toSummary(res.data);
    } catch (err: any) {
      if (err?.code === 404 || err?.status === 404) {
        throw new AppError('Google task not found', 404, 'GOOGLE_TASK_NOT_FOUND');
      }
      throw new AppError(`Google Tasks provider error: ${err.message}`, 502, 'TASKS_PROVIDER_ERROR');
    }
  }

  public async deleteTask(account: any, taskId: string): Promise<void> {
    try {
      const tasks = this.client(account);
      await tasks.tasks.delete({ tasklist: this.taskListId(account), task: taskId });
    } catch (err: any) {
      if (err?.code === 404 || err?.status === 404) return;
      throw new AppError(`Google Tasks provider error: ${err.message}`, 502, 'TASKS_PROVIDER_ERROR');
    }
  }

  /** Lists changes since `updatedMin` (RFC 3339), including completed tasks. */
  public async listTasks(account: any, updatedMin?: string): Promise<GoogleTaskSummary[]> {
    try {
      const tasks = this.client(account);
      const items: GoogleTaskSummary[] = [];
      let pageToken: string | undefined;

      do {
        const res = await tasks.tasks.list({
          tasklist: this.taskListId(account),
          showCompleted: true,
          showHidden: true,
          maxResults: 100,
          updatedMin,
          pageToken,
        });
        for (const item of res.data.items || []) {
          if (!item.id) continue;
          items.push({ ...this.toSummary(item), deleted: item.deleted === true });
        }
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken && items.length < 500);

      return items;
    } catch (err: any) {
      throw new AppError(`Google Tasks provider error: ${err.message}`, 502, 'TASKS_PROVIDER_ERROR');
    }
  }

  private toSummary(item: any): GoogleTaskSummary {
    return {
      id: item.id,
      title: item.title || '',
      notes: item.notes || undefined,
      due: item.due || undefined,
      status: item.status === 'completed' ? 'completed' : 'needsAction',
      completed: item.completed || undefined,
      updated: item.updated || undefined,
    };
  }
}

export const googleTasksService = new GoogleTasksService();

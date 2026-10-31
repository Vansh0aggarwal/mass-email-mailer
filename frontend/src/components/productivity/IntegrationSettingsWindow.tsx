import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  PlugZap,
  RefreshCw,
  Unplug,
  Video,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import type {
  GoogleCalendarOption,
  GoogleIntegrationSettings,
  GoogleTaskListOption,
} from '../../types';
import { productivityKeys } from '../../lib/productivity';
import { useProductivity } from '../../context/ProductivityContext';
import { FloatingWindow } from './FloatingWindow';

interface SyncResult {
  tasksChanged: number;
  eventsChanged: number;
  imported: number;
  errors: string[];
  lastSyncedAt: string;
}

/**
 * Google Calendar + Tasks integration settings. The OAuth redirect is the same
 * server-side flow used by the Integrations page; tokens never touch the
 * frontend.
 */
export function IntegrationSettingsWindow() {
  const { isWindowOpen, closeWindow, bringToFront } = useProductivity();
  const open = isWindowOpen('integration');
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: productivityKeys.integration,
    queryFn: () => api.get<GoogleIntegrationSettings>('/calendar/integration-settings'),
    enabled: open,
  });

  const settings = settingsQuery.data;

  const calendarsQuery = useQuery({
    queryKey: productivityKeys.calendars,
    queryFn: () => api.get<GoogleCalendarOption[]>('/calendar/calendars'),
    enabled: open && Boolean(settings?.connected),
    retry: false,
  });

  const taskListsQuery = useQuery({
    queryKey: productivityKeys.taskLists,
    queryFn: () => api.get<GoogleTaskListOption[]>('/calendar/task-lists'),
    enabled: open && Boolean(settings?.connected && settings?.tasksScopeGranted),
    retry: false,
  });

  const [syncTasks, setSyncTasks] = useState(true);
  const [syncCalendar, setSyncCalendar] = useState(true);
  const [syncMeet, setSyncMeet] = useState(true);
  const [autoSync, setAutoSync] = useState(true);
  const [calendarId, setCalendarId] = useState('primary');
  const [taskListId, setTaskListId] = useState('@default');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!settings) return;
    setSyncTasks(settings.syncTasks);
    setSyncCalendar(settings.syncCalendar);
    setSyncMeet(settings.syncMeet !== false);
    setAutoSync(settings.autoSync);
    setCalendarId(settings.calendarId || 'primary');
    setTaskListId(settings.taskListId || '@default');
    setConfirmDisconnect(false);
    setMessage('');
    setError('');
    // Reset only when the connected identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.id, settings?.connected]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['productivity'] });
    queryClient.invalidateQueries({ queryKey: ['todos'] });
  };

  const save = useMutation({
    mutationFn: () => {
      const list = (taskListsQuery.data || []).find((option) => option.id === taskListId);
      return api.patch<GoogleIntegrationSettings>('/calendar/integration-settings', {
        syncTasks,
        syncCalendar,
        syncMeet,
        autoSync,
        calendarId,
        taskListId,
        taskListName: list?.title || '',
      });
    },
    onSuccess: () => {
      setError('');
      setMessage('Integration settings saved.');
      queryClient.invalidateQueries({ queryKey: productivityKeys.integration });
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const sync = useMutation({
    mutationFn: () => api.post<SyncResult>('/calendar/sync'),
    onSuccess: (result) => {
      setError('');
      const summary = [
        `${result.imported} imported`,
        `${result.tasksChanged} task${result.tasksChanged === 1 ? '' : 's'} updated`,
        `${result.eventsChanged} calendar update${result.eventsChanged === 1 ? '' : 's'}`,
      ].join(' · ');
      setMessage(result.errors.length ? `Synced with warnings: ${result.errors.join(' · ')}` : `Synced. ${summary}.`);
      queryClient.invalidateQueries({ queryKey: productivityKeys.integration });
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const disconnect = useMutation({
    mutationFn: () => api.delete<{ disconnected: boolean }>(`/calendar/accounts/${settings?.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productivityKeys.integration });
      queryClient.invalidateQueries({ queryKey: productivityKeys.calendars });
      queryClient.invalidateQueries({ queryKey: productivityKeys.taskLists });
      invalidate();
      setConfirmDisconnect(false);
      setMessage('Google account disconnected.');
    },
    onError: (err: Error) => setError(err.message),
  });

  const connect = () => {
    // Top-level navigation to the authenticated OAuth start route (same flow
    // as the Integrations page). The callback returns to the dashboard.
    window.location.href = '/api/v1/calendar/google/connect?returnTo=/dashboard';
  };

  const isConnected = Boolean(settings?.connected);
  const calendarOptions = calendarsQuery.data || [];
  const taskListOptions = taskListsQuery.data || [];

  const connectedSince = useMemo(() => {
    if (!settings?.lastSyncedAt) return null;
    return new Date(settings.lastSyncedAt).toLocaleString();
  }, [settings?.lastSyncedAt]);

  return (
    <FloatingWindow
      open={open}
      onClose={() => closeWindow('integration')}
      onActivate={() => bringToFront('integration')}
      size="panel"
      defaultRight={96}
      defaultTop={88}
      icon={PlugZap}
      title="Google integration"
      subtitle="Sync tasks and schedule time blocks without leaving the dashboard."
    >
      <div className="space-y-4 px-4 py-4 sm:px-5">
        {error && (
          <p className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            {error}
          </p>
        )}
        {message && (
          <p className="rounded-xl border border-success/25 bg-success/10 px-3 py-2 text-[11px] text-success">
            {message}
          </p>
        )}

        {settingsQuery.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            <div className="h-24 animate-pulse rounded-xl border border-line bg-surface-2" />
            <div className="h-40 animate-pulse rounded-xl border border-line bg-surface-2" />
          </div>
        ) : settingsQuery.isError ? (
          <div className="empty-state gap-3 px-4 py-8">
            <p className="text-xs">Could not load integration settings.</p>
            <button
              type="button"
              onClick={() => settingsQuery.refetch()}
              className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold"
            >
              Try again
            </button>
          </div>
        ) : !isConnected ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-line bg-surface-2 p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface text-ink-muted">
                <CalendarDays className="h-5 w-5" />
              </span>
              <h3 className="mt-3 text-sm font-semibold text-ink">Connect Google Calendar</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                Connecting lets completed tasks sync to Google Tasks, lets scheduled tasks reserve
                a Google Calendar time block, and can add Google Meet links when you ask for one.
                Tokens are stored encrypted on the server — never in the browser.
              </p>
              <ul className="mt-3 space-y-1.5 text-[11px] text-ink-muted">
                {[
                  'Two-way Google Tasks sync with duplicate protection',
                  'Optional calendar time blocks for scheduled tasks',
                  'Manual sync and clear error reporting',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                    {item}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={connect}
                className="ios-btn-primary mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Connect Google
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-line bg-surface-2 p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                    <span className="h-2 w-2 rounded-full bg-success" />
                    Connected
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-ink-muted">{settings?.email}</p>
                  {connectedSince && (
                    <p className="mt-0.5 text-[10px] text-ink-subtle">Last synced {connectedSince}</p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={sync.isPending}
                  onClick={() => sync.mutate()}
                  className="ios-btn-secondary inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
                >
                  <RefreshCw className={clsx('h-3.5 w-3.5', sync.isPending && 'animate-spin')} />
                  {sync.isPending ? 'Syncing…' : 'Sync now'}
                </button>
              </div>
              {settings?.lastSyncError && (
                <p className="mt-2 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-1.5 text-[10px] text-warning">
                  {settings.lastSyncError}
                </p>
              )}
            </div>

            {!settings?.tasksScopeGranted && (
              <div className="rounded-xl border border-warning/25 bg-warning/10 p-3">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" /> Google Tasks access is missing
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">
                  Reconnect to grant the Tasks scope. Calendar sync can still work without it.
                </p>
                <button
                  type="button"
                  onClick={connect}
                  className="ios-btn-secondary mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold"
                >
                  <ExternalLink className="h-3 w-3" /> Reconnect Google
                </button>
              </div>
            )}

            <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold text-ink">Google Tasks sync</p>
                  <p className="text-[10px] text-ink-muted">Create, update and complete tasks.</p>
                </div>
                <input
                  type="checkbox"
                  checked={syncTasks}
                  onChange={(event) => setSyncTasks(event.target.checked)}
                  aria-label="Sync tasks with Google"
                  className="h-4 w-4 rounded border-line accent-accent"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold text-ink">Calendar time blocks</p>
                  <p className="text-[10px] text-ink-muted">
                    Reserve time for scheduled tasks using their start and end time.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={syncCalendar}
                  onChange={(event) => setSyncCalendar(event.target.checked)}
                  aria-label="Sync calendar time blocks"
                  className="h-4 w-4 rounded border-line accent-accent"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-ink">
                    <Video className="h-3.5 w-3.5 text-ink-subtle" />
                    Google Meet
                  </p>
                  <p className="text-[10px] text-ink-muted">
                    Add Meet links only to tasks where you request a meeting.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={syncMeet}
                  disabled={!syncCalendar}
                  onChange={(event) => setSyncMeet(event.target.checked)}
                  aria-label="Create Google Meet links"
                  className="h-4 w-4 rounded border-line accent-accent disabled:opacity-50"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold text-ink">Auto sync</p>
                  <p className="text-[10px] text-ink-muted">
                    Pull Google changes when you open the dashboard.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={(event) => setAutoSync(event.target.checked)}
                  aria-label="Automatically sync Google changes"
                  className="h-4 w-4 rounded border-line accent-accent"
                />
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div>
                  <label htmlFor="calendar-select" className="mb-1 block text-[10px] font-semibold text-ink-muted">
                    Calendar
                  </label>
                  <select
                    id="calendar-select"
                    value={calendarId}
                    onChange={(event) => setCalendarId(event.target.value)}
                    disabled={!syncCalendar || calendarsQuery.isLoading}
                    className="input px-2.5 py-1.5 text-[11px] disabled:opacity-60"
                  >
                    {calendarOptions.length === 0 && (
                      <option value={settings?.calendarId || 'primary'} className="bg-surface text-ink">
                        {settings?.calendarId || 'Primary calendar'}
                      </option>
                    )}
                    {calendarOptions.map((option) => (
                      <option key={option.id} value={option.id} className="bg-surface text-ink">
                        {option.summary}
                        {option.primary ? ' (primary)' : ''}
                      </option>
                    ))}
                  </select>
                  {calendarsQuery.isError && (
                    <p className="mt-1 text-[9px] text-warning">Could not list calendars.</p>
                  )}
                </div>
                <div>
                  <label htmlFor="tasklist-select" className="mb-1 block text-[10px] font-semibold text-ink-muted">
                    Task list
                  </label>
                  <select
                    id="tasklist-select"
                    value={taskListId}
                    onChange={(event) => setTaskListId(event.target.value)}
                    disabled={!syncTasks || !settings?.tasksScopeGranted || taskListsQuery.isLoading}
                    className="input px-2.5 py-1.5 text-[11px] disabled:opacity-60"
                  >
                    {taskListOptions.length === 0 && (
                      <option value={settings?.taskListId || '@default'} className="bg-surface text-ink">
                        {settings?.taskListName || 'My Tasks'}
                      </option>
                    )}
                    {taskListOptions.map((option) => (
                      <option key={option.id} value={option.id} className="bg-surface text-ink">
                        {option.title}
                      </option>
                    ))}
                  </select>
                  {taskListsQuery.isError && (
                    <p className="mt-1 text-[9px] text-warning">Could not list task lists.</p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              {confirmDisconnect ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={disconnect.isPending}
                    onClick={() => disconnect.mutate()}
                    className="rounded-lg bg-danger px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDisconnect(false)}
                    className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold"
                  >
                    Keep connected
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDisconnect(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-danger transition-colors hover:bg-danger/10"
                >
                  <Unplug className="h-3.5 w-3.5" /> Disconnect
                </button>
              )}

              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate()}
                className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-50"
              >
                {save.isPending ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </>
        )}
      </div>
    </FloatingWindow>
  );
}

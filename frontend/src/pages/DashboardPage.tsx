import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlarmClock,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Building2,
  CalendarClock,
  FolderKanban,
  ListChecks,
  PlugZap,
  Send,
  StickyNote,
  Users,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ProductivityNotification, ProductivitySummary, TodoItem } from '../types';
import { useAuth } from '../context/AuthContext';
import { useProductivity } from '../context/ProductivityContext';
import {
  DEFAULT_TODO_LIST_TITLE,
  PRIORITY_META,
  PROJECT_COLOR_META,
  buildQuery,
  firstNameOf,
  formatClock,
  formatTimeLabel,
  formatTodayHeading,
  greetingForHour,
  localDayRange,
  productivityKeys,
  taskDateKey,
  toDateKey,
} from '../lib/productivity';

const STAT_ICON_CLASS =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-line bg-surface-2 text-ink-muted';

const AUTO_SYNC_STORAGE_KEY = 'radar_auto_sync_at';
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export function DashboardPage() {
  const { user } = useAuth();
  const { openWindows, openWindow } = useProductivity();
  const queryClient = useQueryClient();

  const [now, setNow] = useState(() => new Date());
  const todayKey = toDateKey(now);
  const today = useMemo(() => localDayRange(), [todayKey]);
  const rangeParams = buildQuery({ from: today.from, to: today.to });

  const [todoPreviewOpen, setTodoPreviewOpen] = useState(false);
  const [todoPreviewArmed, setTodoPreviewArmed] = useState(false);

  useEffect(() => {
    if (!todoPreviewOpen) return;
    // Small hover intent delay so the preview feels deliberate, not twitchy.
    const timer = window.setTimeout(() => setTodoPreviewArmed(true), 180);
    return () => window.clearTimeout(timer);
  }, [todoPreviewOpen]);

  const todoPreviewParams = buildQuery({
    filter: 'today',
    from: today.from,
    to: today.to,
    sort: 'due',
  });

  const todoPreviewQuery = useQuery({
    queryKey: productivityKeys.todos('todo-preview', todoPreviewParams),
    queryFn: () => api.get<TodoItem[]>(`/todos${todoPreviewParams}`),
    enabled: todoPreviewArmed,
    staleTime: 30_000,
  });

  const todoPreviewTasks = useMemo(() => {
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return [...(todoPreviewQuery.data || [])]
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
        return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
      })
      .slice(0, 3);
  }, [todoPreviewQuery.data]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const { data: overview, isLoading: isLoadingOverview } = useQuery<any>({
    queryKey: ['dashboard', 'analytics-overview'],
    queryFn: () => api.get<any>('/analytics/overview?range=30d').catch(() => null),
  });

  const { data: companies = [], isLoading: isLoadingCompanies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<any[]>('/companies').catch(() => []),
  });

  const productivityQuery = useQuery({
    queryKey: productivityKeys.summary(today.from, today.to),
    queryFn: () => api.get<ProductivitySummary>(`/productivity/summary${rangeParams}`),
  });

  const notificationsQuery = useQuery({
    queryKey: productivityKeys.notifications(today.from, today.to),
    queryFn: () =>
      api.get<{ count: number; notifications: ProductivityNotification[] }>(
        `/productivity/notifications${rangeParams}`
      ),
    staleTime: 60_000,
  });

  // Honor the auto-sync preference once per session, at most every five minutes.
  const autoSyncRan = useRef(false);
  useEffect(() => {
    const google = productivityQuery.data?.google;
    if (!google?.connected || !google.autoSync || autoSyncRan.current) return;
    autoSyncRan.current = true;

    let last = 0;
    try {
      last = Number(sessionStorage.getItem(AUTO_SYNC_STORAGE_KEY) || 0);
    } catch {
      last = 0;
    }
    if (Date.now() - last < AUTO_SYNC_INTERVAL_MS) return;
    try {
      sessionStorage.setItem(AUTO_SYNC_STORAGE_KEY, String(Date.now()));
    } catch {
      /* storage unavailable — still sync once this session */
    }

    api
      .post('/calendar/sync')
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['productivity'] });
        queryClient.invalidateQueries({ queryKey: ['todos'] });
      })
      .catch(() => {
        queryClient.invalidateQueries({ queryKey: ['productivity'] });
      });
  }, [productivityQuery.data, queryClient]);

  const summary = overview?.summary;
  const totalCompanies = overview?.companies?.totalTracked ?? (Array.isArray(companies) ? companies.length : 0);
  const totalContacts = overview?.contacts?.total ?? 0;
  const totalCampaigns = overview?.campaigns?.total ?? 0;
  const pendingFollowUps = summary?.pendingFollowUps ?? 0;
  const topCampaigns: any[] = Array.isArray(overview?.campaigns?.topCampaigns)
    ? overview.campaigns.topCampaigns.slice(0, 3)
    : [];
  const recentActivity: any[] = Array.isArray(overview?.activityTimeSeries)
    ? overview.activityTimeSeries
        .filter((d: any) => (d.sent ?? 0) + (d.replies ?? 0) + (d.bounces ?? 0) + (d.failures ?? 0) > 0)
        .slice(-5)
        .reverse()
    : [];

  const stats = [
    {
      label: 'Companies',
      value: totalCompanies,
      note: 'Target accounts tracked',
      icon: Building2,
      loading: isLoadingCompanies && isLoadingOverview,
    },
    {
      label: 'Contacts',
      value: totalContacts,
      note: 'People linked to accounts',
      icon: Users,
      loading: isLoadingOverview,
    },
    {
      label: 'Campaigns',
      value: totalCampaigns,
      note: 'Sequences in this workspace',
      icon: Send,
      loading: isLoadingOverview,
    },
    {
      label: 'Follow-ups',
      value: pendingFollowUps,
      note: 'Awaiting reply or action',
      icon: CalendarClock,
      loading: isLoadingOverview,
    },
  ];

  const performanceMetrics = [
    { label: 'Emails sent', value: summary?.emailsSent ?? 0, suffix: '' },
    { label: 'Replies', value: summary?.repliesReceived ?? 0, suffix: '' },
    { label: 'Reply rate', value: summary?.replyRatePercent ?? 0, suffix: '%' },
    { label: 'Delivery rate', value: summary?.deliveryRatePercent ?? 0, suffix: '%' },
  ];

  const productivityData = productivityQuery.data;
  const productivityLoading = productivityQuery.isLoading;
  const todoListSummary = productivityData?.todoList;
  const todoPreviewTitle = todoListSummary?.title || DEFAULT_TODO_LIST_TITLE;
  const showTodoPreview =
    todoPreviewOpen && !productivityLoading && !openWindows.includes('todo');
  const notificationCount = notificationsQuery.data?.count || 0;
  const google = productivityData?.google;
  const schedule = productivityData?.schedule || [];
  const initials = (user?.fullName || user?.email || 'U')
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const productivityCards = [
    {
      key: 'todo' as const,
      label: 'To-Do List',
      icon: ListChecks,
      value: productivityData?.todoList.openCount ?? 0,
      caption: productivityData
        ? `${productivityData.todoList.completedCount} of ${productivityData.todoList.totalCount} done today`
        : 'Today only',
      progress: productivityData?.todoList.progress ?? 0,
      onClick: () => openWindow('todo'),
    },
    {
      key: 'daily' as const,
      label: 'Daily Tasks',
      icon: CalendarClock,
      value: productivityData?.daily.openCount ?? 0,
      caption: productivityData
        ? `${productivityData.daily.overdueCount} overdue · ${productivityData.daily.upcomingCount} upcoming`
        : 'Across projects',
      progress: productivityData?.daily.progress ?? 0,
      onClick: () => openWindow('daily', { tab: 'tasks' }),
    },
    {
      key: 'projects' as const,
      label: 'Projects',
      icon: FolderKanban,
      value: productivityData?.projects.activeCount ?? 0,
      caption: productivityData
        ? `${productivityData.projects.openTaskCount} open tasks`
        : 'Active projects',
      progress: undefined,
      onClick: () => openWindow('daily', { tab: 'projects' }),
    },
    {
      key: 'notes' as const,
      label: 'Sticky Notes',
      icon: StickyNote,
      value: productivityData?.notes.count ?? 0,
      caption: 'Saved notes',
      progress: undefined,
      onClick: () => openWindow('daily', { tab: 'notes' }),
    },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 select-none">
      <section className="ios-card overflow-hidden p-5 sm:p-6" aria-labelledby="productivity-hero-heading">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              {formatTodayHeading(now)}
            </p>
            <h1
              id="productivity-hero-heading"
              className="mt-1.5 text-2xl font-semibold tracking-tight text-ink md:text-3xl"
            >
              {greetingForHour(now.getHours())}, {firstNameOf(user?.fullName)}.
            </h1>
            <p className="mt-1 text-xs text-ink-muted">
              {productivityData
                ? `${productivityData.todoList.openCount + productivityData.daily.openCount} open tasks · ${productivityData.daily.overdueCount} overdue · ${productivityData.notes.count} notes`
                : 'Your tasks, projects and notes in one place.'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="rounded-2xl border border-line bg-surface-2 px-3.5 py-2">
              <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
                Local time
              </p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink">
                {formatClock(now)}
              </p>
            </div>

            <button
              type="button"
              onClick={() => openWindow('notifications')}
              aria-label={`Notifications${notificationCount ? `, ${notificationCount} unread` : ''}`}
              title="Notifications"
              className="relative rounded-xl border border-line bg-surface-2 p-2.5 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <Bell className="h-4 w-4" />
              {notificationCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger px-1 text-[8px] font-semibold text-white">
                  {notificationCount > 9 ? '9+' : notificationCount}
                </span>
              )}
            </button>

            <Link
              to="/settings"
              aria-label="Profile and settings"
              title="Profile and settings"
              className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-2 text-[11px] font-semibold text-ink transition-colors hover:bg-surface-3"
            >
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                initials
              )}
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="productivity-cards-heading">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h2 id="productivity-cards-heading" className="text-sm font-semibold tracking-tight text-ink">
            Productivity
          </h2>
          <span className="text-[10px] uppercase tracking-[0.12em] text-ink-subtle">
            Realtime · {formatTodayHeading(now)}
          </span>
        </div>

        {productivityQuery.isError && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            <span>Productivity data is unavailable right now.</span>
            <button
              type="button"
              onClick={() => productivityQuery.refetch()}
              className="font-semibold underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
          {productivityCards.map((card) => {
            const Icon = card.icon;
            const content = (
              <>
                <div className="flex items-center justify-between">
                  <span className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-line bg-surface-2 text-ink-muted">
                    <Icon className="h-4 w-4" />
                  </span>
                  <ArrowUpRight className="h-3.5 w-3.5 text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-subtle">
                  {card.label}
                </p>
                <p className="mt-0.5 text-2xl font-semibold tracking-tight text-ink tabular-nums">
                  {productivityLoading ? <span className="skeleton block h-7 w-10" /> : card.value}
                </p>
                <p className="mt-1 text-[10px] text-ink-muted">{card.caption}</p>

                {typeof card.progress === 'number' && (
                  <div
                    className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={card.progress}
                    aria-label={`${card.label} progress`}
                  >
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-300"
                      style={{ width: `${card.progress}%` }}
                    />
                  </div>
                )}

                {card.key === 'projects' &&
                  productivityData &&
                  productivityData.projects.items.length > 0 && (
                    <div className="mt-2 flex items-center gap-1">
                      {productivityData.projects.items.slice(0, 4).map((project) => (
                        <span
                          key={project._id}
                          title={project.name}
                          className={clsx(
                            'h-1.5 w-1.5 rounded-full',
                            PROJECT_COLOR_META[project.color]?.swatch || 'bg-slate-400'
                          )}
                        />
                      ))}
                      {productivityData.projects.items.length > 4 && (
                        <span className="text-[9px] text-ink-subtle">
                          +{productivityData.projects.items.length - 4}
                        </span>
                      )}
                    </div>
                  )}
              </>
            );

            if (card.key === 'todo') {
              return (
                <div
                  key={card.key}
                  className="relative h-full"
                  onMouseEnter={() => setTodoPreviewOpen(true)}
                  onMouseLeave={() => setTodoPreviewOpen(false)}
                  onFocus={() => setTodoPreviewOpen(true)}
                  onBlur={() => setTodoPreviewOpen(false)}
                >
                  <button
                    type="button"
                    onClick={card.onClick}
                    aria-describedby={showTodoPreview ? 'todo-hover-preview' : undefined}
                    className="ios-card group flex h-full w-full flex-col p-4 text-left transition-transform hover:-translate-y-0.5"
                  >
                    {content}
                  </button>
                  {showTodoPreview && (
                    <TodoPreview
                      id="todo-hover-preview"
                      title={todoPreviewTitle}
                      now={now}
                      summary={todoListSummary}
                      tasks={todoPreviewTasks}
                      loading={todoPreviewQuery.isLoading}
                    />
                  )}
                </div>
              );
            }

            return (
              <button
                key={card.key}
                type="button"
                onClick={card.onClick}
                className="ios-card group flex flex-col p-4 text-left transition-transform hover:-translate-y-0.5"
              >
                {content}
              </button>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-[1.35fr_1fr]" aria-label="Schedule and Google sync">
        <div className="ios-card flex flex-col p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold tracking-tight text-ink">Today&apos;s schedule</h2>
              <p className="mt-0.5 text-[11px] text-ink-muted">Timed tasks for {today.label}</p>
            </div>
            <button
              type="button"
              onClick={() => openWindow('daily', { tab: 'tasks' })}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:text-ink"
            >
              Open Daily Tasks
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-3 flex-1">
            {productivityLoading ? (
              <div className="space-y-2">
                <div className="skeleton h-10 w-full" />
                <div className="skeleton h-10 w-full" />
              </div>
            ) : schedule.length === 0 ? (
              <div className="rounded-xl border border-line bg-surface-2 px-4 py-6 text-center">
                <AlarmClock className="mx-auto h-4 w-4 text-ink-subtle" />
                <p className="mt-2 text-[11px] text-ink-muted">No timed tasks today.</p>
                <button
                  type="button"
                  onClick={() => openWindow('daily', { tab: 'tasks' })}
                  className="mt-2 text-[10px] font-semibold text-ink underline-offset-4 hover:underline"
                >
                  Add a daily task
                </button>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {schedule.map((item) => {
                  const done = item.status === 'completed';
                  const dueKey = taskDateKey(item.dueDate);
                  const target =
                    !dueKey || dueKey <= todayKey ? ('todo' as const) : ('daily' as const);
                  return (
                    <li key={item._id}>
                      <button
                        type="button"
                        onClick={() => openWindow(target, { taskId: item._id })}
                        className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-left transition-colors hover:bg-surface-3"
                      >
                        <span className="w-14 shrink-0 text-[10px] font-medium tabular-nums text-ink-muted">
                          {formatTimeLabel(item.scheduledTime)}
                        </span>
                        <span
                          className={clsx(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            done ? 'bg-success' : 'bg-accent'
                          )}
                        />
                        <span
                          className={clsx(
                            'min-w-0 flex-1 truncate text-xs',
                            done ? 'text-ink-subtle line-through' : 'text-ink'
                          )}
                        >
                          {item.title}
                        </span>
                        <span className="shrink-0 rounded-full border border-line bg-surface px-1.5 py-0.5 text-[9px] text-ink-subtle">
                          {target === 'daily' ? 'Daily' : 'To-do'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="ios-card flex flex-col p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-ink">Google sync</h2>
            <span
              className={clsx(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold',
                google?.connected ? 'badge-success' : 'badge-neutral'
              )}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {google?.connected ? 'Connected' : 'Not connected'}
            </span>
          </div>

          {productivityLoading ? (
            <div className="mt-3 space-y-2">
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-4 w-28" />
            </div>
          ) : google?.connected ? (
            <>
              <p className="mt-2 truncate text-[11px] font-medium text-ink">{google.email}</p>
              <p className="mt-0.5 text-[10px] text-ink-muted">
                Tasks {google.syncTasks ? 'on' : 'off'} · Calendar{' '}
                {google.syncCalendar ? 'on' : 'off'} · Meet {google.syncMeet ? 'on' : 'off'} · Auto{' '}
                {google.autoSync ? 'on' : 'off'}
              </p>
              <p className="mt-0.5 text-[10px] text-ink-subtle">
                {google.lastSyncedAt
                  ? `Last synced ${new Date(google.lastSyncedAt).toLocaleString()}`
                  : 'Not synced yet'}
              </p>
              {google.lastSyncError && (
                <p className="mt-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-warning">
                  {google.lastSyncError}
                </p>
              )}
            </>
          ) : (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
              Connect Google to sync tasks, reserve calendar time for scheduled work, and add
              Google Meet links when you request a meeting.
            </p>
          )}

          <button
            type="button"
            onClick={() => openWindow('integration')}
            className="ios-btn-secondary mt-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-semibold"
          >
            <PlugZap className="h-3.5 w-3.5" />
            {google?.connected ? 'Manage integration' : 'Connect Google'}
          </button>
        </div>
      </section>

      <section aria-labelledby="workspace-stats-heading">
        <h2 id="workspace-stats-heading" className="sr-only">
          Workspace statistics
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
          {stats.map(({ label, value, note, icon: Icon, loading }) => (
            <div key={label} className="ios-card p-5">
              <div className="flex items-start justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  {label}
                </span>
                <span className={STAT_ICON_CLASS}>
                  <Icon className="h-4 w-4" />
                </span>
              </div>
              <div className="mt-4 text-3xl font-semibold tracking-tight text-ink tabular-nums">
                {loading ? <div className="skeleton h-9 w-16" /> : value.toLocaleString()}
              </div>
              <p className="mt-1.5 text-[11px] text-ink-muted">{note}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="ios-card space-y-4 p-6" aria-labelledby="performance-overview-heading">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-line pb-3">
          <div>
            <h2
              id="performance-overview-heading"
              className="text-base font-semibold tracking-tight text-ink"
            >
              Performance overview
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              Last 30 days · verified sends, replies and delivery
            </p>
          </div>
          <Link
            to="/analytics"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
          >
            <span>Open analytics</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {performanceMetrics.map((metric) => (
            <div key={metric.label} className="rounded-2xl border border-line bg-surface-2 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
                {metric.label}
              </div>
              <div className="mt-2 text-2xl font-semibold tracking-tight text-ink tabular-nums">
                {isLoadingOverview ? (
                  <div className="skeleton h-7 w-12" />
                ) : (
                  `${metric.value.toLocaleString()}${metric.suffix}`
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-5 pt-1 xl:grid-cols-2">
          <div>
            <div className="flex items-center justify-between pb-2">
              <h3 className="text-xs font-semibold text-ink">Campaign performance</h3>
              <Link to="/campaigns" className="text-[11px] font-medium text-ink-muted hover:text-ink">
                View all
              </Link>
            </div>

            {isLoadingOverview ? (
              <div className="space-y-2">
                <div className="skeleton h-10 w-full" />
                <div className="skeleton h-10 w-full" />
              </div>
            ) : topCampaigns.length === 0 ? (
              <p className="rounded-2xl border border-line bg-surface-2 p-4 text-[11px] text-ink-muted">
                No campaign sends in this period yet. Launch a campaign to see performance here.
              </p>
            ) : (
              <div className="divide-y divide-line/60 overflow-hidden rounded-2xl border border-line bg-surface-2">
                {topCampaigns.map((campaign) => (
                  <Link
                    key={campaign._id}
                    to={`/campaigns/${campaign._id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-surface-3"
                  >
                    <span className="min-w-0 truncate text-xs font-medium text-ink">
                      {campaign.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-3 text-[11px] text-ink-muted tabular-nums">
                      <span>{campaign.sent ?? 0} sent</span>
                      <span>{campaign.replied ?? 0} replies</span>
                      <span className="font-semibold text-ink">{campaign.replyRatePercent ?? 0}%</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between pb-2">
              <h3 className="text-xs font-semibold text-ink">Recent activity</h3>
              <span className="text-[11px] text-ink-muted">Last 30 days</span>
            </div>

            {isLoadingOverview ? (
              <div className="space-y-2">
                <div className="skeleton h-10 w-full" />
                <div className="skeleton h-10 w-full" />
              </div>
            ) : recentActivity.length === 0 ? (
              <p className="rounded-2xl border border-line bg-surface-2 p-4 text-[11px] text-ink-muted">
                No outreach activity recorded in the last 30 days.
              </p>
            ) : (
              <div className="divide-y divide-line/60 overflow-hidden rounded-2xl border border-line bg-surface-2">
                {recentActivity.map((day) => (
                  <div
                    key={day.date}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-[11px] text-ink-muted tabular-nums"
                  >
                    <span className="font-medium text-ink">{day.displayDate}</span>
                    <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                      {day.sent > 0 && <span>{day.sent} sent</span>}
                      {day.replies > 0 && <span>{day.replies} replies</span>}
                      {day.bounces > 0 && <span>{day.bounces} bounces</span>}
                      {day.failures > 0 && <span>{day.failures} failed</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="ios-card space-y-4 p-6" aria-labelledby="outreach-workflow-heading">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-line pb-3">
          <div>
            <h2 id="outreach-workflow-heading" className="text-base font-semibold tracking-tight text-ink">
              Outreach workflow
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              From prospect CSV discovery to Gmail delivery
            </p>
          </div>
          <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[10px] uppercase tracking-wider text-ink-muted">
            Guided pipeline
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 pt-1 md:grid-cols-4">
          {[
            {
              step: '01',
              title: 'CSV Ingestion',
              desc: 'Formula injection defense and rating normalization',
              to: '/csv-imports',
            },
            {
              step: '02',
              title: 'Opportunity Scoring',
              desc: 'Rule-based matching against your service catalog',
              to: '/opportunities',
            },
            {
              step: '03',
              title: 'AI Email Studio',
              desc: 'Grounded composition with explicit fact checks',
              to: '/ai-studio',
            },
            {
              step: '04',
              title: 'Gmail API Send',
              desc: 'Encrypted token dispatch with quota enforcement',
              to: '/email',
            },
          ].map((item) => (
            <Link
              key={item.step}
              to={item.to}
              className="group block rounded-2xl border border-line bg-surface-2 p-4 transition-all hover:border-line-strong hover:bg-surface-3 active:scale-[0.98]"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold tracking-wider text-ink-subtle">
                  STEP {item.step}
                </span>
                <ArrowRight className="h-3.5 w-3.5 text-ink-subtle transition-all group-hover:translate-x-0.5 group-hover:text-ink" />
              </div>
              <h3 className="text-xs font-semibold text-ink">{item.title}</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{item.desc}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

interface TodoPreviewProps {
  id: string;
  title: string;
  now: Date;
  summary?: ProductivitySummary['todoList'];
  tasks: TodoItem[];
  loading: boolean;
}

/**
 * Hover summary for the To-Do card. It is intentionally smaller than the
 * floating To-Do window and never interactive: clicking the card opens the
 * real window.
 */
function TodoPreview({ id, title, now, summary, tasks, loading }: TodoPreviewProps) {
  const total = summary?.totalCount ?? 0;
  const completed = summary?.completedCount ?? 0;
  const pending = Math.max(0, total - completed);
  const progress = summary?.progress ?? 0;

  return (
    <div
      id={id}
      role="tooltip"
      className="pointer-events-none absolute left-0 top-full z-40 mt-2 hidden w-[19rem] max-w-[calc(100vw-2rem)] sm:block"
    >
      <div className="floating-utility animate-window-in rounded-2xl border border-line/80 p-3.5 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
              Today&apos;s list
            </p>
            <p className="mt-0.5 truncate text-xs font-semibold text-ink">{title}</p>
          </div>
          <span className="shrink-0 text-[10px] text-ink-muted">{formatTodayHeading(now)}</span>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {[
            { label: 'Total', value: total },
            { label: 'Done', value: completed },
            { label: 'Pending', value: pending },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-lg border border-line/70 bg-surface-2/80 px-2 py-1.5 text-center"
            >
              <p className="text-[13px] font-semibold leading-none tabular-nums text-ink">
                {item.value}
              </p>
              <p className="mt-1 text-[9px] uppercase tracking-wide text-ink-subtle">
                {item.label}
              </p>
            </div>
          ))}
        </div>

        <ul className="mt-2 space-y-1">
          {loading ? (
            [0, 1].map((row) => (
              <li key={row} className="h-7 animate-pulse rounded-lg border border-line/70 bg-surface-2" />
            ))
          ) : tasks.length === 0 ? (
            <li className="rounded-lg border border-line/70 bg-surface-2/70 px-2 py-1.5 text-[11px] text-ink-muted">
              No tasks for today.
            </li>
          ) : (
            tasks.map((task) => {
              const meta = PRIORITY_META[task.priority] || PRIORITY_META.medium;
              const done = task.status === 'completed';
              return (
                <li
                  key={task._id}
                  className="flex items-center gap-2 rounded-lg border border-line/70 bg-surface-2/70 px-2 py-1.5"
                >
                  <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', meta.dot)} />
                  <span
                    className={clsx(
                      'min-w-0 flex-1 truncate text-[11px]',
                      done ? 'text-ink-subtle line-through' : 'text-ink'
                    )}
                  >
                    {task.title}
                  </span>
                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-ink-subtle">
                    {meta.label}
                  </span>
                </li>
              );
            })
          )}
        </ul>

        <div className="mt-2 flex items-center gap-2">
          <div
            className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="Today's task progress preview"
          >
            <div
              className="h-full rounded-full bg-success transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="shrink-0 text-[9px] tabular-nums text-ink-subtle">{progress}%</span>
        </div>

        <p className="mt-2 text-[9px] text-ink-subtle">Click the card to open the list.</p>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  Bell,
  CalendarCheck2,
  CalendarClock,
  CheckCircle2,
  FolderKanban,
  ListChecks,
  ListTodo,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  StickyNote,
  Video,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import type { ProductivityProject, TodoItem } from '../../types';
import type { DailyTab } from '../../context/ProductivityContext';
import { useProductivity } from '../../context/ProductivityContext';
import {
  DEFAULT_TODO_LIST_TITLE,
  PRIORITY_META,
  PROJECT_COLOR_META,
  buildQuery,
  formatDueLabel,
  formatTimeRange,
  groupTasksByDate,
  isTaskOverdue,
  isValidMeetLink,
  localDayRange,
  productivityKeys,
  subtaskProgress,
  taskDateKey,
  toDateKey,
} from '../../lib/productivity';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { FloatingWindow } from './FloatingWindow';
import { TaskFormModal } from './TaskFormModal';
import { TodoActionsWindow } from './TodoActionsWindow';
import { ProjectsTab } from './daily/ProjectsTab';
import { NotesTab } from './daily/NotesTab';

type TaskFilter = 'all' | 'today' | 'upcoming' | 'overdue' | 'completed';
type SortKey = 'priority' | 'due' | 'created' | 'title';
type PanelVariant = 'tasks' | 'upcoming' | 'completed';

const TABS: Array<{ value: DailyTab; label: string; icon: ComponentType<{ className?: string }> }> = [
  { value: 'tasks', label: 'Tasks', icon: ListTodo },
  { value: 'projects', label: 'Projects', icon: FolderKanban },
  { value: 'notes', label: 'Notes', icon: StickyNote },
  { value: 'upcoming', label: 'Upcoming', icon: CalendarClock },
  { value: 'completed', label: 'Completed', icon: CheckCircle2 },
];

const FILTERS: Array<{ value: TaskFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'completed', label: 'Completed' },
];

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'priority', label: 'Priority' },
  { value: 'due', label: 'Due date' },
  { value: 'created', label: 'Newest' },
  { value: 'title', label: 'Alphabetical' },
];


/**
 * Daily Tasks workspace. Everything happens inside one floating window with
 * internal tabs, so the dashboard URL never changes.
 */
export function DailyTasksWindow() {
  const { isWindowOpen, closeWindow, bringToFront, dailyTab, setDailyTab, openWindows } =
    useProductivity();
  const open = isWindowOpen('daily');
  const todoOpen = openWindows.includes('todo');
  const [error, setError] = useState('');

  const switchTab = (tab: DailyTab) => {
    setError('');
    setDailyTab(tab);
  };

  return (
    <FloatingWindow
      open={open}
      onClose={() => closeWindow('daily')}
      onActivate={() => bringToFront('daily')}
      size="daily"
      defaultRight={todoOpen ? 508 : 96}
      defaultTop={88}
      icon={CalendarCheck2}
      title="Daily Tasks"
      subtitle="Projects, notes and everything you are planning."
    >
      <div
        role="tablist"
        aria-label="Daily tasks sections"
        className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-line/70 bg-surface/85 px-2.5 py-2 backdrop-blur-xl"
      >
        {TABS.map((tab) => {
          const TabIcon = tab.icon;
          const active = dailyTab === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => switchTab(tab.value)}
              className={clsx(
                'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
                active
                  ? 'bg-surface-3 text-ink shadow-sm ring-1 ring-line'
                  : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
              )}
            >
              <TabIcon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="px-3 pt-3 sm:px-4">
          <p className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            {error}
          </p>
        </div>
      )}

      {dailyTab === 'projects' ? (
        <ProjectsTab onError={setError} />
      ) : dailyTab === 'notes' ? (
        <NotesTab onError={setError} />
      ) : (
        <TasksPanel variant={dailyTab as PanelVariant} onError={setError} />
      )}
    </FloatingWindow>
  );
}

interface TasksPanelProps {
  variant: PanelVariant;
  onError: (message: string) => void;
}

function TasksPanel({ variant, onError }: TasksPanelProps) {
  const queryClient = useQueryClient();
  const { focusedTaskId } = useProductivity();
  const today = useMemo(() => localDayRange(), []);

  const [filter, setFilter] = useState<TaskFilter>('all');
  const [sort, setSort] = useState<SortKey>('priority');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);

  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TodoItem | null>(null);
  const [actionsTask, setActionsTask] = useState<TodoItem | null>(null);

  const effectiveFilter: TaskFilter =
    variant === 'upcoming' ? 'upcoming' : variant === 'completed' ? 'completed' : filter;

  const params = buildQuery({
    filter: effectiveFilter === 'all' ? undefined : effectiveFilter,
    q: q || undefined,
    sort,
    from:
      effectiveFilter === 'today' ||
      effectiveFilter === 'upcoming' ||
      effectiveFilter === 'overdue'
        ? today.from
        : undefined,
    to:
      effectiveFilter === 'today' ||
      effectiveFilter === 'upcoming' ||
      effectiveFilter === 'overdue'
        ? today.to
        : undefined,
  });

  const tasksQuery = useQuery({
    queryKey: productivityKeys.todos('daily', params),
    queryFn: () => api.get<TodoItem[]>(`/todos${params}`),
  });

  const projectsQuery = useQuery({
    queryKey: productivityKeys.projects(false),
    queryFn: () => api.get<ProductivityProject[]>('/projects'),
    enabled: formOpen,
  });

  const tasks = useMemo(() => {
    const rows = [...(tasksQuery.data || [])];
    if (variant === 'completed' || effectiveFilter === 'completed') {
      return rows.sort(
        (a, b) =>
          new Date(b.completedAt || b.updatedAt).getTime() -
          new Date(a.completedAt || a.updatedAt).getTime()
      );
    }
    return rows;
  }, [tasksQuery.data, variant, effectiveFilter]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['productivity'] });
    queryClient.invalidateQueries({ queryKey: ['todos'] });
  };

  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'open' | 'completed' }) =>
      api.patch<TodoItem>(`/todos/${id}`, { status }),
    onSuccess: () => {
      onError('');
      invalidate();
    },
    onError: (err: Error) => onError(err.message),
  });

  useEffect(() => {
    if (!focusedTaskId) return;
    const element = document.getElementById(`daily-task-${focusedTaskId}`);
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusedTaskId, tasks]);

  const openCreate = () => {
    setEditingTask(null);
    setFormOpen(true);
  };

  const openEdit = (task: TodoItem) => {
    setActionsTask(null);
    setEditingTask(task);
    setFormOpen(true);
  };

  const groups = useMemo(
    () => (variant === 'upcoming' ? groupTasksByDate(tasks) : []),
    [tasks, variant]
  );

  const emptyCopy =
    variant === 'upcoming'
      ? { title: 'No upcoming tasks yet.', hint: 'Schedule something and it will appear here, grouped by date.' }
      : variant === 'completed'
        ? { title: 'No completed tasks yet.', hint: 'Finished work will collect here so you can restore it if needed.' }
        : effectiveFilter === 'today'
          ? { title: 'Nothing due today.', hint: 'Add a task or check the Upcoming tab.' }
          : effectiveFilter === 'overdue'
            ? { title: 'Nothing overdue.', hint: 'You are all caught up.' }
            : effectiveFilter === 'completed'
              ? { title: 'No completed tasks yet.', hint: 'Finished work will collect here.' }
              : { title: 'No tasks here yet.', hint: 'Add your first daily task to start planning.' };

  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative min-w-[170px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tasks, tags, categories…"
            aria-label="Search daily tasks"
            className="input px-3 py-1.5 pl-8 text-[11px]"
          />
        </div>
        <div className="flex items-center gap-2">
          {variant !== 'completed' && (
            <button
              type="button"
              onClick={openCreate}
              className="ios-btn-primary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold"
            >
              <Plus className="h-3.5 w-3.5" /> Add task
            </button>
          )}
        </div>
      </div>

      {variant === 'tasks' && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {FILTERS.map((option) => {
              const active = filter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(option.value)}
                  className={clsx(
                    'rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-colors',
                    active
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-line bg-surface-2 text-ink-muted hover:text-ink'
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {filter !== 'completed' && (
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              aria-label="Sort tasks"
              className="input w-auto px-2 py-1 text-[10px]"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-surface text-ink">
                  Sort: {option.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className="mt-3">
        {tasksQuery.isLoading ? (
          <ul className="space-y-2" aria-hidden="true">
            {[0, 1, 2, 3].map((row) => (
              <li
                key={row}
                className="h-[64px] animate-pulse rounded-xl border border-line bg-surface-2"
              />
            ))}
          </ul>
        ) : tasksQuery.isError ? (
          <div className="empty-state gap-3 px-4 py-10">
            <p className="text-xs">Could not load tasks right now.</p>
            <button
              type="button"
              onClick={() => tasksQuery.refetch()}
              className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold"
            >
              Try again
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <div className="empty-state gap-2.5 px-4 py-10">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface-2 text-ink-subtle">
              <CalendarCheck2 className="h-5 w-5" />
            </span>
            <p className="text-xs font-medium">{emptyCopy.title}</p>
            <p className="max-w-xs text-[11px] text-ink-subtle">{emptyCopy.hint}</p>
            {variant !== 'completed' && (
              <button
                type="button"
                onClick={openCreate}
                className="ios-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold"
              >
                <Plus className="h-3.5 w-3.5" /> Add a task
              </button>
            )}
          </div>
        ) : variant === 'upcoming' ? (
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group.key}>
                <h3 className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
                  <span className="h-px flex-1 bg-line" />
                  {group.label}
                  <span className="h-px flex-1 bg-line" />
                </h3>
                <ul className="space-y-1.5">
                  {group.tasks.map((task) => (
                    <DailyTaskRow
                      key={task._id}
                      task={task}
                      busy={toggle.isPending}
                      focused={task._id === focusedTaskId}
                      onToggle={(target) =>
                        toggle.mutate({
                          id: target._id,
                          status: target.status === 'completed' ? 'open' : 'completed',
                        })
                      }
                      onActions={setActionsTask}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {tasks.map((task) => (
              <DailyTaskRow
                key={task._id}
                task={task}
                busy={toggle.isPending}
                focused={task._id === focusedTaskId}
                showCompletedDate={variant === 'completed' || effectiveFilter === 'completed'}
                onToggle={(target) =>
                  toggle.mutate({
                    id: target._id,
                    status: target.status === 'completed' ? 'open' : 'completed',
                  })
                }
                onActions={setActionsTask}
              />
            ))}
          </ul>
        )}
      </div>

      <TaskFormModal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditingTask(null);
        }}
        mode="daily"
        task={editingTask}
        projects={projectsQuery.data || []}
        defaultDueDate={toDateKey()}
        defaultListTitle={DEFAULT_TODO_LIST_TITLE}
      />

      <TodoActionsWindow
        task={actionsTask}
        onClose={() => setActionsTask(null)}
        onEdit={openEdit}
        timeLabel="Scheduled time"
      />
    </div>
  );
}

interface DailyTaskRowProps {
  task: TodoItem;
  busy: boolean;
  focused: boolean;
  showCompletedDate?: boolean;
  onToggle: (task: TodoItem) => void;
  onActions: (task: TodoItem) => void;
}

function DailyTaskRow({
  task,
  busy,
  focused,
  showCompletedDate,
  onToggle,
  onActions,
}: DailyTaskRowProps) {
  const meta = PRIORITY_META[task.priority] || PRIORITY_META.medium;
  const projectMeta = task.project ? PROJECT_COLOR_META[task.project.color] : null;
  const done = task.status === 'completed';
  const overdue = isTaskOverdue(task);
  const dueLabel = formatDueLabel(task.dueDate);
  const subtasks = subtaskProgress(task);
  const tags = task.tags || [];

  return (
    <li
      id={`daily-task-${task._id}`}
      className={clsx(
        'group flex items-start gap-2.5 rounded-xl border px-2.5 py-2.5 transition-colors',
        focused
          ? 'border-accent/60 bg-accent/5 ring-1 ring-accent/25'
          : 'border-line bg-surface-2 hover:bg-surface-3'
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        disabled={busy}
        onClick={() => onToggle(task)}
        className={clsx(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-60',
          done
            ? 'border-success bg-success text-white'
            : 'border-line-strong bg-surface hover:border-success'
        )}
      >
        {done && (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
            <path
              d="M2.5 6.2 4.8 8.5 9.5 3.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p
              className={clsx(
                'truncate text-xs font-medium',
                done ? 'text-ink-subtle line-through' : 'text-ink'
              )}
              title={task.title}
            >
              {task.title}
            </p>
            {task.description && (
              <p className="mt-0.5 line-clamp-1 text-[10px] text-ink-muted">{task.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onActions(task)}
            aria-label={`Actions for ${task.title}`}
            className="shrink-0 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface hover:text-ink"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={clsx(
              'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
              meta.badge
            )}
          >
            {meta.label}
          </span>

          {dueLabel && (
            <span
              className={clsx(
                'inline-flex items-center gap-1 text-[10px]',
                overdue ? 'font-semibold text-danger' : 'text-ink-muted'
              )}
            >
              {overdue ? `${dueLabel} · overdue` : dueLabel}
            </span>
          )}

          {task.scheduledTime && (
            <span className="inline-flex items-center gap-1 text-[10px] text-ink-muted">
              <AlarmClock className="h-3 w-3" />
              {formatTimeRange(task.scheduledTime, task.scheduledEndTime)}
            </span>
          )}

          {isValidMeetLink(task.googleMeetLink) && (
            <a
              href={task.googleMeetLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold text-accent transition-colors hover:bg-accent/20"
            >
              <Video className="h-2.5 w-2.5" />
              Join meeting
            </a>
          )}

          {task.reminderEnabled && (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-ink-muted"
              title="Reminder on"
            >
              <Bell className="h-3 w-3" />
            </span>
          )}

          {subtasks.total > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-ink-muted">
              <ListChecks className="h-3 w-3" />
              {subtasks.done}/{subtasks.total}
            </span>
          )}

          {task.project && projectMeta && (
            <span className="inline-flex items-center gap-1 text-[10px] text-ink-muted">
              <span className={clsx('h-1.5 w-1.5 rounded-full', projectMeta.swatch)} />
              {task.project.name}
            </span>
          )}

          {task.category && (
            <span className="rounded-full border border-line bg-surface px-1.5 py-0.5 text-[9px] text-ink-muted">
              {task.category}
            </span>
          )}

          {tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-line bg-surface px-1.5 py-0.5 text-[9px] text-ink-subtle"
            >
              #{tag}
            </span>
          ))}
        </div>

        {showCompletedDate && task.completedAt && (
          <div className="mt-1 flex items-center gap-2">
            <p className="inline-flex items-center gap-1 text-[9px] text-ink-subtle">
              <RotateCcw className="h-2.5 w-2.5" />
              Completed{' '}
              {new Date(task.completedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
              {taskDateKey(task.completedAt) === toDateKey() ? ' · today' : ''}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => onToggle(task)}
              className="text-[9px] font-semibold text-accent transition-opacity hover:underline disabled:opacity-60"
            >
              Restore
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

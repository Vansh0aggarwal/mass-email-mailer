import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  Bell,
  CheckCircle2,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Plus,
  Video,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import type { TodoItem, TodoListSettings } from '../../types';
import {
  DEFAULT_TODO_LIST_TITLE,
  PRIORITY_META,
  buildQuery,
  formatTimeRange,
  formatTodayHeading,
  isValidMeetLink,
  localDayRange,
  productivityKeys,
} from '../../lib/productivity';
import { useProductivity } from '../../context/ProductivityContext';
import { FloatingWindow } from './FloatingWindow';
import { TaskFormModal } from './TaskFormModal';
import { TodoActionsWindow } from './TodoActionsWindow';

const EMPTY_COPY = 'No tasks for today. Enjoy your free time!';

/**
 * The simple, always-today To-Do list. It is a floating window rather than a
 * route so opening it never navigates away from the dashboard.
 */
export function TodoWindow() {
  const queryClient = useQueryClient();
  const { isWindowOpen, closeWindow, bringToFront, focusedTaskId } = useProductivity();
  const open = isWindowOpen('todo');

  const today = useMemo(() => localDayRange(), []);
  const params = buildQuery({
    filter: 'today',
    from: today.from,
    to: today.to,
    sort: 'due',
  });

  const settingsQuery = useQuery({
    queryKey: productivityKeys.settings,
    queryFn: () => api.get<TodoListSettings>('/todos/settings'),
    enabled: open,
  });

  const tasksQuery = useQuery({
    queryKey: productivityKeys.todos('todo-today', params),
    queryFn: () => api.get<TodoItem[]>(`/todos${params}`),
    enabled: open,
  });

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [listError, setListError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TodoItem | null>(null);
  const [actionsTask, setActionsTask] = useState<TodoItem | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const title = settingsQuery.data?.title || DEFAULT_TODO_LIST_TITLE;
  const tasks = useMemo(() => {
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return [...(tasksQuery.data || [])].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
    });
  }, [tasksQuery.data]);

  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const totalCount = tasks.length;
  const pendingCount = totalCount - completedCount;
  const progress = totalCount ? Math.round((completedCount / totalCount) * 100) : 0;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['productivity'] });
    queryClient.invalidateQueries({ queryKey: ['todos'] });
  };

  const rename = useMutation({
    mutationFn: (next: string) =>
      api.patch<TodoListSettings>('/todos/settings', { title: next }),
    onSuccess: () => {
      setEditingName(false);
      setRenameError('');
      queryClient.invalidateQueries({ queryKey: productivityKeys.settings });
      queryClient.invalidateQueries({ queryKey: ['productivity'] });
    },
    onError: (err: Error) => setRenameError(err.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'open' | 'completed' }) =>
      api.patch<TodoItem>(`/todos/${id}`, { status }),
    onSuccess: () => {
      setListError('');
      invalidate();
    },
    onError: (err: Error) => setListError(err.message),
  });

  useEffect(() => {
    if (editingName) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [editingName]);

  useEffect(() => {
    if (!open || !focusedTaskId) return;
    const element = document.getElementById(`todo-task-${focusedTaskId}`);
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open, focusedTaskId, tasks]);

  const startRename = () => {
    setNameDraft(title);
    setRenameError('');
    setEditingName(true);
  };

  const commitRename = () => {
    const next = nameDraft.trim();
    if (!next || next === title) {
      setEditingName(false);
      return;
    }
    rename.mutate(next);
  };

  const openCreate = () => {
    setEditingTask(null);
    setFormOpen(true);
  };

  const openEdit = (task: TodoItem) => {
    setActionsTask(null);
    setEditingTask(task);
    setFormOpen(true);
  };

  return (
    <>
      <FloatingWindow
        open={open}
        onClose={() => closeWindow('todo')}
        onActivate={() => bringToFront('todo')}
        size="todo"
        defaultRight={96}
        defaultTop={88}
        icon={ListChecks}
        title={
          editingName ? (
            <input
              ref={nameRef}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditingName(false);
                }
              }}
              maxLength={80}
              aria-label="To-Do list name"
              className="w-full min-w-[10rem] rounded-md border border-line bg-surface-2 px-2 py-1 text-sm font-semibold text-ink outline-none focus:border-accent"
            />
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {title}
              <button
                type="button"
                onClick={startRename}
                aria-label="Rename list"
                title="Rename list"
                className="rounded-md p-1 text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </span>
          )
        }
        subtitle={`${formatTodayHeading()} · only today's tasks`}
        headerActions={
          <button
            type="button"
            onClick={openCreate}
            aria-label="Add task"
            title="Add task"
            className="ios-btn-primary flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold sm:px-3"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Add</span>
          </button>
        }
        footer={
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="font-semibold text-ink">
                Today&apos;s Progress: {completedCount}/{totalCount} completed
              </span>
              <span className="shrink-0 tabular-nums text-ink-subtle">
                {pendingCount} left · {progress}%
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-label="Today's task progress"
            >
              <div
                className="h-full rounded-full bg-success transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        }
      >
        <div className="px-3 py-3 sm:px-4">
          {renameError && (
            <p className="mb-3 rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
              {renameError}
            </p>
          )}
          {listError && (
            <p className="mb-3 rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
              {listError}
            </p>
          )}

          {tasksQuery.isLoading ? (
            <ul className="space-y-2" aria-hidden="true">
              {[0, 1, 2].map((row) => (
                <li
                  key={row}
                  className="h-[58px] animate-pulse rounded-xl border border-line bg-surface-2"
                />
              ))}
            </ul>
          ) : tasksQuery.isError ? (
            <div className="empty-state gap-3 px-4 py-12">
              <p className="text-xs">Could not load your tasks right now.</p>
              <button
                type="button"
                onClick={() => tasksQuery.refetch()}
                className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold"
              >
                Try again
              </button>
            </div>
          ) : tasks.length === 0 ? (
            <div className="empty-state gap-3 px-4 py-12">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface-2 text-ink-subtle">
                <CheckCircle2 className="h-5 w-5" />
              </span>
              <p className="text-xs font-medium">{EMPTY_COPY}</p>
              <button
                type="button"
                onClick={openCreate}
                className="ios-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold"
              >
                <Plus className="h-3.5 w-3.5" /> Add a task
              </button>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {tasks.map((task) => {
                const meta = PRIORITY_META[task.priority] || PRIORITY_META.medium;
                const isDone = task.status === 'completed';
                const focused = task._id === focusedTaskId;
                return (
                  <li
                    key={task._id}
                    id={`todo-task-${task._id}`}
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
                      aria-checked={isDone}
                      aria-label={isDone ? `Reopen ${task.title}` : `Complete ${task.title}`}
                      disabled={toggle.isPending}
                      onClick={() =>
                        toggle.mutate({ id: task._id, status: isDone ? 'open' : 'completed' })
                      }
                      className={clsx(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-60',
                        isDone
                          ? 'border-success bg-success text-white'
                          : 'border-line-strong bg-surface hover:border-success'
                      )}
                    >
                      {isDone && (
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
                      <p
                        className={clsx(
                          'truncate text-xs font-medium',
                          isDone ? 'text-ink-subtle line-through' : 'text-ink'
                        )}
                        title={task.title}
                      >
                        {task.title}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span
                          className={clsx(
                            'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                            meta.badge
                          )}
                        >
                          {meta.label}
                        </span>
                        {task.scheduledTime && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-ink-muted">
                            <AlarmClock className="h-3 w-3" />
                            {formatTimeRange(task.scheduledTime, task.scheduledEndTime)}
                          </span>
                        )}
                        {task.reminderEnabled && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] text-ink-muted"
                            title="Reminder on"
                          >
                            <Bell className="h-3 w-3" />
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
                            Join
                          </a>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setActionsTask(task)}
                      aria-label={`Actions for ${task.title}`}
                      className="rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface hover:text-ink"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </FloatingWindow>

      <TaskFormModal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditingTask(null);
        }}
        mode="todo"
        task={editingTask}
        defaultDueDate={today.key}
        defaultListTitle={title}
      />

      <TodoActionsWindow
        task={actionsTask}
        onClose={() => setActionsTask(null)}
        onEdit={openEdit}
      />
    </>
  );
}

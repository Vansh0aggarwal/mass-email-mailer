import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  Bell,
  CheckCircle2,
  Pencil,
  RotateCcw,
  Trash2,
  Video,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import type { TodoItem, TodoPriority } from '../../types';
import { PRIORITY_META, isValidMeetLink } from '../../lib/productivity';
import { FloatingWindow } from './FloatingWindow';

interface TodoActionsWindowProps {
  task: TodoItem | null;
  onClose: () => void;
  onEdit: (task: TodoItem) => void;
  timeLabel?: string;
}

const PRIORITY_ORDER: TodoPriority[] = ['high', 'medium', 'low'];

const REMINDER_OPTIONS = [
  { value: 0, label: 'At the time' },
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
];

/**
 * Small nested window opened by a task's three-dot control. Keeping it inside
 * the floating-window layer stack means Escape, backdrop clicks and focus stay
 * predictable while the To-Do window remains open underneath.
 */
export function TodoActionsWindow({
  task,
  onClose,
  onEdit,
  timeLabel = 'Completion time',
}: TodoActionsWindowProps) {
  const queryClient = useQueryClient();
  const timeRef = useRef<HTMLInputElement>(null);
  const [priority, setPriority] = useState<TodoPriority>('medium');
  const [scheduledTime, setScheduledTime] = useState('');
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderMinutes, setReminderMinutes] = useState(10);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!task) return;
    setPriority(task.priority || 'medium');
    setScheduledTime(task.scheduledTime || '');
    setReminderEnabled(task.reminderEnabled || false);
    setReminderMinutes(task.reminderMinutes ?? 10);
    setConfirmDelete(false);
    setWarning('');
    setError('');
    // Reset only when a different task is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?._id]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['productivity'] });
    queryClient.invalidateQueries({ queryKey: ['todos'] });
  };

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<TodoItem>(`/todos/${task!._id}`, body),
    onSuccess: (result, variables) => {
      invalidate();
      if (result.sync && !result.sync.synced && result.sync.warning) {
        setWarning(result.sync.warning);
      }
      // Inline tweaks (priority, time, reminder) keep the panel open so several
      // can be adjusted in a row; completion and reopening dismiss it.
      if ('status' in variables) onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.delete<{ id: string }>(`/todos/${task!._id}`),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!task) return null;

  const completed = task.status === 'completed';
  const busy = patch.isPending || remove.isPending;

  return (
    <FloatingWindow
      open
      onClose={onClose}
      size="compact"
      modal
      icon={CheckCircle2}
      title="Task actions"
      subtitle={task.title}
    >
      <div className="space-y-4 px-4 py-4 sm:px-5">
        {error && (
          <p className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            {error}
          </p>
        )}
        {warning && (
          <p className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] text-warning">
            Saved locally. Google sync warning: {warning}
          </p>
        )}

        <button
          type="button"
          onClick={() => onEdit(task)}
          className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-left text-xs font-medium text-ink transition-colors hover:bg-surface-3"
        >
          <Pencil className="h-3.5 w-3.5 text-ink-subtle" />
          Edit name and details
        </button>

        {isValidMeetLink(task.googleMeetLink) && (
          <a
            href={task.googleMeetLink}
            target="_blank"
            rel="noreferrer"
            className="flex w-full items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2.5 text-left text-xs font-semibold text-accent transition-colors hover:bg-accent/20"
          >
            <Video className="h-3.5 w-3.5" />
            Join meeting
          </a>
        )}

        <div>
          <span className="mb-1.5 block text-[11px] font-semibold text-ink-muted">Priority</span>
          <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-line bg-surface-2 p-1">
            {PRIORITY_ORDER.map((value) => {
              const meta = PRIORITY_META[value];
              const active = priority === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPriority(value);
                    patch.mutate({ priority: value });
                  }}
                  aria-pressed={active}
                  className={clsx(
                    'flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-50',
                    active
                      ? 'bg-surface text-ink shadow-sm ring-1 ring-line'
                      : 'text-ink-muted hover:text-ink'
                  )}
                >
                  <span className={clsx('h-1.5 w-1.5 rounded-full', meta.dot)} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label htmlFor="actions-time" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
            {timeLabel} <span className="text-ink-subtle">(optional)</span>
          </label>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <AlarmClock className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
              <input
                id="actions-time"
                ref={timeRef}
                type="time"
                value={scheduledTime}
                onChange={(event) => setScheduledTime(event.target.value)}
                className="input px-3 py-2 pl-8 text-xs tabular-nums"
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => patch.mutate({ scheduledTime: scheduledTime || null })}
              className="ios-btn-secondary px-3 py-2 text-[11px] font-semibold disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {scheduledTime && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setScheduledTime('');
                patch.mutate({ scheduledTime: null });
              }}
              className="mt-1.5 text-[10px] font-medium text-ink-subtle transition-colors hover:text-ink"
            >
              Clear time
            </button>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface-2 p-3">
          <label className="flex items-center justify-between gap-3 text-[11px] font-semibold text-ink">
            <span className="flex items-center gap-1.5">
              <Bell className="h-3.5 w-3.5 text-ink-subtle" />
              Reminder
            </span>
            <input
              type="checkbox"
              checked={reminderEnabled}
              onChange={(event) => {
                const next = event.target.checked;
                setReminderEnabled(next);
                patch.mutate({ reminderEnabled: next, reminderMinutes });
              }}
              className="h-4 w-4 rounded border-line accent-accent"
            />
          </label>
          {reminderEnabled && (
            <select
              value={reminderMinutes}
              onChange={(event) => {
                const next = Number(event.target.value);
                setReminderMinutes(next);
                patch.mutate({ reminderMinutes: next, reminderEnabled: true });
              }}
              aria-label="Reminder timing"
              className="input mt-2.5 px-2.5 py-1.5 text-[11px]"
            >
              {REMINDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-surface text-ink">
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="space-y-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              patch.mutate({ status: completed ? 'open' : 'completed' })
            }
            className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-left text-xs font-medium text-ink transition-colors hover:bg-surface-3 disabled:opacity-50"
          >
            {completed ? (
              <RotateCcw className="h-3.5 w-3.5 text-ink-subtle" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            )}
            {completed ? 'Reopen task' : 'Mark as complete'}
          </button>

          {confirmDelete ? (
            <div className="rounded-xl border border-danger/25 bg-danger/5 p-3">
              <p className="text-[11px] text-ink">Delete this task permanently?</p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                  className="rounded-lg bg-danger px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {remove.isPending ? 'Deleting…' : 'Delete task'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
              className="flex w-full items-center gap-2 rounded-xl border border-transparent px-3 py-2.5 text-left text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete task
            </button>
          )}
        </div>
      </div>
    </FloatingWindow>
  );
}

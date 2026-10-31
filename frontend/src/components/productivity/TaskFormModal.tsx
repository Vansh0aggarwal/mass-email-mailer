import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  Bell,
  CalendarDays,
  CheckSquare,
  FolderKanban,
  Plus,
  Trash2,
  Video,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import type {
  ProductivityProject,
  TodoItem,
  TodoPriority,
  TodoSubtask,
} from '../../types';
import {
  DEFAULT_TODO_LIST_TITLE,
  PRIORITY_META,
  browserTimeZone,
  isValidMeetLink,
  toDateKey,
} from '../../lib/productivity';
import { FloatingWindow } from './FloatingWindow';

interface TaskFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: 'todo' | 'daily';
  task?: TodoItem | null;
  projects?: ProductivityProject[];
  defaultDueDate?: string;
  defaultListTitle?: string;
}

const REMINDER_OPTIONS = [
  { value: 0, label: 'At the time' },
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
];

const PRIORITY_ORDER: TodoPriority[] = ['high', 'medium', 'low'];

export function TaskFormModal({
  open,
  onClose,
  mode,
  task,
  projects = [],
  defaultDueDate,
  defaultListTitle = DEFAULT_TODO_LIST_TITLE,
}: TaskFormModalProps) {
  const queryClient = useQueryClient();
  const titleRef = useRef<HTMLInputElement>(null);
  const isDaily = mode === 'daily';
  const isEditing = Boolean(task);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('medium');
  const [dueDate, setDueDate] = useState(defaultDueDate || toDateKey());
  const [scheduledTime, setScheduledTime] = useState('');
  const [scheduledEndTime, setScheduledEndTime] = useState('');
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderMinutes, setReminderMinutes] = useState(10);
  const [addToCalendar, setAddToCalendar] = useState(true);
  const [addMeetLink, setAddMeetLink] = useState(false);
  const [meetLink, setMeetLink] = useState('');
  const [projectId, setProjectId] = useState('');
  const [category, setCategory] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [subtasks, setSubtasks] = useState<TodoSubtask[]>([]);
  const [error, setError] = useState('');
  const [syncWarning, setSyncWarning] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(task?.title || '');
    setDescription(task?.description || task?.notes || '');
    setPriority(task?.priority || 'medium');
    setDueDate(task ? task.dueDate?.slice(0, 10) || '' : defaultDueDate || toDateKey());
    setScheduledTime(task?.scheduledTime || '');
    setScheduledEndTime(task?.scheduledEndTime || '');
    setReminderEnabled(task?.reminderEnabled || false);
    setReminderMinutes(task?.reminderMinutes ?? 10);
    setAddToCalendar(task?.addToCalendar !== false);
    setAddMeetLink(task?.addMeetLink || false);
    setMeetLink(task?.googleMeetLink || '');
    setProjectId(task?.projectId || task?.project?._id || '');
    setCategory(task?.category || '');
    setTagsInput((task?.tags || []).join(', '));
    setSubtasks(
      (task?.subtasks || []).map((subtask) => ({
        title: subtask.title,
        completed: subtask.completed,
      }))
    );
    setError('');
    setSyncWarning('');
    setSaved(false);
    // Only reset when the dialog opens or the edited task changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?._id]);

  const mutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      isEditing && task
        ? api.patch<TodoItem>(`/todos/${task._id}`, payload)
        : api.post<TodoItem>('/todos', payload),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['productivity'] });
      queryClient.invalidateQueries({ queryKey: ['todos'] });
      if (result.sync && !result.sync.synced && result.sync.warning) {
        setSyncWarning(result.sync.warning);
        setSaved(true);
        return;
      }
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Give the task a name first.');
      return;
    }
    if (scheduledEndTime && !scheduledTime) {
      setError('Set a start time before an end time.');
      return;
    }
    if (scheduledTime && scheduledEndTime && scheduledEndTime <= scheduledTime) {
      setError('End time must be after the start time.');
      return;
    }
    const trimmedMeet = meetLink.trim();
    if (trimmedMeet && !isValidMeetLink(trimmedMeet)) {
      setError('Enter a valid Google Meet link, such as https://meet.google.com/abc-defg-hij.');
      return;
    }

    const tags = tagsInput
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 10);

    const payload: Record<string, unknown> = {
      title: trimmed,
      description: description.trim() || null,
      priority,
      dueDate: dueDate || null,
      scheduledTime: scheduledTime || null,
      scheduledEndTime: scheduledEndTime || null,
      timezone: browserTimeZone(),
      reminderEnabled,
      reminderMinutes,
      addToCalendar,
      addMeetLink,
      projectId: projectId || null,
      category: category.trim() || null,
      tags,
      subtasks: subtasks
        .filter((subtask) => subtask.title.trim())
        .map((subtask) => ({
          title: subtask.title.trim(),
          completed: subtask.completed,
        })),
    };

    // Only send the link when the user touched it so a Google-generated link
    // keeps its source instead of being reclassified as manually attached.
    const currentLink = task?.googleMeetLink || '';
    if (trimmedMeet !== currentLink) {
      payload.googleMeetLink = trimmedMeet || null;
    }

    mutation.mutate(payload);
  };

  const addSubtask = () => {
    if (subtasks.length >= 100) return;
    setSubtasks((current) => [...current, { title: '', completed: false }]);
  };

  const updateSubtask = (index: number, patch: Partial<TodoSubtask>) => {
    setSubtasks((current) =>
      current.map((subtask, i) => (i === index ? { ...subtask, ...patch } : subtask))
    );
  };

  const removeSubtask = (index: number) => {
    setSubtasks((current) => current.filter((_, i) => i !== index));
  };

  return (
    <FloatingWindow
      open={open}
      onClose={onClose}
      size={isDaily ? 'panel' : 'compact'}
      modal
      title={isEditing ? 'Edit task' : isDaily ? 'Add daily task' : 'Add task'}
      subtitle={
        isDaily ? 'Plan the details, then keep it moving.' : defaultListTitle
      }
      icon={isDaily ? CalendarDays : CheckSquare}
      initialFocusRef={titleRef}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="ios-btn-secondary px-4 py-2 text-xs font-semibold"
          >
            {saved ? 'Close' : 'Cancel'}
          </button>
          {!saved && (
            <button
              type="button"
              onClick={submit}
              disabled={mutation.isPending || !title.trim()}
              className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : isEditing ? 'Save changes' : 'Add task'}
            </button>
          )}
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-3 px-4 py-3.5 sm:px-5">
        {error && (
          <p className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            {error}
          </p>
        )}
        {syncWarning && (
          <p className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] text-warning">
            Saved locally. Google sync warning: {syncWarning}
          </p>
        )}

        <div>
          <label htmlFor="task-title" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
            Task name <span className="text-danger">*</span>
          </label>
          <input
            id="task-title"
            ref={titleRef}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            placeholder={isDaily ? 'e.g. Prepare the discovery call brief' : 'What needs doing today?'}
            className="input px-3 py-2.5 text-xs"
          />
        </div>

        {isDaily && (
          <div>
            <label htmlFor="task-description" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
              Description
            </label>
            <textarea
              id="task-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="Context, links, or acceptance notes…"
              className="input resize-none px-3 py-2.5 text-xs"
            />
          </div>
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
                  onClick={() => setPriority(value)}
                  aria-pressed={active}
                  className={clsx(
                    'flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors',
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {isDaily && (
            <div>
              <label htmlFor="task-due" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
                Due date
              </label>
              <input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                className="input px-3 py-2 text-xs tabular-nums"
              />
            </div>
          )}
          <div>
            <label htmlFor="task-time" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
              {isDaily ? 'Scheduled time' : 'Completion time'} <span className="text-ink-subtle">(optional)</span>
            </label>
            <div className="relative">
              <AlarmClock className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
              <input
                id="task-time"
                type="time"
                value={scheduledTime}
                onChange={(event) => {
                  const next = event.target.value;
                  setScheduledTime(next);
                  if (!next) setScheduledEndTime('');
                }}
                className="input px-3 py-2 pl-8 text-xs tabular-nums"
              />
            </div>
          </div>
          <div>
            <label htmlFor="task-end-time" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
              End time <span className="text-ink-subtle">(optional)</span>
            </label>
            <input
              id="task-end-time"
              type="time"
              value={scheduledEndTime}
              min={scheduledTime || undefined}
              disabled={!scheduledTime}
              onChange={(event) => setScheduledEndTime(event.target.value)}
              className="input px-3 py-2 text-xs tabular-nums disabled:opacity-60"
            />
          </div>
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
              onChange={(event) => setReminderEnabled(event.target.checked)}
              className="h-4 w-4 rounded border-line accent-accent"
            />
          </label>
          {reminderEnabled && (
            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <select
                value={reminderMinutes}
                onChange={(event) => setReminderMinutes(Number(event.target.value))}
                className="input px-2.5 py-1.5 text-[11px]"
                aria-label="Reminder timing"
              >
                {REMINDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} className="bg-surface text-ink">
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-[10px] leading-snug text-ink-subtle">
                Browser reminders are opt-in. Enable them in the notification panel.
              </p>
            </div>
          )}

          {scheduledTime && dueDate && (
            <label className="mt-2.5 flex items-center gap-2 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={addToCalendar}
                onChange={(event) => setAddToCalendar(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-line accent-accent"
              />
              Add a Google Calendar time block
            </label>
          )}
        </div>

        {scheduledTime && dueDate && (
          <div className="rounded-xl border border-line bg-surface-2 p-3">
            <label className="flex items-center justify-between gap-3 text-[11px] font-semibold text-ink">
              <span className="flex items-center gap-1.5">
                <Video className="h-3.5 w-3.5 text-ink-subtle" />
                Add Google Meet
              </span>
              <input
                type="checkbox"
                checked={addMeetLink}
                onChange={(event) => setAddMeetLink(event.target.checked)}
                className="h-4 w-4 rounded border-line accent-accent"
              />
            </label>
            <p className="mt-1 text-[10px] leading-snug text-ink-subtle">
              Adds a Meet link to the calendar event. Leave off for ordinary tasks.
            </p>
            <div className="mt-2.5">
              <label htmlFor="task-meet" className="mb-1 block text-[10px] font-semibold text-ink-muted">
                Existing Meet link <span className="text-ink-subtle">(optional)</span>
              </label>
              <input
                id="task-meet"
                type="url"
                value={meetLink}
                onChange={(event) => setMeetLink(event.target.value)}
                maxLength={500}
                placeholder="https://meet.google.com/abc-defg-hij"
                className="input px-2.5 py-1.5 text-[11px]"
              />
              {meetLink.trim() && !isValidMeetLink(meetLink) && (
                <p className="mt-1 text-[10px] text-danger">
                  Use a Google Meet link such as https://meet.google.com/abc-defg-hij.
                </p>
              )}
            </div>
          </div>
        )}

        {isDaily && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="task-project" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
                  Project
                </label>
                <div className="relative">
                  <FolderKanban className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
                  <select
                    id="task-project"
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                    className="input px-3 py-2 pl-8 text-xs"
                  >
                    <option value="" className="bg-surface text-ink">No project</option>
                    {projects
                      .filter((project) => !project.archived)
                      .map((project) => (
                        <option key={project._id} value={project._id} className="bg-surface text-ink">
                          {project.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor="task-category" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
                  Category
                </label>
                <input
                  id="task-category"
                  type="text"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  maxLength={60}
                  placeholder="e.g. Outreach"
                  className="input px-3 py-2 text-xs"
                />
              </div>
            </div>

            <div>
              <label htmlFor="task-tags" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
                Tags <span className="text-ink-subtle">(comma separated)</span>
              </label>
              <input
                id="task-tags"
                type="text"
                value={tagsInput}
                onChange={(event) => setTagsInput(event.target.value)}
                maxLength={300}
                placeholder="discovery, pricing, follow-up"
                className="input px-3 py-2 text-xs"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-ink-muted">Subtasks</span>
                <button
                  type="button"
                  onClick={addSubtask}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
                >
                  <Plus className="h-3 w-3" /> Add subtask
                </button>
              </div>
              {subtasks.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-3 py-2.5 text-[10px] text-ink-subtle">
                  Break this task into smaller steps if it helps.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {subtasks.map((subtask, index) => (
                    <li key={index} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={subtask.completed}
                        onChange={(event) => updateSubtask(index, { completed: event.target.checked })}
                        className="h-3.5 w-3.5 shrink-0 rounded border-line accent-accent"
                        aria-label="Subtask completed"
                      />
                      <input
                        type="text"
                        value={subtask.title}
                        onChange={(event) => updateSubtask(index, { title: event.target.value })}
                        maxLength={160}
                        placeholder={`Step ${index + 1}`}
                        className="input flex-1 px-2.5 py-1.5 text-[11px]"
                        aria-label={`Subtask ${index + 1}`}
                      />
                      <button
                        type="button"
                        onClick={() => removeSubtask(index)}
                        aria-label="Remove subtask"
                        className="rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        <p className="text-[10px] text-ink-subtle">
          {scheduledTime
            ? 'Saved to your shared task list. Scheduled tasks sync to Google Calendar when connected.'
            : `Saved to your shared task list and shown in both To-Do and Daily Tasks${
                isDaily ? '' : ' for today'
              }.`}
        </p>
      </form>
    </FloatingWindow>
  );
}

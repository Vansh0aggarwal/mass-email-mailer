import type {
  NoteColor,
  ProjectColor,
  ProjectIcon,
  TodoItem,
  TodoPriority,
} from '../types';

export const DEFAULT_TODO_LIST_TITLE = 'My To-Do List';
export const REMINDER_PREF_KEY = 'radar_reminders_enabled';
export const REMINDER_FIRED_KEY = 'radar_reminders_fired';

/** `medium` is the required default and is presented as "Normal". */
export const PRIORITY_META: Record<
  TodoPriority,
  { label: string; badge: string; dot: string; order: number }
> = {
  high: { label: 'High', badge: 'badge-danger', dot: 'bg-danger', order: 0 },
  medium: { label: 'Normal', badge: 'badge-neutral', dot: 'bg-ink-subtle', order: 1 },
  low: { label: 'Low', badge: 'badge-info', dot: 'bg-info', order: 2 },
};

export const PROJECT_COLOR_META: Record<
  ProjectColor,
  { label: string; swatch: string; soft: string; ring: string; text: string }
> = {
  slate: {
    label: 'Slate',
    swatch: 'bg-slate-400',
    soft: 'bg-slate-400/12',
    ring: 'ring-slate-400/50',
    text: 'text-slate-500 dark:text-slate-300',
  },
  blue: {
    label: 'Blue',
    swatch: 'bg-sky-500',
    soft: 'bg-sky-500/12',
    ring: 'ring-sky-500/50',
    text: 'text-sky-600 dark:text-sky-400',
  },
  green: {
    label: 'Green',
    swatch: 'bg-emerald-500',
    soft: 'bg-emerald-500/12',
    ring: 'ring-emerald-500/50',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  amber: {
    label: 'Amber',
    swatch: 'bg-amber-500',
    soft: 'bg-amber-500/12',
    ring: 'ring-amber-500/50',
    text: 'text-amber-600 dark:text-amber-400',
  },
  rose: {
    label: 'Rose',
    swatch: 'bg-rose-500',
    soft: 'bg-rose-500/12',
    ring: 'ring-rose-500/50',
    text: 'text-rose-600 dark:text-rose-400',
  },
  violet: {
    label: 'Violet',
    swatch: 'bg-violet-500',
    soft: 'bg-violet-500/12',
    ring: 'ring-violet-500/50',
    text: 'text-violet-600 dark:text-violet-400',
  },
};

export const PROJECT_ICON_OPTIONS: Array<{ value: ProjectIcon; label: string }> = [
  { value: 'folder', label: 'Folder' },
  { value: 'briefcase', label: 'Briefcase' },
  { value: 'book', label: 'Book' },
  { value: 'heart', label: 'Heart' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'sparkles', label: 'Sparkles' },
];

export const NOTE_COLOR_META: Record<
  NoteColor,
  { label: string; card: string; swatch: string }
> = {
  yellow: {
    label: 'Yellow',
    card: 'border-[#F4D97B] bg-[#FEF3C0] text-[#5B4708] dark:border-[#6B5A25] dark:bg-[#4A3F1B] dark:text-[#FDE68A]',
    swatch: 'bg-[#F4D97B]',
  },
  green: {
    label: 'Green',
    card: 'border-[#BDDBA4] bg-[#E7F4DA] text-[#33491F] dark:border-[#3F5C33] dark:bg-[#263A20] dark:text-[#C8E6B8]',
    swatch: 'bg-[#BDDBA4]',
  },
  pink: {
    label: 'Pink',
    card: 'border-[#F1BFD0] bg-[#FCE4EC] text-[#5C2237] dark:border-[#6A3547] dark:bg-[#45232F] dark:text-[#F8C9D8]',
    swatch: 'bg-[#F1BFD0]',
  },
  purple: {
    label: 'Purple',
    card: 'border-[#D6C2F0] bg-[#F0E7FC] text-[#402662] dark:border-[#513C6E] dark:bg-[#322645] dark:text-[#DCC9F5]',
    swatch: 'bg-[#D6C2F0]',
  },
  blue: {
    label: 'Blue',
    card: 'border-[#B9D7F2] bg-[#E3F1FD] text-[#173F61] dark:border-[#34526E] dark:bg-[#1D3145] dark:text-[#C4E3FA]',
    swatch: 'bg-[#B9D7F2]',
  },
  orange: {
    label: 'Orange',
    card: 'border-[#F5CCA8] bg-[#FDEBD9] text-[#5C3214] dark:border-[#6B4830] dark:bg-[#46301F] dark:text-[#F8D3B3]',
    swatch: 'bg-[#F5CCA8]',
  },
};

export const NOTE_COLOR_OPTIONS: NoteColor[] = ['yellow', 'green', 'pink', 'purple', 'blue', 'orange'];

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local calendar date key (`YYYY-MM-DD`). */
export function toDateKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function startOfLocalDay(date: Date = new Date()): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** The user's local "today" boundaries, sent to the API so today matches them. */
export function localDayRange(date: Date = new Date()): {
  from: string;
  to: string;
  key: string;
  label: string;
} {
  const from = startOfLocalDay(date);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    key: toDateKey(from),
    label: formatTodayHeading(from),
  };
}

/** Extracts the calendar date from either a date key or an ISO timestamp. */
export function taskDateKey(value?: string | null): string {
  if (!value) return '';
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : toDateKey(date);
}

export function isTaskOverdue(task: TodoItem, now: Date = new Date()): boolean {
  if (task.status !== 'open') return false;
  const key = taskDateKey(task.dueDate);
  if (!key) return false;
  return key < toDateKey(now);
}

export function isTaskToday(task: TodoItem, now: Date = new Date()): boolean {
  return taskDateKey(task.dueDate) === toDateKey(now);
}

export function formatTimeLabel(time?: string | null): string {
  if (!time) return '';
  const [rawHour, rawMinute] = time.split(':').map(Number);
  if (Number.isNaN(rawHour) || Number.isNaN(rawMinute)) return time;
  const suffix = rawHour >= 12 ? 'PM' : 'AM';
  const hour = rawHour % 12 || 12;
  return `${hour}:${pad2(rawMinute)} ${suffix}`;
}

/** `9:00 AM – 10:30 AM`, or just the start when no later end time is set. */
export function formatTimeRange(
  start?: string | null,
  end?: string | null
): string {
  const startLabel = formatTimeLabel(start);
  if (!startLabel) return '';
  if (!end || end <= (start || '')) return startLabel;
  return `${startLabel} – ${formatTimeLabel(end)}`;
}

const MEET_LINK_PATTERN = /^https:\/\/meet\.google\.com\/[a-z0-9-]+/i;

export function isValidMeetLink(value?: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === 'https:' &&
      url.hostname === 'meet.google.com' &&
      MEET_LINK_PATTERN.test(url.toString())
    );
  } catch {
    return false;
  }
}

/** The user's IANA timezone, used so calendar events land on their local clock. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function formatTodayHeading(date: Date = new Date()): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function greetingForHour(hour: number): string {
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function firstNameOf(fullName?: string | null): string {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

export function addDaysToKey(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00`);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/** Friendly label for a calendar date key. */
export function formatDateKeyLabel(key: string, todayKey = toDateKey()): string {
  if (!key) return 'No date';
  if (key === todayKey) return 'Today';
  if (key === addDaysToKey(todayKey, 1)) return 'Tomorrow';
  if (key === addDaysToKey(todayKey, -1)) return 'Yesterday';
  const date = new Date(`${key}T12:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatDueLabel(value?: string | null): string {
  const key = taskDateKey(value);
  return key ? formatDateKeyLabel(key) : '';
}

/** Groups tasks by calendar date for the Upcoming tab. */
export function groupTasksByDate(
  tasks: TodoItem[],
  todayKey = toDateKey()
): Array<{ key: string; label: string; tasks: TodoItem[] }> {
  const groups = new Map<string, TodoItem[]>();
  for (const task of tasks) {
    const key = taskDateKey(task.dueDate);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(task);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, groupTasks]) => ({
      key,
      label: formatDateKeyLabel(key, todayKey),
      tasks: groupTasks,
    }));
}

/** Local moment a task reminder should fire (due date + scheduled time). */
export function reminderTriggerDate(task: TodoItem): Date | null {
  const key = taskDateKey(task.dueDate);
  if (!key || !task.reminderEnabled) return null;
  const time = task.scheduledTime || '09:00';
  const trigger = new Date(`${key}T${time}:00`);
  if (Number.isNaN(trigger.getTime())) return null;
  trigger.setMinutes(trigger.getMinutes() - (task.reminderMinutes || 0));
  return trigger;
}

export function shouldFireReminder(task: TodoItem, now: Date = new Date()): boolean {
  if (task.status !== 'open' || !task.reminderEnabled) return false;
  const trigger = reminderTriggerDate(task);
  if (!trigger) return false;
  const diff = now.getTime() - trigger.getTime();
  return diff >= 0 && diff <= 5 * 60 * 1000;
}

export function subtaskProgress(task: TodoItem): { done: number; total: number } {
  const subtasks = task.subtasks || [];
  return {
    done: subtasks.filter((subtask) => subtask.completed).length,
    total: subtasks.length,
  };
}

type QueryValue = string | number | boolean | null | undefined;

/** Builds a query string while omitting empty values. */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const productivityKeys = {
  all: ['productivity'] as const,
  summary: (from: string, to: string) => ['productivity', 'summary', from, to] as const,
  settings: ['productivity', 'todo-settings'] as const,
  todos: (scope: string, params: string) => ['productivity', 'todos', scope, params] as const,
  projects: (includeArchived: boolean) =>
    ['productivity', 'projects', includeArchived ? 'all' : 'active'] as const,
  notes: (q: string) => ['productivity', 'notes', q] as const,
  notifications: (from: string, to: string) =>
    ['productivity', 'notifications', from, to] as const,
  search: (q: string) => ['productivity', 'search', q] as const,
  integration: ['productivity', 'google-integration'] as const,
  calendars: ['productivity', 'google-calendars'] as const,
  taskLists: ['productivity', 'google-task-lists'] as const,
};

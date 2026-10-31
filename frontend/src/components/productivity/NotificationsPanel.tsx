import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  BellRing,
  CalendarClock,
  ChevronRight,
  Inbox,
  PlugZap,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import type { ProductivityNotification } from '../../types';
import {
  REMINDER_PREF_KEY,
  buildQuery,
  localDayRange,
  productivityKeys,
} from '../../lib/productivity';
import { useProductivity } from '../../context/ProductivityContext';
import { FloatingWindow } from './FloatingWindow';

interface NotificationPayload {
  count: number;
  overdueCount: number;
  notifications: ProductivityNotification[];
}

const TYPE_META: Record<
  ProductivityNotification['type'],
  { icon: typeof Bell; tone: string; label: string }
> = {
  overdue: { icon: AlertTriangle, tone: 'text-danger', label: 'Overdue' },
  reminder: { icon: BellRing, tone: 'text-info', label: 'Reminder' },
  integration: { icon: PlugZap, tone: 'text-warning', label: 'Integration' },
};

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function currentPermission(): NotificationPermission | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported';
  return window.Notification.permission;
}

/**
 * Honest notification center: every entry is derived from real tasks and the
 * real Google connection state. Browser reminders are strictly opt-in.
 */
export function NotificationsPanel() {
  const { isWindowOpen, closeWindow, bringToFront, openNotification } = useProductivity();
  const open = isWindowOpen('notifications');
  const today = useMemo(() => localDayRange(), []);
  const params = buildQuery({ from: today.from, to: today.to });

  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    currentPermission
  );
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(REMINDER_PREF_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [permissionNote, setPermissionNote] = useState('');

  const query = useQuery({
    queryKey: productivityKeys.notifications(today.from, today.to),
    queryFn: () => api.get<NotificationPayload>(`/productivity/notifications${params}`),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  });

  useEffect(() => {
    if (!open) return;
    setPermission(currentPermission());
  }, [open]);

  const enableReminders = async () => {
    if (!notificationsSupported()) {
      setPermissionNote('This browser does not support desktop notifications.');
      return;
    }
    try {
      const result = await window.Notification.requestPermission();
      setPermission(result);
      if (result === 'granted') {
        localStorage.setItem(REMINDER_PREF_KEY, '1');
        setEnabled(true);
        setPermissionNote('Browser reminders are on. We will only alert you for tasks with reminders set.');
      } else {
        localStorage.removeItem(REMINDER_PREF_KEY);
        setEnabled(false);
        setPermissionNote(
          result === 'denied'
            ? 'Notifications are blocked by the browser. Allow them in site settings to turn this on.'
            : 'Reminders stay off until you allow notifications.'
        );
      }
    } catch {
      setPermissionNote('Could not request notification permission.');
    }
  };

  const disableReminders = () => {
    try {
      localStorage.removeItem(REMINDER_PREF_KEY);
    } catch {
      /* storage may be unavailable */
    }
    setEnabled(false);
    setPermissionNote('Browser reminders are off.');
  };

  const notifications = query.data?.notifications || [];

  return (
    <FloatingWindow
      open={open}
      onClose={() => closeWindow('notifications')}
      onActivate={() => bringToFront('notifications')}
      size="panel"
      defaultRight={96}
      defaultTop={88}
      icon={Bell}
      title="Notifications"
      subtitle={`${today.label} · overdue tasks, reminders and integration alerts`}
    >
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <div className="rounded-xl border border-line bg-surface-2 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <BellRing className="h-3.5 w-3.5 text-ink-subtle" />
                Browser reminders
              </p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-ink-muted">
                Opt-in only. We alert you at the time you choose for a task.
              </p>
            </div>
            <button
              type="button"
              onClick={enabled ? disableReminders : enableReminders}
              aria-pressed={enabled}
              disabled={permission === 'unsupported'}
              className={clsx(
                'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
                enabled ? 'bg-success' : 'bg-surface-3'
              )}
            >
              <span
                className={clsx(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                  enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                )}
              />
              <span className="sr-only">
                {enabled ? 'Disable browser reminders' : 'Enable browser reminders'}
              </span>
            </button>
          </div>
          {permissionNote && (
            <p className="mt-2 text-[10px] leading-relaxed text-ink-muted">{permissionNote}</p>
          )}
          {!permissionNote && enabled && permission !== 'granted' && (
            <p className="mt-2 text-[10px] leading-relaxed text-warning">
              Notifications are not allowed for this site right now. Re-enable them in your browser
              settings.
            </p>
          )}
        </div>

        {query.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            {[0, 1].map((row) => (
              <div
                key={row}
                className="h-[62px] animate-pulse rounded-xl border border-line bg-surface-2"
              />
            ))}
          </div>
        ) : query.isError ? (
          <div className="empty-state gap-3 px-4 py-8">
            <p className="text-xs">Could not load notifications right now.</p>
            <button
              type="button"
              onClick={() => query.refetch()}
              className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold"
            >
              Try again
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="empty-state gap-2.5 px-4 py-8">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface-2 text-ink-subtle">
              <Inbox className="h-5 w-5" />
            </span>
            <p className="text-xs font-medium">You are all caught up.</p>
            <p className="max-w-xs text-[11px] text-ink-subtle">
              Overdue tasks, task reminders and Google sync issues will appear here.
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {notifications.map((notification) => {
              const meta = TYPE_META[notification.type] || TYPE_META.reminder;
              const Icon = meta.icon;
              return (
                <li key={notification.id}>
                  <button
                    type="button"
                    onClick={() => openNotification(notification)}
                    className="flex w-full items-start gap-2.5 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-3"
                  >
                    <span
                      className={clsx(
                        'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface',
                        meta.tone
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
                          {meta.label}
                        </span>
                        {notification.type === 'reminder' && (
                          <CalendarClock className="h-3 w-3 text-ink-subtle" />
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-xs font-medium text-ink">
                        {notification.title}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-muted">
                        {notification.message}
                      </span>
                    </span>
                    <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-ink-subtle" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </FloatingWindow>
  );
}

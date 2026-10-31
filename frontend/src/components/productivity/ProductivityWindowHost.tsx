import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { TodoItem } from '../../types';
import {
  REMINDER_FIRED_KEY,
  REMINDER_PREF_KEY,
  shouldFireReminder,
  taskDateKey,
} from '../../lib/productivity';
import { TodoWindow } from './TodoWindow';
import { DailyTasksWindow } from './DailyTasksWindow';
import { NotificationsPanel } from './NotificationsPanel';
import { IntegrationSettingsWindow } from './IntegrationSettingsWindow';

type FiredMap = Record<string, number>;

function readFired(): FiredMap {
  try {
    const raw = localStorage.getItem(REMINDER_FIRED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as FiredMap) : {};
  } catch {
    return {};
  }
}

const REMINDER_POLL_MS = 60_000;
const FIRED_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Mounts every productivity floating window once and owns the opt-in browser
 * reminder loop. The loop only runs after the user grants notification
 * permission and turns reminders on in the notification panel.
 */
export function ProductivityWindowHost() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      let enabled = false;
      try {
        enabled = localStorage.getItem(REMINDER_PREF_KEY) === '1';
      } catch {
        enabled = false;
      }
      if (!enabled) return;
      if (typeof window === 'undefined' || !('Notification' in window)) return;
      if (window.Notification.permission !== 'granted') return;

      let tasks: TodoItem[];
      try {
        tasks = await api.get<TodoItem[]>('/todos?reminder=1');
      } catch {
        return;
      }
      if (cancelled) return;

      const now = new Date();
      const fired = readFired();
      let changed = false;

      for (const task of tasks) {
        if (!shouldFireReminder(task, now)) continue;
        const key = `${task._id}:${taskDateKey(task.dueDate)}:${task.scheduledTime || ''}`;
        if (fired[key]) continue;
        try {
          new window.Notification('Task reminder', {
            body: task.title,
            tag: key,
            requireInteraction: false,
          });
        } catch {
          /* Some browsers require a service worker; fail quietly. */
        }
        fired[key] = Date.now();
        changed = true;
      }

      if (!changed) return;

      const cutoff = Date.now() - FIRED_TTL_MS;
      for (const [key, at] of Object.entries(fired)) {
        if (at < cutoff) delete fired[key];
      }
      try {
        localStorage.setItem(REMINDER_FIRED_KEY, JSON.stringify(fired));
      } catch {
        /* storage full/unavailable — reminders still fired once this session */
      }
      queryClient.invalidateQueries({ queryKey: ['productivity'] });
    };

    void check();
    const interval = window.setInterval(check, REMINDER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [queryClient]);

  return (
    <>
      <TodoWindow />
      <DailyTasksWindow />
      <NotificationsPanel />
      <IntegrationSettingsWindow />
    </>
  );
}

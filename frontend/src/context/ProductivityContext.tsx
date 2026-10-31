import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ProductivityNotification, TaskViewTarget } from '../types';

export type ProductivityWindowName = 'todo' | 'daily' | 'notifications' | 'integration';
export type DailyTab = 'tasks' | 'projects' | 'notes' | 'upcoming' | 'completed';

interface OpenWindowOptions {
  tab?: DailyTab;
  taskId?: string;
}

interface ProductivityContextValue {
  /** Open windows from back to front. The last entry is the focused window. */
  openWindows: ProductivityWindowName[];
  dailyTab: DailyTab;
  focusedTaskId: string | null;
  isWindowOpen: (name: ProductivityWindowName) => boolean;
  openWindow: (name: ProductivityWindowName, options?: OpenWindowOptions) => void;
  closeWindow: (name: ProductivityWindowName) => void;
  bringToFront: (name: ProductivityWindowName) => void;
  setDailyTab: (tab: DailyTab) => void;
  openTask: (taskId: string, target?: TaskViewTarget) => void;
  openNotification: (notification: ProductivityNotification) => void;
}

const ProductivityContext = createContext<ProductivityContextValue | undefined>(undefined);

/**
 * Floating productivity utilities are independent: opening one never replaces
 * another, and the order in which they are opened doubles as the focus stack.
 */
export function ProductivityProvider({ children }: { children: ReactNode }) {
  const [openWindows, setOpenWindows] = useState<ProductivityWindowName[]>([]);
  const [dailyTab, setDailyTab] = useState<DailyTab>('tasks');
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);

  const bringToFront = useCallback((name: ProductivityWindowName) => {
    setOpenWindows((current) => {
      if (current[current.length - 1] === name) return current;
      const rest = current.filter((entry) => entry !== name);
      return [...rest, name];
    });
  }, []);

  const openWindow = useCallback(
    (name: ProductivityWindowName, options?: OpenWindowOptions) => {
      setOpenWindows((current) => [...current.filter((entry) => entry !== name), name]);
      if (options?.tab) setDailyTab(options.tab);
      if (options && 'taskId' in options) setFocusedTaskId(options.taskId || null);
    },
    []
  );

  const closeWindow = useCallback((name: ProductivityWindowName) => {
    setOpenWindows((current) => current.filter((entry) => entry !== name));
    if (name === 'todo' || name === 'daily') setFocusedTaskId(null);
  }, []);

  const isWindowOpen = useCallback(
    (name: ProductivityWindowName) => openWindows.includes(name),
    [openWindows]
  );

  const openTask = useCallback((taskId: string, target: TaskViewTarget = 'daily') => {
    setFocusedTaskId(taskId);
    const name: ProductivityWindowName = target === 'todo' ? 'todo' : 'daily';
    setOpenWindows((current) => [...current.filter((entry) => entry !== name), name]);
    if (target !== 'todo') setDailyTab('tasks');
  }, []);

  const openNotification = useCallback((notification: ProductivityNotification) => {
    if (notification.type === 'integration') {
      setOpenWindows((current) => [
        ...current.filter((entry) => entry !== 'integration'),
        'integration',
      ]);
      return;
    }
    if (!notification.taskId) {
      setOpenWindows((current) => [
        ...current.filter((entry) => entry !== 'notifications'),
        'notifications',
      ]);
      return;
    }
    setFocusedTaskId(notification.taskId);
    const name: ProductivityWindowName = notification.target === 'todo' ? 'todo' : 'daily';
    setOpenWindows((current) => [...current.filter((entry) => entry !== name), name]);
    if (notification.target !== 'todo') setDailyTab('tasks');
  }, []);

  const value = useMemo<ProductivityContextValue>(
    () => ({
      openWindows,
      dailyTab,
      focusedTaskId,
      isWindowOpen,
      openWindow,
      closeWindow,
      bringToFront,
      setDailyTab,
      openTask,
      openNotification,
    }),
    [
      openWindows,
      dailyTab,
      focusedTaskId,
      isWindowOpen,
      openWindow,
      closeWindow,
      bringToFront,
      openTask,
      openNotification,
    ]
  );

  return <ProductivityContext.Provider value={value}>{children}</ProductivityContext.Provider>;
}

export function useProductivity(): ProductivityContextValue {
  const context = useContext(ProductivityContext);
  if (!context) {
    throw new Error('useProductivity must be used within a ProductivityProvider');
  }
  return context;
}

import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import type { ProductivityNotification } from '../../types';
import { buildQuery, localDayRange, productivityKeys } from '../../lib/productivity';
import { useProductivity } from '../../context/ProductivityContext';

interface NotificationsMenuProps {
  variant?: 'header' | 'rail';
  className?: string;
}

/**
 * Single notifications trigger shared by the workspace header (mobile) and the
 * utility rail (desktop). Both open the same floating notification center.
 */
export function NotificationsMenu({ variant = 'header', className }: NotificationsMenuProps) {
  const { openWindow } = useProductivity();
  const isRail = variant === 'rail';
  const today = localDayRange();
  const params = buildQuery({ from: today.from, to: today.to });

  const { data } = useQuery({
    queryKey: productivityKeys.notifications(today.from, today.to),
    queryFn: () =>
      api.get<{ count: number; notifications: ProductivityNotification[] }>(
        `/productivity/notifications${params}`
      ),
    staleTime: 60_000,
  });

  const count = data?.count || 0;
  const label = count > 0 ? `Notifications, ${count} unread` : 'Notifications';

  return (
    <div className={clsx('relative', isRail && 'group', className)}>
      <button
        type="button"
        onClick={() => openWindow('notifications')}
        aria-label={label}
        title="Notifications"
        className={clsx(
          'text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink',
          isRail
            ? 'relative flex h-11 w-11 items-center justify-center rounded-xl'
            : 'relative rounded-lg p-2'
        )}
      >
        <Bell className={isRail ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />
        {count > 0 && (
          <span
            className={clsx(
              'absolute flex items-center justify-center rounded-full bg-danger font-semibold text-white',
              isRail
                ? 'right-1.5 top-1.5 h-3.5 min-w-[0.875rem] px-0.5 text-[8px]'
                : 'right-1 top-1 h-3.5 min-w-[0.875rem] px-0.5 text-[8px]'
            )}
            aria-hidden="true"
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
        {isRail && (
          <span className="app-rail-tooltip" role="tooltip">
            Notifications
          </span>
        )}
      </button>
    </div>
  );
}

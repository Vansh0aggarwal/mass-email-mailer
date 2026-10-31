import type { ComponentType } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  BrainCircuit,
  CalendarCheck,
  CalendarDays,
  House,
  ListChecks,
  Video,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import type { CalendarAccount } from '../../types';
import { NotificationsMenu } from './NotificationsMenu';
import { ThemeToggle } from './ThemeToggle';
import { useProductivity } from '../../context/ProductivityContext';

function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={clsx(
        'group relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors',
        active
          ? 'bg-ink/10 text-ink'
          : 'text-ink-muted hover:bg-surface-3 hover:text-ink'
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
      <span className="app-rail-tooltip" role="tooltip">
        {label}
      </span>
    </button>
  );
}

function RailDivider() {
  return <div className="my-1 h-px w-8 shrink-0 bg-line" aria-hidden="true" />;
}

/**
 * Independent utility rail: notifications, AI memory, navigation shortcuts,
 * personal productivity, Google Workspace access and the theme switch. It is
 * hidden below `lg`, where the existing mobile navigation takes over.
 */
export function RightSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { openWindows, openWindow } = useProductivity();

  const goBack = () => {
    // Only step back when this session actually has prior in-app history;
    // otherwise a cold deep-link load would leave the application.
    const historyIndex = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof historyIndex === 'number' && historyIndex > 0) {
      navigate(-1);
    } else {
      navigate('/dashboard');
    }
  };

  /** Opens the configured Google integration, or the official website as a fallback. */
  const openGoogleWorkspace = async (fallback: string) => {
    try {
      const accounts = await api.get<CalendarAccount[]>('/calendar/accounts');
      if (accounts.length > 0) {
        navigate('/integrations');
        return;
      }
    } catch {
      // Ignore lookup failures and fall through to the official site.
    }
    window.open(fallback, '_blank', 'noopener,noreferrer');
  };

  return (
    <aside
      aria-label="Utility navigation"
      className="app-rail app-rail--right hidden flex-col items-center py-3 lg:flex"
    >
      <div className="flex flex-col items-center gap-2">
        <NotificationsMenu variant="rail" />
        <RailButton
          icon={BrainCircuit}
          label="Optimize Memory"
          active={location.pathname.startsWith('/ai-studio')}
          onClick={() => navigate('/ai-studio')}
        />
      </div>

      <RailDivider />

      <div className="flex flex-col items-center gap-2">
        <RailButton
          icon={House}
          label="Analytics Home"
          active={location.pathname.startsWith('/analytics')}
          onClick={() => navigate('/analytics')}
        />
        <RailButton icon={ArrowLeft} label="Previous Page" onClick={goBack} />
      </div>

      <RailDivider />

      <div className="flex flex-col items-center gap-2">
        <RailButton
          icon={ListChecks}
          label="To-Do List"
          active={openWindows.includes('todo')}
          onClick={() => openWindow('todo')}
        />
        <RailButton
          icon={CalendarCheck}
          label="Daily Tasks"
          active={openWindows.includes('daily')}
          onClick={() => openWindow('daily')}
        />
      </div>

      <RailDivider />

      <div className="flex flex-col items-center gap-2">
        <RailButton
          icon={Video}
          label="Google Meet"
          onClick={() => openGoogleWorkspace('https://meet.google.com/')}
        />
        <RailButton
          icon={CalendarDays}
          label="Google Calendar"
          onClick={() => openGoogleWorkspace('https://calendar.google.com/')}
        />
      </div>

      <div className="mt-auto pt-3">
        <ThemeToggle variant="rail" />
      </div>
    </aside>
  );
}

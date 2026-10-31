import { Link, useLocation } from 'react-router-dom';
import { BrainCircuit, Menu } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { AccountMenu } from './AccountMenu';
import { NotificationsMenu } from './NotificationsMenu';
import { getRouteMeta, isDashboardPath } from './navigation';
import { useTheme } from '../../context/ThemeContext';

interface WorkspaceHeaderProps {
  onMenuClick: () => void;
  onOpenSearch?: () => void;
}

/**
 * Contextual header that lives inside the main workspace block. It replaces
 * the old full-width application navbar.
 */
export function WorkspaceHeader({ onMenuClick }: WorkspaceHeaderProps) {
  const location = useLocation();
  const meta = getRouteMeta(location.pathname);
  const { resolvedTheme } = useTheme();
  const isDashboard = isDashboardPath(location.pathname);
  const title = isDashboard ? 'SWANIKI' : meta.title;
  const description = isDashboard
    ? resolvedTheme === 'dark'
      ? 'Dark mode'
      : 'Light mode'
    : meta.description;

  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2.5 sm:px-4 lg:px-6 lg:py-3">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation menu"
          className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="min-w-0">
          <h1
            className={
              isDashboard
                ? 'truncate text-sm font-semibold uppercase tracking-[0.2em] text-ink lg:text-base'
                : 'truncate text-sm font-semibold tracking-tight text-ink lg:text-base'
            }
          >
            {title}
          </h1>
          <p className="hidden truncate text-[11px] text-ink-muted sm:block">{description}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        <Link
          to="/ai-studio"
          aria-label="Optimize Memory — open AI Email Studio"
          title="Optimize Memory"
          className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink lg:hidden"
        >
          <BrainCircuit className="h-4 w-4" />
        </Link>

        <NotificationsMenu className="lg:hidden" />

        {/* The desktop utility rail owns the theme switch; keep it here only
            where that rail is hidden so mobile/tablet users can still switch. */}
        <div className="lg:hidden">
          <ThemeToggle />
        </div>
        <AccountMenu />
      </div>
    </header>
  );
}

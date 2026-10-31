import { NavLink } from 'react-router-dom';
import {
  CircleUserRound,
  House,
  LayoutDashboard,
  MessageSquare,
  Search,
} from 'lucide-react';
import { clsx } from 'clsx';

const ITEM_CLASS =
  'flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-full px-1 py-1.5 text-[10px] font-medium transition-colors';

export function BottomNavigation({ onOpenSearch }: { onOpenSearch: () => void }) {
  return (
    <nav
      aria-label="Quick navigation"
      className="fixed bottom-3 left-1/2 z-40 grid w-[min(22rem,calc(100vw-1.5rem))] -translate-x-1/2 grid-cols-5 gap-1 rounded-full border border-line bg-block p-1.5 shadow-pop sm:bottom-4"
    >
      <NavLink
        to="/analytics"
        end
        title="Analytics Home"
        className={({ isActive }) =>
          clsx(ITEM_CLASS, isActive ? 'bg-ink/10 text-ink' : 'text-ink-muted hover:bg-surface-3 hover:text-ink')
        }
      >
        <House className="h-[18px] w-[18px]" />
        <span>Home</span>
      </NavLink>

      <button
        type="button"
        onClick={onOpenSearch}
        title="Search"
        className={clsx(ITEM_CLASS, 'text-ink-muted hover:bg-surface-3 hover:text-ink')}
      >
        <Search className="h-[18px] w-[18px]" />
        <span>Search</span>
      </button>

      <NavLink
        to="/dashboard"
        end
        title="Dashboard"
        className={({ isActive }) =>
          clsx(ITEM_CLASS, isActive ? 'bg-ink/10 text-ink' : 'text-ink-muted hover:bg-surface-3 hover:text-ink')
        }
      >
        <LayoutDashboard className="h-[18px] w-[18px]" />
        <span>Dashboard</span>
      </NavLink>

      <NavLink
        to="/email"
        title="Messages"
        className={({ isActive }) =>
          clsx(ITEM_CLASS, isActive ? 'bg-ink/10 text-ink' : 'text-ink-muted hover:bg-surface-3 hover:text-ink')
        }
      >
        <MessageSquare className="h-[18px] w-[18px]" />
        <span>Messages</span>
      </NavLink>

      <NavLink
        to="/settings"
        title="Profile"
        className={({ isActive }) =>
          clsx(ITEM_CLASS, isActive ? 'bg-ink/10 text-ink' : 'text-ink-muted hover:bg-surface-3 hover:text-ink')
        }
      >
        <CircleUserRound className="h-[18px] w-[18px]" />
        <span>Profile</span>
      </NavLink>
    </nav>
  );
}

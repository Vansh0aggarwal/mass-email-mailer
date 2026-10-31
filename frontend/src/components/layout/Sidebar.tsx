import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Radar, X } from 'lucide-react';
import { clsx } from 'clsx';
import { AccountMenu } from './AccountMenu';
import { NAV_GROUPS, isDashboardPath, type NavItem } from './navigation';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

function Brand({ expanded, onClose }: { expanded: boolean; onClose?: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-2.5 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2.5 p-1.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink text-surface shadow-sm">
          <Radar className="h-4 w-4" />
        </span>
        {expanded && (
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-semibold tracking-tight text-ink">
              SWANIKI
            </span>
            <span className="block truncate text-[10px] font-medium text-ink-subtle">
              New Business Radar
            </span>
          </span>
        )}
      </div>

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation menu"
          className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function NavigationList({
  expanded,
  onNavigate,
}: {
  expanded: boolean;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const dashboardActive = isDashboardPath(location.pathname);

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={onNavigate}
        end={item.end}
        aria-label={item.label}
        title={expanded ? undefined : item.label}
        className={({ isActive }) =>
          clsx(
            'group flex items-center rounded-xl text-[13px] font-medium transition-colors',
            expanded ? 'justify-start gap-3 px-3 py-2.5' : 'justify-center px-2 py-2.5',
            isActive || (item.to === '/dashboard' && dashboardActive)
              ? 'bg-ink/10 text-ink'
              : 'text-ink-muted hover:bg-surface-3 hover:text-ink'
          )
        }
      >
        <Icon className="h-4 w-4 shrink-0" />
        {expanded && <span className="truncate">{item.label}</span>}
      </NavLink>
    );
  };

  return (
    <nav aria-label="Primary navigation" className="space-y-5 px-2 py-3">
      {NAV_GROUPS.map((group) => (
        <div key={group.title} className="space-y-1">
          {expanded ? (
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              {group.title}
            </div>
          ) : (
            <div className="mx-auto mb-1 h-px w-6 bg-line" aria-hidden="true" />
          )}
          {group.items.map(renderItem)}
        </div>
      ))}
    </nav>
  );
}

function AccountArea({ expanded }: { expanded: boolean }) {
  return (
    <div className="mt-auto border-t border-line p-2">
      <AccountMenu variant="rail" expanded={expanded} />
    </div>
  );
}

/**
 * The left navigation is an independent floating rail. It rests at 68px and
 * expands inward over the workspace only while the pointer (or keyboard focus)
 * is inside it — the grid column never changes, so the workspace never shifts.
 * There is no pinned/persisted state: leaving the rail collapses it.
 */
export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);

  const expanded = hovered || focusWithin;

  return (
    <>
      {/* Mobile scrim */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={clsx(
          'fixed inset-0 z-40 bg-overlay/45 backdrop-blur-[2px] transition-opacity duration-200 lg:hidden',
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      />

      {/* Mobile drawer */}
      <aside
        aria-label="Application navigation"
        className={clsx(
          'fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] p-2 transition-transform duration-200 ease-out lg:hidden',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-full flex-col overflow-hidden rounded-[20px] border border-line bg-block shadow-pop">
          <Brand expanded onClose={onClose} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NavigationList expanded onNavigate={onClose} />
          </div>
          <AccountArea expanded />
        </div>
      </aside>

      {/* Desktop rail */}
      <aside
        aria-label="Application navigation"
        data-expanded={expanded ? 'true' : 'false'}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={(event) => {
          // Pointer clicks focus links too, but only keyboard focus should open
          // the rail; otherwise a click would leave it stuck open after the
          // pointer moves away.
          if (event.target instanceof Element && event.target.matches(':focus-visible')) {
            setFocusWithin(true);
          }
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocusWithin(false);
          }
        }}
        className="app-rail app-rail--left hidden flex-col lg:flex"
      >
        <Brand expanded={expanded} />
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <NavigationList
            expanded={expanded}
            onNavigate={() => setFocusWithin(false)}
          />
        </div>
        <AccountArea expanded={expanded} />
      </aside>
    </>
  );
}

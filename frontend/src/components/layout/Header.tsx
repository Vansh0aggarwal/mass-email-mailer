import { Building, LogIn, Menu, Search } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { Link } from 'react-router-dom';
import { AccountMenu } from './AccountMenu';
import { ThemeToggle } from './ThemeToggle';

export function Header({
  onMenuClick,
  onOpenSearch,
}: {
  onMenuClick?: () => void;
  onOpenSearch?: () => void;
}) {
  const { user, organizations, currentOrgId, userRole } = useAuth();

  const activeOrg = organizations.find((o) => o._id === currentOrgId);
  const currentOrgName = activeOrg ? activeOrg.name : 'Swaniki Global Technologies';
  const roleLabel = user ? userRole.toUpperCase() : '';

  return (
    <header className="h-16 border-b border-line bg-app px-3 sm:px-5 flex items-center justify-between gap-2 sticky top-0 z-20 select-none">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <button
          onClick={onMenuClick}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 -ml-1 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-3 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-surface-2 border border-line text-xs min-w-0">
          <Building className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="font-medium text-ink truncate max-w-[110px] sm:max-w-none">{currentOrgName}</span>
          {roleLabel && (
            <span className="hidden sm:inline-flex items-center text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-accent/10 text-accent ml-1">
              {roleLabel}
            </span>
          )}
        </div>
      </div>

      {/* Global Command Palette Trigger */}
      {onOpenSearch && (
        <button
          onClick={onOpenSearch}
          className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-line text-xs text-ink-muted hover:text-ink transition-colors cursor-pointer w-64 justify-between"
          title="Search companies, contacts, campaigns (Ctrl+K or ⌘K)"
        >
          <div className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-ink-subtle" />
            <span className="text-[11px]">Quick search...</span>
          </div>
          <kbd className="px-1.5 py-0.5 rounded bg-surface border border-line text-[10px] font-mono text-ink-subtle">
            ⌘K
          </kbd>
        </button>
      )}

      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {onOpenSearch && (
          <button
            onClick={onOpenSearch}
            className="md:hidden p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-2 transition-colors"
            aria-label="Search"
          >
            <Search className="w-4 h-4" />
          </button>
        )}

        <ThemeToggle />

        {user ? (
          <AccountMenu />
        ) : (
          <Link
            to="/login"
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent hover:bg-accent-strong text-accent-fg text-xs font-medium transition-colors active:scale-[0.98]"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Sign In</span>
          </Link>
        )}
      </div>
    </header>
  );
}

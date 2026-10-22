import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Mail,
  Sparkles,
  Building2,
  Users,
  Compass,
  FileSpreadsheet,
  FileCode,
  FileEdit,
  Clock,
  Send,
  BarChart3,
  Briefcase,
  Layers,
  Settings,
  Radar,
  X,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { clsx } from 'clsx';

export interface NavItem {
  name: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

const navigationSections: { title: string; items: NavItem[] }[] = [
  {
    title: 'Workspace',
    items: [
      { name: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
      { name: 'Inbox', to: '/email', icon: Mail },
      { name: 'Campaigns', to: '/campaigns', icon: Send },
      { name: 'Follow-ups', to: '/follow-ups', icon: Clock },
      { name: 'Team', to: '/team', icon: UserCheck },
      { name: 'AI Email Studio', to: '/ai-studio', icon: Sparkles },
    ],
  },
  {
    title: 'Intelligence & CRM',
    items: [
      { name: 'Companies', to: '/companies', icon: Building2 },
      { name: 'Imports', to: '/csv-imports', icon: FileSpreadsheet },
      { name: 'Contacts', to: '/contacts', icon: Users },
      { name: 'Opportunities', to: '/opportunities', icon: Compass },
      { name: 'Drafts', to: '/drafts', icon: FileEdit },
    ],
  },
  {
    title: 'Outreach & Reporting',
    items: [
      { name: 'Templates', to: '/templates', icon: FileCode },
      { name: 'Deliverability', to: '/deliverability', icon: ShieldCheck },
      { name: 'Services', to: '/services', icon: Briefcase },
      { name: 'Analytics', to: '/analytics', icon: BarChart3 },
      { name: 'Integrations', to: '/integrations', icon: Layers },
      { name: 'Settings', to: '/settings', icon: Settings },
    ],
  },
];

export function Sidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const location = useLocation();

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden="true"
        className={clsx(
          'fixed inset-0 z-30 bg-overlay/40 transition-opacity duration-200 lg:hidden',
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      />

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 h-screen w-72 max-w-[85vw] bg-surface border-r border-line flex flex-col shrink-0 select-none transition-transform duration-200 ease-out',
          'lg:sticky lg:top-0 lg:z-20 lg:w-64 lg:max-w-none lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="h-16 flex items-center justify-between px-4 border-b border-line gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent text-accent-fg flex items-center justify-center">
              <Radar className="w-4 h-4" />
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-sm text-ink tracking-tight">Swaniki</div>
              <div className="text-[10px] text-ink-subtle font-medium">New Business Radar</div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close navigation menu"
            className="lg:hidden p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-3 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {navigationSections.map((section) => (
            <div key={section.title} className="space-y-1">
              <div className="px-3 pb-1 text-[10px] font-semibold tracking-wider text-ink-subtle uppercase">
                {section.title}
              </div>
              {section.items.map((item) => {
                const Icon = item.icon;
                const isDashboard = item.to === '/dashboard';
                const isDashboardActive =
                  isDashboard && (location.pathname === '/dashboard' || location.pathname === '/');
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={onClose}
                    end={item.to === '/dashboard' || item.to === '/'}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium transition-colors',
                        isActive || isDashboardActive
                          ? 'bg-accent/10 text-accent'
                          : 'text-ink-muted hover:text-ink hover:bg-surface-3'
                      )
                    }
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon className="w-4 h-4" />
                      <span>{item.name}</span>
                    </span>
                    {item.badge && <span className="ios-pill">{item.badge}</span>}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

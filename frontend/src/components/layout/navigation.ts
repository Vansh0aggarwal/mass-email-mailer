import type { ComponentType } from 'react';
import {
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  ContactRound,
  FilePenLine,
  Files,
  FileUp,
  Inbox,
  LayoutDashboard,
  MailCheck,
  Package,
  PenLine,
  Plug,
  Send,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  /** Only match the exact path (used for the dashboard root). */
  end?: boolean;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/** Single source of truth for the left rail, the mobile drawer and the header. */
export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Workspace',
    items: [
      { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, end: true },
      { label: 'Inbox', to: '/email', icon: Inbox },
      { label: 'Campaigns', to: '/campaigns', icon: Send },
      { label: 'Follow-ups', to: '/follow-ups', icon: CalendarClock },
      { label: 'Team', to: '/team', icon: Users },
      { label: 'AI Email Studio', to: '/ai-studio', icon: Sparkles },
      { label: 'Design Studio', to: '/email-studio', icon: PenLine },
    ],
  },
  {
    title: 'Lead Intelligence',
    items: [
      { label: 'Companies', to: '/companies', icon: Building2 },
      { label: 'Imports', to: '/csv-imports', icon: FileUp },
      { label: 'Contacts', to: '/contacts', icon: ContactRound },
      { label: 'Opportunities', to: '/opportunities', icon: BriefcaseBusiness },
    ],
  },
  {
    title: 'Outreach',
    items: [
      { label: 'Drafts', to: '/drafts', icon: FilePenLine },
      { label: 'Templates', to: '/templates', icon: Files },
      { label: 'Deliverability', to: '/deliverability', icon: MailCheck },
      { label: 'Services', to: '/services', icon: Package },
    ],
  },
  {
    title: 'Insights & System',
    items: [
      { label: 'Integrations', to: '/integrations', icon: Plug },
      { label: 'Settings', to: '/settings', icon: Settings },
    ],
  },
];

export interface RouteMeta {
  title: string;
  description: string;
}

const ROUTE_META: Record<string, RouteMeta> = {
  '/': { title: 'Dashboard', description: 'Your pipeline, opportunities, and outreach at a glance' },
  '/dashboard': { title: 'Dashboard', description: 'Your pipeline, opportunities, and outreach at a glance' },
  '/email': { title: 'Inbox', description: 'Read, reply, and manage your connected mailboxes' },
  '/campaigns': { title: 'Campaigns', description: 'Build, schedule, and track outbound campaigns' },
  '/campaigns/new': { title: 'New campaign', description: 'Import prospects and compose a sequence' },
  '/campaigns/splits': { title: 'Split imports', description: 'Turn one prospect file into a group of draft campaigns' },
  '/campaigns/splits/new': { title: 'New split import', description: 'Validate contacts and generate child campaigns' },
  '/follow-ups': { title: 'Follow-ups', description: 'Stay on top of scheduled and overdue touchpoints' },
  '/team': { title: 'Team', description: 'Manage members, roles, and organization access' },
  '/ai-studio': { title: 'AI Email Studio', description: 'Draft grounded outreach with human review' },
  '/email-studio': { title: 'Design Studio', description: 'Design premium HTML email with grounded copy and human approval' },
  '/companies': { title: 'Companies', description: 'Target accounts and their audit intelligence' },
  '/contacts': { title: 'Contacts', description: 'People associated with your target accounts' },
  '/opportunities': { title: 'Opportunities', description: 'Ranked service opportunities with transparent scoring' },
  '/csv-imports': { title: 'Imports', description: 'Bring prospect lists in with validation and dedupe' },
  '/drafts': { title: 'Drafts', description: 'Review and refine outreach before it sends' },
  '/templates': { title: 'Templates', description: 'Reusable sequences and message templates' },
  '/deliverability': { title: 'Deliverability', description: 'Sender health, authentication, and quotas' },
  '/services': { title: 'Services', description: 'Your service catalog used for opportunity matching' },
  '/analytics': { title: 'Analytics', description: 'Campaign performance and engagement trends' },
  '/integrations': { title: 'Integrations', description: 'Connect Gmail and Google Calendar' },
  '/settings': { title: 'Settings', description: 'Workspace, sending, and account preferences' },
};

const FALLBACK_META: RouteMeta = {
  title: 'Workspace',
  description: 'Swaniki New Business Radar',
};

/** Resolves the contextual header copy for the active route. */
export function getRouteMeta(pathname: string): RouteMeta {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  const exact = ROUTE_META[normalized];
  if (exact) return exact;

  if (/^\/campaigns\/splits\/[^/]+$/.test(normalized)) {
    return { title: 'Split import overview', description: 'Parent import progress and generated child campaigns' };
  }
  if (/^\/campaigns\/[^/]+$/.test(normalized)) {
    return { title: 'Campaign detail', description: 'Monitor progress, recipients, and reply performance' };
  }
  if (/^\/companies\/[^/]+$/.test(normalized)) {
    return { title: 'Company profile', description: 'Account details, contacts, and opportunities' };
  }

  const base = `/${normalized.split('/')[1] || ''}`;
  return ROUTE_META[base] ?? FALLBACK_META;
}

/** Dashboard is reachable from the index route and from /dashboard. */
export function isDashboardPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/dashboard';
}

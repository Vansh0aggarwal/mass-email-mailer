import {
  Inbox,
  Star,
  Clock,
  Send,
  FileEdit,
  AlertOctagon,
  Trash2,
  Mail,
  PenSquare,
  RefreshCw,
  CheckCircle2,
  Plus,
  AtSign,
  AlertCircle,
  ShieldCheck,
} from 'lucide-react';
import type { EmailAccount } from '../../types';
import type { MailCounts, MailFolder } from '../../lib/mail';
import { useAuth } from '../../context/AuthContext';
import { Avatar } from '../shared/Avatar';

interface MailSidebarProps {
  mailboxes: EmailAccount[];
  mailboxesLoading?: boolean;
  mailboxesError?: boolean;
  onRetryMailboxes?: () => void;
  selectedMailbox: string;
  onSelectMailbox: (email: string) => void;
  onAddGmail: () => void;
  folder: MailFolder;
  onSelectFolder: (folder: MailFolder) => void;
  counts?: MailCounts;
  onCompose: () => void;
  onSync: () => void;
  isSyncing: boolean;
}

interface FolderConfig {
  id: MailFolder;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
  badge?: number;
}

interface AccountStatus {
  label: string;
  dotClass: string;
  badgeClass: string;
  needsReconnect: boolean;
}

/**
 * Classifies a mailbox for display. Distinguishes a genuinely connected Gmail
 * account from one that was disconnected or needs re-authorization so the UI
 * never implies an account is live when it is not.
 */
export function describeAccountStatus(mb: EmailAccount): AccountStatus {
  if (mb.provider !== 'gmail') {
    return {
      label: 'Sandbox',
      dotClass: 'bg-accent',
      badgeClass: 'text-ink-subtle border-line',
      needsReconnect: false,
    };
  }
  if (mb.status === 'disconnected') {
    return {
      label: 'Disconnected',
      dotClass: 'bg-danger',
      badgeClass: 'text-danger border-danger/30',
      needsReconnect: true,
    };
  }
  if (mb.status === 'error' || mb.isPaused) {
    return {
      label: 'Reconnect',
      dotClass: 'bg-danger',
      badgeClass: 'text-danger border-danger/30',
      needsReconnect: true,
    };
  }
  if (mb.status === 'paused') {
    return {
      label: 'Paused',
      dotClass: 'bg-warning',
      badgeClass: 'text-warning border-warning/30',
      needsReconnect: false,
    };
  }
  if (mb.syncStatus === 'syncing') {
    return {
      label: 'Syncing',
      dotClass: 'bg-accent',
      badgeClass: 'text-accent border-accent/30',
      needsReconnect: false,
    };
  }
  return {
    label: 'Connected',
    dotClass: 'bg-success',
    badgeClass: 'text-success border-success/30',
    needsReconnect: false,
  };
}

export function MailSidebar({
  mailboxes,
  mailboxesLoading,
  mailboxesError,
  onRetryMailboxes,
  selectedMailbox,
  onSelectMailbox,
  onAddGmail,
  folder,
  onSelectFolder,
  counts,
  onCompose,
  onSync,
  isSyncing,
}: MailSidebarProps) {
  const { user, userRole } = useAuth();

  const folders: FolderConfig[] = [
    { id: 'inbox', label: 'Inbox', icon: Inbox, count: counts?.inbox, badge: counts?.inboxUnread },
    { id: 'starred', label: 'Starred', icon: Star, count: counts?.starred },
    { id: 'snoozed', label: 'Snoozed', icon: Clock, count: counts?.snoozed },
    { id: 'sent', label: 'Sent', icon: Send, count: counts?.sent },
    { id: 'drafts', label: 'Drafts', icon: FileEdit, count: counts?.drafts },
    { id: 'spam', label: 'Spam', icon: AlertOctagon, count: counts?.spam },
    { id: 'trash', label: 'Trash', icon: Trash2, count: counts?.trash },
    { id: 'all', label: 'All Mail', icon: Mail },
  ];

  const gmailAccounts = mailboxes.filter((m) => m.provider === 'gmail');
  const hasSelectedMailbox = Boolean(selectedMailbox) && mailboxes.length > 0;

  const renderAccountRow = (mb: EmailAccount) => {
    const isActive = mb.emailAddress.toLowerCase() === selectedMailbox.toLowerCase();
    const status = describeAccountStatus(mb);
    return (
      <button
        key={mb.emailAddress}
        type="button"
        onClick={() => onSelectMailbox(mb.emailAddress)}
        title={mb.emailAddress}
        className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-xs border transition-all text-left ${
          isActive
            ? 'bg-accent/10 text-accent border-accent/30 font-semibold'
            : 'bg-surface text-ink-muted border-line hover:bg-surface-3 hover:text-ink font-medium'
        }`}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${status.dotClass}`} />
        <span className="truncate flex-1">{mb.emailAddress}</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border shrink-0 ${status.badgeClass}`}>
          {status.label}
        </span>
      </button>
    );
  };

  return (
    <div className="flex flex-col h-full w-full bg-surface-2 border-r border-line">
      <div className="p-4 space-y-4 overflow-y-auto">
        <button
          onClick={onCompose}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent hover:bg-accent-strong text-accent-fg text-sm font-semibold transition-colors active:scale-[0.98]"
        >
          <PenSquare className="w-4 h-4" />
          <span>Compose</span>
        </button>

        {/* Signed-in Swaniki account (login identity, NOT a mailbox) */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold text-ink-subtle uppercase tracking-wider block px-1">
            Swaniki Account
          </label>
          <div className="flex items-center gap-2.5 p-2.5 rounded-xl bg-surface border border-line">
            <Avatar user={user} size={32} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-ink truncate">
                {user?.fullName || 'Signed-in user'}
              </div>
              <div className="text-[10px] text-ink-subtle truncate">
                {user?.email || 'Not signed in'}
              </div>
            </div>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/25 font-semibold shrink-0">
              {(userRole || 'owner').toUpperCase()}
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-1 text-[10px] text-ink-subtle">
            <ShieldCheck className="w-3 h-3 text-success" />
            <span>Signed in to Swaniki</span>
          </div>
        </div>

        {/* Connected Gmail accounts */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold text-ink-subtle uppercase tracking-wider block px-1">
            Connected Gmail Accounts
            {gmailAccounts.length > 0 && <span className="text-ink-subtle/70"> ({gmailAccounts.length})</span>}
          </label>

          {mailboxesLoading ? (
            <div className="space-y-1" aria-hidden>
              {[0, 1].map((i) => (
                <div key={i} className="h-9 rounded-xl skeleton" />
              ))}
            </div>
          ) : mailboxesError ? (
            <div className="p-3 rounded-xl bg-danger/10 border border-danger/25 text-[11px] text-danger space-y-2">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>Couldn’t load mailboxes.</span>
              </div>
              {onRetryMailboxes && (
                <button
                  type="button"
                  onClick={onRetryMailboxes}
                  className="w-full px-2 py-1 rounded-lg border border-danger/30 hover:bg-danger/10 font-medium transition-colors"
                >
                  Retry
                </button>
              )}
            </div>
          ) : gmailAccounts.length === 0 ? (
            <div className="p-3 rounded-xl bg-surface border border-dashed border-line text-[11px] text-ink-subtle leading-relaxed">
              <div className="flex items-center gap-2 text-ink-muted font-medium mb-1">
                <AtSign className="w-3.5 h-3.5" />
                <span>No Gmail account connected</span>
              </div>
              {user?.email ? (
                <span>
                  Signed in as <span className="text-ink-muted">{user.email}</span>. Authorize
                  Gmail to send and sync from a mailbox.
                </span>
              ) : (
                <span>Authorize Gmail to send and sync from a mailbox.</span>
              )}
            </div>
          ) : (
            <div className="space-y-1">{gmailAccounts.map(renderAccountRow)}</div>
          )}

          <button
            type="button"
            onClick={onAddGmail}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-line text-xs font-medium text-ink-muted hover:text-accent hover:border-accent/40 hover:bg-accent/5 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{gmailAccounts.length === 0 ? 'Connect Gmail' : 'Add Gmail Account'}</span>
          </button>
        </div>

        {/* Sandbox mailboxes (non-Gmail providers) */}
        {!mailboxesLoading && !mailboxesError && mailboxes.some((m) => m.provider !== 'gmail') && (
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold text-ink-subtle uppercase tracking-wider block px-1">
              Sandbox
            </label>
            <div className="space-y-1">
              {mailboxes.filter((m) => m.provider !== 'gmail').map(renderAccountRow)}
            </div>
          </div>
        )}
      </div>

      {hasSelectedMailbox ? (
        <>
          <nav className="flex-1 overflow-y-auto px-2.5 space-y-0.5">
            {folders.map((f) => {
              const Icon = f.icon;
              const isActive = folder === f.id;
              const showCount = counts !== undefined && f.count !== undefined && f.count > 0;
              return (
                <button
                  key={f.id}
                  onClick={() => onSelectFolder(f.id)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs transition-all ${
                    isActive
                      ? 'bg-accent/10 text-accent font-semibold'
                      : 'text-ink-muted hover:text-ink hover:bg-surface-3 font-medium'
                  }`}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{f.label}</span>
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {f.badge !== undefined && f.badge > 0 && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-accent text-accent-fg">
                        {f.badge}
                      </span>
                    )}
                    {showCount && (
                      <span className={`text-[10px] ${isActive ? 'text-accent' : 'text-ink-subtle'}`}>
                        {f.count}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="p-3 border-t border-line space-y-2">
            <button
              onClick={onSync}
              disabled={isSyncing}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-ink-muted hover:text-ink hover:bg-surface-3 border border-line transition-all disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Syncing...' : 'Sync mailbox'}</span>
            </button>
            <div className="flex items-center gap-2 px-1 text-[10px] text-ink-subtle">
              <CheckCircle2 className="w-3 h-3 text-success" />
              <span>AES-256-GCM encrypted tokens</span>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}

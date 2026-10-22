import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LogOut,
  Mail,
  Unlink,
  ChevronDown,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { EmailAccount } from '../../types';
import { ConfirmationModal } from '../common/ConfirmationModal';
import { Avatar } from '../shared/Avatar';
import { startGmailOAuth } from '../../lib/api';

export function AccountMenu() {
  const { user, organizations, currentOrgId, userRole, logout } = useAuth();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false);
  const [isSignOutModalOpen, setIsSignOutModalOpen] = useState(false);
  const [isClearDataModalOpen, setIsClearDataModalOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<EmailAccount | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    []
  );

  const { data: mailboxes = [] } = useQuery<EmailAccount[]>({
    queryKey: ['mailboxes'],
    queryFn: async () => {
      const res = await fetch('/api/v1/mailboxes', { credentials: 'include' });
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    },
    enabled: !!user,
  });

  const gmailAccounts = mailboxes.filter((m) => m.provider === 'gmail');
  const isGmailConnected = gmailAccounts.some((m) => m.status === 'connected' && !m.isPaused);

  const showFeedback = (msg: string, ms = 6000) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedbackMessage(msg);
    feedbackTimer.current = setTimeout(() => setFeedbackMessage(null), ms);
  };

  const disconnectMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch(`/api/v1/integrations/google/gmail/${encodeURIComponent(email)}/disconnect`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to disconnect Gmail');
      }
      return res.json();
    },
    onSuccess: (resData) => {
      const targetEmail = disconnectTarget?.emailAddress;
      setIsDisconnectModalOpen(false);
      setDisconnectTarget(null);
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      if (targetEmail) queryClient.removeQueries({ queryKey: ['threads', targetEmail] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      showFeedback(resData.message || 'Gmail disconnected successfully.');
    },
    onError: (err: any) => {
      showFeedback(`Disconnection failed: ${err.message}`);
    },
  });

  const activeOrg = organizations.find((o) => o._id === currentOrgId);
  const orgName = activeOrg ? activeOrg.name : 'Swaniki Enterprise';
  const displayName = user ? user.fullName : 'Guest User';

  const handleConnectGmail = () => {
    startGmailOAuth('/email').catch((err: Error) => {
      showFeedback(err.message || 'Failed to start Gmail connection. Please try again.');
    });
  };

  const handleConfirmDisconnect = () => {
    if (disconnectTarget) {
      disconnectMutation.mutate(disconnectTarget.emailAddress);
    }
  };

  const handleConfirmSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await logout();
    } catch (err: any) {
      showFeedback(err?.message || 'Sign out failed. Please try again.');
      setIsSigningOut(false);
      setIsSignOutModalOpen(false);
    }
  };

  const handleConfirmClearData = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await logout({ clearMailData: true });
    } catch (err: any) {
      showFeedback(
        err?.message || 'Could not clear mail data. You are still signed in — please retry.'
      );
      setIsSigningOut(false);
      setIsClearDataModalOpen(false);
    }
  };

  if (!user) return null;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 p-1.5 pl-2.5 pr-3 rounded-full bg-surface-2 hover:bg-surface-3 border border-line transition-colors text-left active:scale-[0.98]"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <Avatar user={user} size={28} />

        <div className="hidden sm:block text-left">
          <div className="text-xs font-semibold text-ink leading-tight truncate max-w-[120px]">
            {displayName}
          </div>
          <div className="text-[10px] text-ink-subtle flex items-center gap-1">
            {isGmailConnected ? (
              <span className="text-success flex items-center gap-1">
                <span className="status-dot" />
                Gmail connected
              </span>
            ) : (
              <span>{userRole.toUpperCase()}</span>
            )}
          </div>
        </div>

        <ChevronDown
          className={`w-3.5 h-3.5 text-ink-subtle transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-1.5rem)] p-4 bg-surface border border-line rounded-xl shadow-pop z-50 space-y-4 animate-scale-in"
        >
          <div className="flex items-start gap-3 pb-3 border-b border-line">
            <Avatar user={user} size={40} className="rounded-xl shrink-0" />

            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-ink tracking-tight truncate">{displayName}</div>
              <div className="text-xs text-ink-muted truncate">{user.email}</div>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <span className="badge badge-info font-semibold">{userRole.toUpperCase()}</span>
                <span className="badge badge-neutral truncate max-w-[130px]">{orgName}</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-ink-subtle uppercase tracking-wider px-1">
              Gmail Mailboxes {gmailAccounts.length > 0 && <span>({gmailAccounts.length})</span>}
            </div>

            <div className="p-3 rounded-xl bg-surface-2 border border-line space-y-2.5">
              {gmailAccounts.length === 0 ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-surface-3 text-ink-subtle border border-line">
                      <Mail className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-ink tracking-tight">No mailbox connected</div>
                      <div className="text-[10px] text-ink-subtle truncate max-w-[160px]">
                        Sandbox simulation active
                      </div>
                    </div>
                  </div>
                  <span className="badge badge-neutral">Sandbox</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {gmailAccounts.map((mb) => {
                    const live = mb.status === 'connected' && !mb.isPaused;
                    const label = live ? 'Live' : mb.status === 'disconnected' ? 'Disconnected' : 'Reconnect';
                    return (
                      <div key={mb.emailAddress} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border ${
                              live
                                ? 'bg-success/10 text-success border-success/25'
                                : 'bg-surface-3 text-ink-subtle border-line'
                            }`}
                          >
                            <Mail className="w-3.5 h-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-ink tracking-tight truncate max-w-[150px]">
                              {mb.emailAddress}
                            </div>
                            <div className="text-[10px] text-ink-subtle truncate max-w-[150px] tabular-nums">
                              {live
                                ? `${mb.sendsToday}/${mb.dailySendLimit} sends today`
                                : mb.pausedReason || 'Not connected'}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className={`badge ${live ? 'badge-success' : 'badge-neutral'}`}>{label}</span>
                          {live ? (
                            <button
                              onClick={() => {
                                setIsOpen(false);
                                setDisconnectTarget(mb);
                                setIsDisconnectModalOpen(true);
                              }}
                              className="p-1.5 rounded-lg text-ink-subtle hover:text-danger hover:bg-surface-3 transition-colors"
                              aria-label={`Disconnect ${mb.emailAddress}`}
                              title={`Disconnect ${mb.emailAddress}`}
                            >
                              <Unlink className="w-3.5 h-3.5" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <button
                onClick={() => {
                  setIsOpen(false);
                  handleConnectGmail();
                }}
                className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-accent hover:bg-accent-strong text-accent-fg text-xs font-medium transition-colors active:scale-95"
              >
                <Mail className="w-3.5 h-3.5" />
                <span>{gmailAccounts.length === 0 ? 'Connect Gmail' : 'Add Gmail account'}</span>
              </button>
            </div>
          </div>

          <div className="pt-2 border-t border-line space-y-2">
            <div className="text-[10px] font-semibold text-ink-subtle uppercase tracking-wider px-1">
              Application session
            </div>

            <p className="text-[11px] text-ink-muted leading-relaxed px-1">
              Signing out ends your Swaniki session but keeps your connected Gmail and CRM data. Use
              <span className="font-medium text-ink"> Sign out &amp; clear data</span> to also revoke Gmail
              access and delete synced mail from this device.
            </p>

            <button
              onClick={() => {
                setIsOpen(false);
                setIsSignOutModalOpen(true);
              }}
              disabled={isSigningOut}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg bg-surface-2 hover:bg-surface-3 text-ink border border-line text-xs font-medium transition-colors active:scale-95 disabled:opacity-50"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign out of Swaniki</span>
            </button>

            <button
              onClick={() => {
                setIsOpen(false);
                setIsClearDataModalOpen(true);
              }}
              disabled={isSigningOut}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg bg-danger/10 hover:bg-danger/15 text-danger border border-danger/25 text-xs font-medium transition-colors active:scale-95 disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Sign out &amp; clear mail data</span>
            </button>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={isDisconnectModalOpen}
        onClose={() => {
          setIsDisconnectModalOpen(false);
          setDisconnectTarget(null);
        }}
        onConfirm={handleConfirmDisconnect}
        isLoading={disconnectMutation.isPending}
        isDestructive={true}
        icon={Unlink}
        title="Disconnect Gmail mailbox"
        description={`Disconnect ${disconnectTarget?.emailAddress || 'your Gmail account'} from Swaniki?`}
        details={[
          'Google OAuth authorization grant will be revoked with Google Accounts (best effort).',
          'Stored encrypted tokens will be permanently deleted.',
          'Synced threads, message bodies, attachments and cached metadata for this mailbox will be deleted.',
          'Sending and syncing for this mailbox will stop. You will remain signed in.',
          'Your company accounts, contacts, campaigns and drafts remain intact.',
        ]}
        confirmText="Disconnect Gmail"
        cancelText="Keep connected"
      />

      <ConfirmationModal
        isOpen={isSignOutModalOpen}
        onClose={() => setIsSignOutModalOpen(false)}
        onConfirm={handleConfirmSignOut}
        isLoading={isSigningOut}
        isDestructive={false}
        icon={LogOut}
        title="Sign out of Swaniki"
        description="Are you sure you want to sign out of Swaniki New Business Radar?"
        details={[
          'Your active Swaniki session will be revoked and all auth cookies cleared.',
          'Protected workspace pages will require authentication to access.',
          'Your connected Gmail authorization and CRM data remain preserved for your next login.',
        ]}
        confirmText="Sign out"
        cancelText="Cancel"
      />

      <ConfirmationModal
        isOpen={isClearDataModalOpen}
        onClose={() => setIsClearDataModalOpen(false)}
        onConfirm={handleConfirmClearData}
        isLoading={isSigningOut}
        isDestructive={true}
        icon={Trash2}
        title="Sign out and clear mail data"
        description="This signs you out and permanently deletes the mail synced from your connected Gmail mailboxes on this device."
        details={[
          'All Gmail mailboxes you connected will be disconnected and their Google grants revoked (best effort).',
          'Synced threads, message bodies, attachments, tokens and sync state will be deleted.',
          'Your company accounts, contacts, campaigns, drafts and organization data remain intact.',
          'You will need to reconnect and re-authorize Gmail after signing back in.',
        ]}
        confirmText="Sign out & clear data"
        cancelText="Cancel"
      />

      {feedbackMessage && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-[60] max-w-xs p-3 rounded-xl bg-surface border border-danger/30 text-xs text-ink leading-relaxed shadow-pop animate-scale-in"
        >
          {feedbackMessage}
        </div>
      )}
    </div>
  );
}

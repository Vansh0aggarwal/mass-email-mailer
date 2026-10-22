import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  RefreshCw,
  Unlink,
  Menu,
  PanelRight,
  Star,
  Archive,
  Trash2,
  AlertOctagon,
  MailOpen,
  AlertCircle,
  AtSign,
} from 'lucide-react';
import type { EmailAccount } from '../types';
import { mailApi, mailKeys } from '../lib/mail';
import type { MailFolder, MailThread } from '../lib/mail';
import { useAuth } from '../context/AuthContext';
import { MailSidebar } from '../components/mail/MailSidebar';
import { MessageList } from '../components/mail/MessageList';
import { ConversationView } from '../components/mail/ConversationView';
import { ComposePanel } from '../components/mail/ComposePanel';
import { IntelligencePanel } from '../components/mail/IntelligencePanel';
import { ConfirmationModal } from '../components/common/ConfirmationModal';
import { startGmailOAuth } from '../lib/api';

type ThreadListData = { data: MailThread[]; meta?: any };

export function EmailWorkspacePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const emailParam = searchParams.get('email');
  const justConnected = searchParams.get('gmail_connected') === 'true';
  const urlError = searchParams.get('error');

  const [folder, setFolder] = useState<MailFolder>('inbox');
  const [selectedMailbox, setSelectedMailbox] = useState<string>('');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [mobilePanel, setMobilePanel] = useState<'list' | 'thread'>('list');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showContext, setShowContext] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MailThread | null>(null);
  const markedRead = useRef<Set<string>>(new Set());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushToast = (message: string, ms = 4000) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  };

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
  );

  // Debounce the search box
  useEffect(() => {
    const handle = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // 1. Mailboxes
  const {
    data: mailboxes = [],
    isLoading: mailboxesLoading,
    isError: mailboxesError,
    refetch: refetchMailboxes,
  } = useQuery<EmailAccount[]>({
    queryKey: mailKeys.mailboxes,
    queryFn: mailApi.listMailboxes,
  });

  useEffect(() => {
    if (mailboxes.length === 0) return;
    if (emailParam && mailboxes.some((m) => m.emailAddress.toLowerCase() === emailParam.toLowerCase())) {
      setSelectedMailbox(emailParam.toLowerCase());
      return;
    }
    const gmail = mailboxes.find((m) => m.provider === 'gmail' && m.status === 'connected') || mailboxes.find((m) => m.provider === 'gmail');
    setSelectedMailbox((current) => {
      const exists = mailboxes.some((m) => m.emailAddress.toLowerCase() === current.toLowerCase());
      if (exists) return current;
      return (gmail || mailboxes[0]).emailAddress;
    });
  }, [mailboxes, emailParam]);

  const activeAccount: EmailAccount =
    mailboxes.find((m) => m.emailAddress.toLowerCase() === selectedMailbox.toLowerCase()) ||
    ({
      _id: 'fallback',
      organizationId: '',
      emailAddress: selectedMailbox,
      displayName: 'Mailbox',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 100,
      sendsToday: 0,
      isPaused: false,
      createdAt: '',
      updatedAt: '',
    } as EmailAccount);

  const isGmailActive = activeAccount.provider === 'gmail';
  const needsReconnect = activeAccount.status === 'error' || activeAccount.isPaused;

  // 2. Counts
  const { data: counts } = useQuery({
    queryKey: mailKeys.counts(selectedMailbox),
    queryFn: () => mailApi.getCounts(selectedMailbox),
    enabled: !!selectedMailbox,
  });

  // 3. Threads
  const threadsQuery = useQuery<ThreadListData>({
    queryKey: mailKeys.threads(selectedMailbox, folder, searchQuery, page),
    queryFn: () =>
      mailApi.listThreads(selectedMailbox, { folder, q: searchQuery || undefined, page, limit: 25 }),
    enabled: !!selectedMailbox,
  });
  const threads = threadsQuery.data?.data ?? [];
  const hasMore = threadsQuery.data?.meta?.hasMore ?? false;
  const totalThreads = threadsQuery.data?.meta?.total ?? threads.length;

  // 4. Selected thread detail
  const listThread = useMemo(
    () => threads.find((t) => t.threadId === selectedThreadId),
    [threads, selectedThreadId]
  );

  const detailQuery = useQuery({
    queryKey: mailKeys.thread(selectedMailbox, selectedThreadId || ''),
    queryFn: () => mailApi.getThread(selectedMailbox, selectedThreadId as string),
    enabled: !!selectedMailbox && !!selectedThreadId,
  });

  // Keep the selection valid within the current list
  useEffect(() => {
    if (threads.length === 0) {
      setSelectedThreadId(null);
      return;
    }
    if (!selectedThreadId || !threads.some((t) => t.threadId === selectedThreadId)) {
      setSelectedThreadId(threads[0].threadId);
    }
  }, [threads, selectedThreadId]);

  // Reset selection state and pagination when the mailbox/folder/search changes
  useEffect(() => {
    setSelectedIds(new Set());
    markedRead.current = new Set();
    setPage(1);
  }, [selectedMailbox, folder, searchQuery]);

  const invalidateMail = () => {
    queryClient.invalidateQueries({ queryKey: ['threads', selectedMailbox] });
    queryClient.invalidateQueries({ queryKey: mailKeys.counts(selectedMailbox) });
  };

  const updateThreadCaches = (threadId: string, changes: Partial<MailThread>) => {
    queryClient.setQueriesData<ThreadListData>({ queryKey: ['threads', selectedMailbox] }, (old) => {
      if (!old) return old;
      return {
        ...old,
        data: old.data.map((t) => (t.threadId === threadId ? { ...t, ...changes } : t)),
      };
    });
    queryClient.setQueryData(mailKeys.thread(selectedMailbox, threadId), (old: any) =>
      old ? { ...old, ...changes } : old
    );
  };

  const removeThreadFromCache = (threadId: string) => {
    queryClient.setQueriesData<ThreadListData>({ queryKey: ['threads', selectedMailbox] }, (old) => {
      if (!old) return old;
      return { ...old, data: old.data.filter((t) => t.threadId !== threadId) };
    });
  };

  // --- Mutations -----------------------------------------------------------

  const patchMutation = useMutation({
    mutationFn: ({ threadId, changes }: { threadId: string; changes: Record<string, any> }) =>
      mailApi.patchThread(selectedMailbox, threadId, changes),
    onSuccess: (_data, vars) => {
      const affectsList = ['isArchived', 'isSpam', 'isTrash', 'isSnoozed'].some((k) => k in vars.changes);
      if (affectsList) {
        invalidateMail();
      } else {
        updateThreadCaches(vars.threadId, vars.changes as Partial<MailThread>);
        queryClient.invalidateQueries({ queryKey: mailKeys.counts(selectedMailbox) });
      }
    },
    onError: (err: any) => pushToast(`Action failed: ${err.message}`, 5000),
  });

  const bulkMutation = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: string }) =>
      mailApi.bulkAction(selectedMailbox, ids, action),
    onSuccess: (data) => {
      invalidateMail();
      setSelectedIds(new Set());
      pushToast(`Updated ${data.updatedCount} conversation${data.updatedCount === 1 ? '' : 's'}.`);
    },
    onError: (err: any) => pushToast(`Bulk action failed: ${err.message}`, 5000),
  });

  const deleteMutation = useMutation({
    mutationFn: (threadId: string) => mailApi.deleteThread(selectedMailbox, threadId),
    onSuccess: (_d, threadId) => {
      removeThreadFromCache(threadId);
      invalidateMail();
      setDeleteTarget(null);
      pushToast('Conversation permanently deleted.');
    },
    onError: (err: any) => {
      setDeleteTarget(null);
      pushToast(`Delete failed: ${err.message}`, 5000);
    },
  });

  const replyMutation = useMutation({
    mutationFn: ({ threadId, payload }: { threadId: string; payload: any }) =>
      mailApi.reply(selectedMailbox, threadId, payload),
    onSuccess: (thread, vars) => {
      queryClient.setQueryData(mailKeys.thread(selectedMailbox, vars.threadId), thread);
      updateThreadCaches(vars.threadId, {
        snippet: thread.snippet,
        lastMessageDate: thread.lastMessageDate,
        messageCount: thread.messageCount,
        isRead: true,
        unreadCount: 0,
      });
      queryClient.invalidateQueries({ queryKey: mailKeys.counts(selectedMailbox) });
      pushToast(isGmailActive ? 'Reply sent via Gmail.' : 'Reply saved to thread.');
    },
  });

  const composeMutation = useMutation({
    mutationFn: (payload: any) => mailApi.compose(selectedMailbox, payload),
    onSuccess: (data) => {
      setComposerOpen(false);
      invalidateMail();
      pushToast(data.isSimulated ? 'Message sent (sandbox simulation).' : 'Message sent via Gmail.');
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => mailApi.sync(selectedMailbox),
    onSuccess: (data) => {
      invalidateMail();
      queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
      pushToast(`Synced ${data.syncedCount} conversation${data.syncedCount === 1 ? '' : 's'}.`);
    },
    onError: (err: any) => {
      queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
      if (err.code === 'GMAIL_REAUTH_REQUIRED') {
        pushToast('Gmail authorization expired. Please reconnect.', 6000);
      } else {
        pushToast(`Sync failed: ${err.message}`, 6000);
      }
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (email: string) => mailApi.disconnectGmail(email),
    onSuccess: (data: any) => {
      setDisconnectOpen(false);
      queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
      invalidateMail();
      pushToast(data?.revocationWarning || 'Gmail disconnected.');
      const fallback = mailboxes.find((m) => m.provider !== 'gmail')?.emailAddress;
      if (fallback) setSelectedMailbox(fallback);
    },
    onError: (err: any) => {
      setDisconnectOpen(false);
      pushToast(`Disconnect failed: ${err.message}`, 5000);
    },
  });

  // Handle the Gmail OAuth return (success or failure) exactly once.
  useEffect(() => {
    if (!justConnected && !urlError) return;

    if (urlError) {
      pushToast(`Gmail connection failed: ${decodeURIComponent(urlError)}`, 8000);
    }

    if (justConnected) {
      const connectedEmail = emailParam?.toLowerCase();
      queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });

      if (connectedEmail) {
        setSelectedMailbox(connectedEmail);
        setToast('Gmail connected. Syncing inbox...');
        mailApi
          .sync(connectedEmail)
          .then((data) => {
            queryClient.invalidateQueries({ queryKey: ['threads', connectedEmail] });
            queryClient.invalidateQueries({ queryKey: mailKeys.counts(connectedEmail) });
            queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
            pushToast(
              `Synced ${data.syncedCount} conversation${data.syncedCount === 1 ? '' : 's'}.`
            );
          })
          .catch((err: any) => {
            queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
            pushToast(err?.message || 'Connected, but the first sync failed. Use Sync to retry.', 6000);
          });
      }
    }

    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justConnected, urlError]);

  // Mark the opened conversation as read
  useEffect(() => {
    if (!listThread || listThread.isRead) return;
    if (markedRead.current.has(listThread.threadId)) return;
    markedRead.current.add(listThread.threadId);
    patchMutation.mutate({ threadId: listThread.threadId, changes: { isRead: true } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listThread]);

  // --- Handlers ------------------------------------------------------------

  const selectThread = (thread: MailThread) => {
    setSelectedThreadId(thread.threadId);
    setMobilePanel('thread');
  };

  const toggleStar = (thread: MailThread) => {
    const next = !thread.isStarred;
    updateThreadCaches(thread.threadId, { isStarred: next });
    patchMutation.mutate({ threadId: thread.threadId, changes: { isStarred: next } });
  };

  const archiveThread = (thread: MailThread) => {
    removeThreadFromCache(thread.threadId);
    patchMutation.mutate({ threadId: thread.threadId, changes: { isArchived: true } });
    pushToast('Conversation archived.');
  };

  const spamThread = (thread: MailThread) => {
    removeThreadFromCache(thread.threadId);
    patchMutation.mutate({ threadId: thread.threadId, changes: { isSpam: true } });
    pushToast('Marked as spam.');
  };

  const trashThread = (thread: MailThread) => {
    if (folder === 'trash') {
      setDeleteTarget(thread);
      return;
    }
    removeThreadFromCache(thread.threadId);
    patchMutation.mutate({ threadId: thread.threadId, changes: { isTrash: true } });
    pushToast('Moved to Trash.');
  };

  const markUnread = (thread: MailThread) => {
    markedRead.current.delete(thread.threadId);
    updateThreadCaches(thread.threadId, { isRead: false, unreadCount: thread.messageCount });
    patchMutation.mutate({ threadId: thread.threadId, changes: { isRead: false } });
    setMobilePanel('list');
  };

  const toggleSelect = (threadId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (threads.every((t) => prev.has(t.threadId))) return new Set();
      return new Set(threads.map((t) => t.threadId));
    });
  };

  const runBulk = (action: string) => {
    if (selectedIds.size === 0) return;
    bulkMutation.mutate({ ids: Array.from(selectedIds), action });
  };

  // Reconnect the account that is currently in an error/paused state.
  // Passes the existing email as a login_hint so Google pre-selects it.
  const handleConnectGmail = () => {
    startGmailOAuth('/email', activeAccount.emailAddress).catch((err: Error) => {
      pushToast(err.message || 'Failed to start Gmail reconnection. Please try again.');
    });
  };

  // Add a NEW mailbox. Deliberately omits `email` (login_hint) so Google always
  // shows its account chooser and a different account can be authorized.
  const handleAddGmail = () => {
    startGmailOAuth('/email').catch((err: Error) => {
      pushToast(err.message || 'Failed to start Gmail connection. Please try again.');
    });
  };

  const bulkActions = [
    { action: 'markRead', label: 'Mark read', icon: MailOpen },
    { action: 'star', label: 'Star', icon: Star },
    { action: 'archive', label: 'Archive', icon: Archive },
    { action: 'spam', label: 'Spam', icon: AlertOctagon },
    { action: 'trash', label: 'Trash', icon: Trash2 },
  ];

  return (
    <div className="flex flex-col h-[calc(100dvh-7.5rem)] lg:h-[calc(100vh-6.5rem)] ios-card overflow-hidden border border-line bg-surface">
      {/* Account status toolbar */}
      <div className="bg-surface-2 px-4 py-2 border-b border-line flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="lg:hidden p-1.5 -ml-1 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-3"
            aria-label="Open folders"
          >
            <Menu className="w-4 h-4" />
          </button>
          <span
            className="flex items-center gap-1.5 text-[11px] text-ink-muted bg-surface border border-line rounded-full px-2.5 py-1 min-w-0"
            title={user?.email || 'Signed in'}
          >
            <AtSign className="w-3 h-3 shrink-0" />
            <span className="truncate max-w-[10rem]">{user?.email || 'Signed in'}</span>
          </span>
          {selectedMailbox && (
            <>
              <span className="text-ink-subtle hidden sm:inline">·</span>
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  needsReconnect ? 'bg-danger' : isGmailActive ? 'bg-success' : 'bg-accent'
                }`}
              />
              <span className="text-ink-muted min-w-0 truncate">
                <strong className="text-ink font-medium">{activeAccount.emailAddress}</strong>
              </span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full border ${
                  needsReconnect
                    ? 'text-danger border-danger/30'
                    : isGmailActive
                    ? 'text-success border-success/30'
                    : 'text-accent border-accent/30'
                }`}
              >
                {needsReconnect ? 'Reconnect' : isGmailActive ? 'Gmail API' : 'Sandbox'}
              </span>
              {!needsReconnect && activeAccount.syncStatus === 'syncing' && (
                <span className="text-[10px] text-accent flex items-center gap-1">
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  <span className="hidden sm:inline">Syncing…</span>
                </span>
              )}
              {!needsReconnect && activeAccount.syncStatus === 'error' && (
                <span
                  className="text-[10px] text-warning flex items-center gap-1 min-w-0"
                  title={activeAccount.lastSyncError || 'Last sync failed'}
                >
                  <AlertCircle className="w-3 h-3 shrink-0" />
                  <span className="hidden sm:inline truncate max-w-[16rem]">Last sync failed</span>
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {toast && (
            <span className="text-[11px] text-accent bg-accent/10 px-3 py-1 rounded-full border border-accent/25 animate-fade-in font-medium max-w-[16rem] truncate">
              {toast}
            </span>
          )}
          {selectedMailbox && needsReconnect ? (
            <button
              onClick={handleConnectGmail}
              className="btn-danger flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reconnect</span>
            </button>
          ) : selectedMailbox ? (
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-line text-ink-muted hover:text-ink hover:bg-surface-3 text-xs font-medium transition-all disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
              Sync
            </button>
          ) : null}
          {isGmailActive && (
            <button
              onClick={() => setDisconnectOpen(true)}
              className="p-1.5 rounded-lg text-ink-muted hover:text-danger hover:bg-surface-3 transition-colors"
              title="Disconnect Gmail"
            >
              <Unlink className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => setShowContext((v) => !v)}
            className={`p-1.5 rounded-lg transition-colors hidden xl:block ${
              showContext ? 'text-accent bg-accent/10' : 'text-ink-muted hover:text-ink hover:bg-surface-3'
            }`}
            title="Toggle context panel"
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Reauth banner */}
      {isGmailActive && needsReconnect && (
        <div className="bg-danger/10 border-b border-danger/30 px-4 py-2 flex items-center justify-between gap-3 text-xs shrink-0">
          <span className="text-ink">
            <strong>Reconnection required.</strong>{' '}
            {activeAccount.pausedReason || 'Gmail access was revoked or expired.'}
          </span>
          <button
            onClick={handleConnectGmail}
            className="btn-danger px-3 py-1 font-medium shrink-0"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="bg-accent/10 border-b border-accent/20 px-3 py-1.5 flex items-center gap-2 text-xs shrink-0 overflow-x-auto">
          <span className="text-accent font-semibold shrink-0">{selectedIds.size} selected</span>
          {bulkActions.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.action}
                onClick={() => runBulk(a.action)}
                disabled={bulkMutation.isPending}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-line bg-surface hover:bg-surface-3 text-ink-muted hover:text-ink shrink-0 disabled:opacity-50"
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{a.label}</span>
              </button>
            );
          })}
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-ink-subtle hover:text-ink shrink-0 px-2"
          >
            Clear
          </button>
        </div>
      )}

      {/* Workspace */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Sidebar (desktop) */}
        <div className="hidden lg:block w-60 shrink-0">
          <MailSidebar
            mailboxes={mailboxes}
            mailboxesLoading={mailboxesLoading}
            mailboxesError={mailboxesError}
            onRetryMailboxes={() => refetchMailboxes()}
            selectedMailbox={selectedMailbox}
            onSelectMailbox={(email) => {
              setSelectedMailbox(email);
              setFolder('inbox');
            }}
            onAddGmail={handleAddGmail}
            folder={folder}
            onSelectFolder={(f) => {
              setFolder(f);
              setMobileNavOpen(false);
            }}
            counts={counts}
            onCompose={() => setComposerOpen(true)}
            onSync={() => syncMutation.mutate()}
            isSyncing={syncMutation.isPending}
          />
        </div>

        {/* Sidebar (mobile drawer) */}
        {mobileNavOpen && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div className="absolute inset-0 bg-overlay/50" onClick={() => setMobileNavOpen(false)} />
            <div className="relative w-72 max-w-[80%] h-full shadow-pop">
              <MailSidebar
                mailboxes={mailboxes}
                mailboxesLoading={mailboxesLoading}
                mailboxesError={mailboxesError}
                onRetryMailboxes={() => refetchMailboxes()}
                selectedMailbox={selectedMailbox}
                onSelectMailbox={(email) => {
                  setSelectedMailbox(email);
                  setFolder('inbox');
                }}
                onAddGmail={handleAddGmail}
                folder={folder}
                onSelectFolder={(f) => {
                  setFolder(f);
                  setMobileNavOpen(false);
                  setMobilePanel('list');
                }}
                counts={counts}
                onCompose={() => {
                  setComposerOpen(true);
                  setMobileNavOpen(false);
                }}
                onSync={() => syncMutation.mutate()}
                isSyncing={syncMutation.isPending}
              />
            </div>
          </div>
        )}

        {/* Message list */}
        <div
          className={`flex-col w-full lg:w-[22rem] shrink-0 border-r border-line ${
            mobilePanel === 'thread' ? 'hidden lg:flex' : 'flex'
          }`}
        >
          <MessageList
            threads={threads}
            isLoading={threadsQuery.isLoading}
            isError={threadsQuery.isError}
            errorMessage={threadsQuery.error instanceof Error ? threadsQuery.error.message : undefined}
            onRetry={() => threadsQuery.refetch()}
            selectedThreadId={selectedThreadId}
            onSelect={selectThread}
            folder={folder}
            searchQuery={searchInput}
            onSearchChange={setSearchInput}
            onRefresh={() => threadsQuery.refetch()}
            isRefreshing={threadsQuery.isFetching}
            canSelect
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            onToggleStar={toggleStar}
            onArchive={archiveThread}
            onDelete={trashThread}
            onSpam={spamThread}
            page={page}
            total={totalThreads}
            hasMore={hasMore}
            onPrevPage={() => setPage((p) => Math.max(1, p - 1))}
            onNextPage={() => setPage((p) => p + 1)}
          />
        </div>

        {/* Conversation + context */}
        <div className={`flex-1 min-w-0 ${mobilePanel === 'thread' ? 'flex' : 'hidden lg:flex'}`}>
          <div className="flex-1 min-w-0">
            <ConversationView
              thread={detailQuery.data}
              isLoading={detailQuery.isLoading}
              isError={detailQuery.isError}
              errorMessage={detailQuery.error instanceof Error ? detailQuery.error.message : undefined}
              onRetry={() => detailQuery.refetch()}
              onBack={() => setMobilePanel('list')}
              mailboxEmail={selectedMailbox}
              onReply={(payload) =>
                replyMutation
                  .mutateAsync({ threadId: selectedThreadId as string, payload })
                  .then(() => undefined)
              }
              isReplying={replyMutation.isPending}
              onToggleStar={() => detailQuery.data && toggleStar(detailQuery.data)}
              onArchive={() => detailQuery.data && archiveThread(detailQuery.data)}
              onDelete={() => detailQuery.data && trashThread(detailQuery.data)}
              onSpam={() => detailQuery.data && spamThread(detailQuery.data)}
              onMarkUnread={() => detailQuery.data && markUnread(detailQuery.data)}
              onOpenCompany={(companyId) => navigate(`/companies/${companyId}`)}
            />
          </div>
          {showContext && detailQuery.data && (
            <div className="hidden xl:block w-72 shrink-0">
              <IntelligencePanel
                thread={detailQuery.data}
                onOpenCompany={(companyId) => navigate(`/companies/${companyId}`)}
                onClose={() => setShowContext(false)}
              />
            </div>
          )}
        </div>
      </div>

      <ComposePanel
        isOpen={composerOpen}
        onClose={() => setComposerOpen(false)}
        mailboxEmail={selectedMailbox}
        onSend={(payload) => composeMutation.mutateAsync(payload).then(() => undefined)}
        isSending={composeMutation.isPending}
      />

      <ConfirmationModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.threadId)}
        title="Delete forever"
        description={`Permanently delete "${deleteTarget?.subject || 'this conversation'}"?`}
        details={[
          'This removes the conversation from Swaniki and, if connected, from Gmail.',
          'This action cannot be undone.',
        ]}
        confirmText="Delete forever"
        isDestructive
        isLoading={deleteMutation.isPending}
      />

      <ConfirmationModal
        isOpen={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={() => disconnectMutation.mutate(activeAccount.emailAddress)}
        title="Disconnect Gmail"
        description={`Disconnect ${activeAccount.emailAddress} from Swaniki Radar?`}
        details={[
          'Google OAuth authorization will be revoked.',
          'Stored access and refresh tokens will be deleted.',
          'Background sync and scheduled sending will stop.',
        ]}
        confirmText="Disconnect"
        isDestructive
        isLoading={disconnectMutation.isPending}
      />
    </div>
  );
}

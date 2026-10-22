import { useRef } from 'react';
import {
  Star,
  Archive,
  Trash2,
  AlertOctagon,
  Paperclip,
  Search,
  RefreshCw,
  Inbox,
  Check,
  AlertTriangle,
  X,
} from 'lucide-react';
import type { MailFolder, MailThread } from '../../lib/mail';
import { formatListDate, initialsOf } from '../../lib/mail';

interface MessageListProps {
  threads: MailThread[];
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  selectedThreadId: string | null;
  onSelect: (thread: MailThread) => void;
  folder: MailFolder;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  canSelect: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (threadId: string) => void;
  onToggleSelectAll: () => void;
  onToggleStar: (thread: MailThread) => void;
  onArchive: (thread: MailThread) => void;
  onDelete: (thread: MailThread) => void;
  onSpam: (thread: MailThread) => void;
  page: number;
  total: number;
  hasMore: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
}

export function MessageList({
  threads,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  selectedThreadId,
  onSelect,
  folder,
  searchQuery,
  onSearchChange,
  onRefresh,
  isRefreshing,
  canSelect,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onToggleStar,
  onArchive,
  onDelete,
  onSpam,
  page,
  total,
  hasMore,
  onPrevPage,
  onNextPage,
}: MessageListProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const allSelected = threads.length > 0 && threads.every((t) => selectedIds.has(t.threadId));

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line bg-surface-2">
        {canSelect ? (
          <button
            onClick={onToggleSelectAll}
            className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
              allSelected ? 'bg-accent border-accent text-accent-fg' : 'border-line-strong text-transparent hover:border-accent'
            }`}
            aria-label="Select all conversations"
          >
            <Check className="w-3 h-3" />
          </button>
        ) : (
          <div className="w-1" />
        )}

        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <input
            ref={searchRef}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search mail"
            className="w-full bg-surface border border-line rounded-xl pl-8 pr-8 py-1.5 text-xs text-ink placeholder:text-ink-subtle focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {searchQuery && (
            <button
              onClick={() => {
                onSearchChange('');
                searchRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-ink-subtle hover:text-ink"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-3 transition-colors disabled:opacity-50 shrink-0"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <div className="w-9 h-9 rounded-full skeleton shrink-0" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="h-3 w-1/3 rounded skeleton" />
                  <div className="h-3 w-4/5 rounded skeleton" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="p-8 text-center space-y-3">
            <AlertTriangle className="w-8 h-8 text-danger mx-auto" />
            <p className="text-sm font-semibold text-ink">Couldn't load conversations</p>
            <p className="text-xs text-ink-muted max-w-xs mx-auto">{errorMessage || 'Please try again.'}</p>
            <button
              onClick={onRetry}
              className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-strong text-accent-fg text-xs font-semibold inline-flex items-center gap-2"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          </div>
        ) : threads.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <Inbox className="w-10 h-10 text-ink-subtle mx-auto" />
            <p className="text-sm font-semibold text-ink">{searchQuery ? 'No matching mail' : 'Nothing here'}</p>
            <p className="text-xs text-ink-muted max-w-xs mx-auto">
              {searchQuery
                ? `No conversations match "${searchQuery}".`
                : folder === 'inbox'
                ? 'Your inbox is empty. Sync your mailbox to pull in conversations.'
                : 'This folder has no conversations.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {threads.map((thread) => {
              const isSelected = thread.threadId === selectedThreadId;
              const isChecked = selectedIds.has(thread.threadId);
              const unread = !thread.isRead;
              const sender = thread.lastFromName || thread.companyName || thread.lastFromEmail || thread.mailboxEmail;
              return (
                <li key={thread.threadId}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(thread)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(thread);
                      }
                    }}
                    className={`group relative flex gap-3 px-3 py-3 cursor-pointer transition-colors ${
                      isSelected ? 'bg-accent/10' : isChecked ? 'bg-surface-2' : 'hover:bg-surface-2'
                    }`}
                  >
                    {canSelect && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleSelect(thread.threadId);
                        }}
                        className={`mt-1 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                          isChecked ? 'bg-accent border-accent text-accent-fg' : 'border-line-strong text-transparent hover:border-accent'
                        } ${isChecked ? '' : 'opacity-0 group-hover:opacity-100'}`}
                        aria-label="Select conversation"
                      >
                        <Check className="w-2.5 h-2.5" />
                      </button>
                    )}

                    <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-accent-fg text-[11px] font-semibold shrink-0 mt-0.5">
                      {initialsOf({ name: thread.lastFromName || '', email: thread.lastFromEmail || '' })}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-xs truncate ${unread ? 'font-bold text-ink' : 'font-semibold text-ink-muted'}`}>
                          {sender}
                        </span>
                        <span className={`text-[10px] shrink-0 ${unread ? 'text-accent font-semibold' : 'text-ink-subtle'}`}>
                          {formatListDate(thread.lastMessageDate)}
                        </span>
                      </div>
                      <div className={`text-xs truncate mt-0.5 ${unread ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
                        {thread.subject}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {thread.hasAttachments && <Paperclip className="w-3 h-3 text-ink-subtle shrink-0" />}
                        <span className="text-[11px] text-ink-subtle truncate">{thread.snippet}</span>
                        {thread.messageCount > 1 && (
                          <span className="text-[10px] text-ink-subtle shrink-0">· {thread.messageCount}</span>
                        )}
                      </div>
                    </div>

                    {/* Hover actions */}
                    <div className="absolute right-2 top-2 hidden group-hover:flex items-center gap-0.5 bg-surface border border-line shadow-sm rounded-lg p-0.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleStar(thread);
                        }}
                        className={`p-1 rounded-md hover:bg-surface-3 ${thread.isStarred ? 'text-warning' : 'text-ink-muted'}`}
                        title={thread.isStarred ? 'Unstar' : 'Star'}
                      >
                        <Star className={`w-3.5 h-3.5 ${thread.isStarred ? 'fill-current' : ''}`} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onArchive(thread);
                        }}
                        className="p-1 rounded-md hover:bg-surface-3 text-ink-muted"
                        title="Archive"
                      >
                        <Archive className="w-3.5 h-3.5" />
                      </button>
                      {folder !== 'spam' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSpam(thread);
                          }}
                          className="p-1 rounded-md hover:bg-surface-3 text-ink-muted"
                          title="Report spam"
                        >
                          <AlertOctagon className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(thread);
                        }}
                        className="p-1 rounded-md hover:bg-surface-3 text-danger"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!isLoading && !isError && threads.length > 0 && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-line bg-surface-2 text-[11px] text-ink-muted shrink-0">
          <span>
            Page {page}
            {total > 0 ? ` · ${total} conversation${total === 1 ? '' : 's'}` : ''}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onPrevPage}
              disabled={page <= 1}
              className="px-2.5 py-1 rounded-lg border border-line hover:bg-surface-3 text-ink-muted hover:text-ink transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Prev
            </button>
            <button
              onClick={onNextPage}
              disabled={!hasMore}
              className="px-2.5 py-1 rounded-lg border border-line hover:bg-surface-3 text-ink-muted hover:text-ink transition-colors disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

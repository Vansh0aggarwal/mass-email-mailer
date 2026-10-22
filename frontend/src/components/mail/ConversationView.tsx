import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Star,
  Archive,
  Trash2,
  AlertOctagon,
  MailOpen,
  Mail,
  Send,
  Reply,
  ReplyAll,
  CornerUpLeft,
  Paperclip,
  Download,
  Building2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Sparkles,
} from 'lucide-react';
import type { MailThread } from '../../lib/mail';
import { downloadAttachment, formatAddressList, formatFullDate, initialsOf } from '../../lib/mail';
import { EmailBodyRenderer } from './EmailBodyRenderer';
import { api } from '../../lib/api';

interface ReplyPayload {
  bodyText: string;
  to?: string;
  cc?: string;
  bcc?: string;
}

interface ConversationViewProps {
  thread?: MailThread;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  onBack: () => void;
  mailboxEmail: string;
  onReply: (payload: ReplyPayload) => Promise<void>;
  isReplying: boolean;
  onToggleStar: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onSpam: () => void;
  onMarkUnread: () => void;
  onOpenCompany?: (companyId: string) => void;
}

function formatBytes(size?: number): string {
  if (!size && size !== 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ConversationView({
  thread,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  onBack,
  mailboxEmail,
  onReply,
  isReplying,
  onToggleStar,
  onArchive,
  onDelete,
  onSpam,
  onMarkUnread,
  onOpenCompany,
}: ConversationViewProps) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyAll, setReplyAll] = useState(false);
  const [body, setBody] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiQuestions, setAiQuestions] = useState<string[]>([]);
  const [aiFallback, setAiFallback] = useState(false);

  useEffect(() => {
    setReplyOpen(false);
    setReplyAll(false);
    setBody('');
    setCc('');
    setBcc('');
    setShowCc(false);
    setError(null);
    setExpanded({});
  }, [thread?.threadId]);

  const messages = thread?.messages || [];

  const { replyTo, replyAllList } = useMemo(() => {
    if (!thread) return { replyTo: '', replyAllList: '' };
    const lastIncoming = [...messages].reverse().find((m) => m.from?.email?.toLowerCase() !== mailboxEmail.toLowerCase());
    const primary = lastIncoming?.from?.email || thread.participants.find((p) => p.toLowerCase() !== mailboxEmail.toLowerCase()) || '';
    const others = new Set<string>();
    for (const m of messages) {
      for (const addr of [...(m.to || []), ...(m.cc || [])]) {
        if (addr.email && addr.email.toLowerCase() !== mailboxEmail.toLowerCase()) others.add(addr.email);
      }
    }
    return { replyTo: primary, replyAllList: Array.from(others).join(', ') };
  }, [thread, messages, mailboxEmail]);

  const openReply = (all: boolean) => {
    setReplyAll(all);
    setShowCc(all);
    setCc(all ? replyAllList : '');
    setReplyOpen(true);
  };

  const draftWithAI = async (action: 'generate' | 'shorter' | 'detailed' | 'answer_question' | 'next_step') => {
    setAiError(null);
    if (!thread?.threadId) return;
    try {
      setAiBusy(true);
      const res = await api.post<{
        draft: { bodyText: string; warnings?: string[]; isFallbackTemplate?: boolean };
        suggestedNextStep?: string;
        isFallback: boolean;
      }>('/drafts/reply-assistant', {
        mailboxEmail,
        threadId: thread.threadId,
        recipientEmail: replyTo || undefined,
        companyId: (thread as any).companyId || undefined,
        action,
        tone: 'professional',
      });
      setBody(res.draft?.bodyText || '');
      const questions = (res.draft?.warnings || [])
        .filter((w) => w.startsWith('Confirm before sending:'))
        .flatMap((w) => w.replace('Confirm before sending:', '').split(';').map((s) => s.trim()).filter(Boolean));
      setAiQuestions(questions);
      setAiFallback(!!res.isFallback);
    } catch (err: any) {
      setAiError(err?.message || 'AI reply assistant failed.');
    } finally {
      setAiBusy(false);
    }
  };

  const handleSend = async () => {
    setError(null);
    if (!body.trim()) {
      setError('Write a message before sending.');
      return;
    }
    try {
      await onReply({
        bodyText: body.trim(),
        to: replyTo || undefined,
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
      });
      setReplyOpen(false);
      setBody('');
      setCc('');
      setBcc('');
      setShowCc(false);
    } catch (err: any) {
      setError(err?.message || 'Unable to send reply.');
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-ink-muted text-sm">
          <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          Loading conversation...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-3">
        <AlertTriangle className="w-8 h-8 text-danger" />
        <p className="text-sm font-semibold text-ink">Couldn't load this conversation</p>
        <p className="text-xs text-ink-muted max-w-xs">{errorMessage || 'Please try again.'}</p>
        <button
          onClick={onRetry}
          className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-strong text-accent-fg text-xs font-semibold"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
        <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-line flex items-center justify-center text-ink-subtle mb-3">
          <Mail className="w-8 h-8" />
        </div>
        <p className="text-sm font-semibold text-ink">No conversation selected</p>
        <p className="text-xs text-ink-muted mt-1 max-w-sm">Select an email to read and reply.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-line bg-surface-2">
        <div className="flex items-start gap-2 min-w-0">
          <button
            onClick={onBack}
            aria-label="Back to list"
            className="lg:hidden p-1.5 -ml-1 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-3 shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate">{thread.subject}</h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap text-[11px] text-ink-subtle">
              {thread.companyName && (
                <button
                  onClick={() => thread.companyId && onOpenCompany?.(thread.companyId)}
                  disabled={!thread.companyId || !onOpenCompany}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-line ${
                    thread.companyId && onOpenCompany ? 'hover:border-accent hover:text-accent cursor-pointer' : ''
                  }`}
                >
                  <Building2 className="w-3 h-3" />
                  {thread.companyName}
                </button>
              )}
              {thread.category && (
                <span className="px-2 py-0.5 rounded-full bg-surface-3 text-ink-muted capitalize">{thread.category}</span>
              )}
              <span>{thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onToggleStar}
            className={`p-2 rounded-lg hover:bg-surface-3 ${thread.isStarred ? 'text-warning' : 'text-ink-muted'}`}
            title={thread.isStarred ? 'Unstar' : 'Star'}
            aria-label={thread.isStarred ? 'Unstar' : 'Star'}
          >
            <Star className={`w-4 h-4 ${thread.isStarred ? 'fill-current' : ''}`} />
          </button>
          <button onClick={onMarkUnread} className="p-2 rounded-lg hover:bg-surface-3 text-ink-muted" title="Mark unread" aria-label="Mark unread">
            <MailOpen className="w-4 h-4" />
          </button>
          <button onClick={onArchive} className="p-2 rounded-lg hover:bg-surface-3 text-ink-muted" title="Archive" aria-label="Archive">
            <Archive className="w-4 h-4" />
          </button>
          <button onClick={onSpam} className="p-2 rounded-lg hover:bg-surface-3 text-ink-muted" title="Report spam" aria-label="Report spam">
            <AlertOctagon className="w-4 h-4" />
          </button>
          <button onClick={onDelete} className="p-2 rounded-lg hover:bg-surface-3 text-danger" title="Delete" aria-label="Delete">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-app">
        {messages.map((msg) => {
          const isOpen = expanded[msg.id] ?? true;
          const attachments = (msg.attachments || []).filter((att) => !att.isInline);
          return (
            <div key={msg.id} className="rounded-xl border border-line bg-surface overflow-hidden">
              <button
                onClick={() => setExpanded((prev) => ({ ...prev, [msg.id]: !isOpen }))}
                className="w-full flex items-start gap-3 p-3.5 text-left hover:bg-surface-2 transition-colors"
              >
                <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-accent-fg text-[11px] font-semibold shrink-0">
                  {initialsOf(msg.from)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-ink truncate">
                      {msg.from?.name || msg.from?.email}
                      <span className="text-ink-subtle font-normal"> &lt;{msg.from?.email}&gt;</span>
                    </span>
                    <span className="text-[10px] text-ink-subtle shrink-0">{formatFullDate(msg.date)}</span>
                  </div>
                  <div className="text-[11px] text-ink-subtle truncate mt-0.5">
                    to {formatAddressList(msg.to) || 'me'}
                  </div>
                  {!isOpen && <div className="text-[11px] text-ink-muted truncate mt-1">{msg.snippet}</div>}
                </div>
                {isOpen ? (
                  <ChevronUp className="w-3.5 h-3.5 text-ink-subtle shrink-0 mt-1" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-ink-subtle shrink-0 mt-1" />
                )}
              </button>

              {isOpen && (
                <div className="px-3.5 pb-3.5">
                  {((msg.cc?.length ?? 0) + (msg.bcc?.length ?? 0)) > 0 && (
                    <div className="text-[10px] text-ink-subtle mb-2 space-y-0.5">
                      {msg.cc && msg.cc.length > 0 && <div>cc: {formatAddressList(msg.cc)}</div>}
                      {msg.bcc && msg.bcc.length > 0 && <div>bcc: {formatAddressList(msg.bcc)}</div>}
                    </div>
                  )}
                  {msg.bodyHtml || msg.bodyText ? (
                    <EmailBodyRenderer
                      html={msg.bodyHtml}
                      text={msg.bodyText}
                      mailbox={mailboxEmail}
                      threadId={thread?.threadId || ''}
                      messageId={msg.id}
                      attachments={msg.attachments}
                    />
                  ) : (
                    <p className="text-sm italic text-ink-subtle">(empty message)</p>
                  )}

                  {attachments.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {attachments.map((att, i) => {
                        const downloadable = !!att.attachmentId;
                        return (
                          <button
                            key={`${att.filename}-${i}`}
                            type="button"
                            disabled={!downloadable}
                            onClick={() => {
                              if (!downloadable) return;
                              void downloadAttachment(mailboxEmail, thread?.threadId || '', msg.id, att);
                            }}
                            className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-line bg-surface-2 text-[11px] text-ink-muted hover:border-accent hover:text-accent transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                            title={downloadable ? `Download ${att.filename}` : 'Attachment unavailable'}
                          >
                            <Paperclip className="w-3 h-3" />
                            <span className="truncate max-w-[12rem]">{att.filename}</span>
                            {att.size ? <span className="text-ink-subtle">{formatBytes(att.size)}</span> : null}
                            {downloadable ? <Download className="w-3 h-3 opacity-0 group-hover:opacity-100" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Reply area */}
      <div className="border-t border-line bg-surface-2">
        {!replyOpen ? (
          <div className="flex items-center gap-2 p-3">
            <button
              onClick={() => openReply(false)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-line bg-surface hover:bg-surface-3 text-xs font-medium text-ink transition-colors"
            >
              <Reply className="w-3.5 h-3.5" />
              Reply
            </button>
            {replyAllList && (
              <button
                onClick={() => openReply(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-line bg-surface hover:bg-surface-3 text-xs font-medium text-ink transition-colors"
              >
                <ReplyAll className="w-3.5 h-3.5" />
                Reply all
              </button>
            )}
          </div>
        ) : (
          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px] text-ink-muted">
              <span className="flex items-center gap-1.5 font-medium text-ink">
                <CornerUpLeft className="w-3.5 h-3.5 text-accent" />
                {replyAll ? 'Reply all' : 'Reply'} to {replyTo || 'recipient'}
              </span>
              <button
                onClick={() => setShowCc((v) => !v)}
                className="text-[11px] font-medium text-ink-muted hover:text-accent"
              >
                {showCc ? 'Hide Cc' : 'Add Cc/Bcc'}
              </button>
            </div>

            {showCc && (
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="cc"
                  className="w-full bg-surface border border-line rounded-lg px-3 py-1.5 text-xs text-ink placeholder:text-ink-subtle focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <input
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  placeholder="bcc"
                  className="w-full bg-surface border border-line rounded-lg px-3 py-1.5 text-xs text-ink placeholder:text-ink-subtle focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => draftWithAI('generate')}
                disabled={aiBusy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent/30 bg-accent/10 text-accent text-[11px] font-medium hover:bg-accent/15 disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {aiBusy ? 'Drafting…' : 'Draft with AI'}
              </button>
              {body && (
                <>
                  <button onClick={() => draftWithAI('shorter')} disabled={aiBusy} className="text-[11px] text-ink-muted hover:text-accent disabled:opacity-50">
                    Shorter
                  </button>
                  <button onClick={() => draftWithAI('detailed')} disabled={aiBusy} className="text-[11px] text-ink-muted hover:text-accent disabled:opacity-50">
                    More detail
                  </button>
                  <button onClick={() => draftWithAI('next_step')} disabled={aiBusy} className="text-[11px] text-ink-muted hover:text-accent disabled:opacity-50">
                    Propose next step
                  </button>
                </>
              )}
            </div>
            {aiError && <div className="text-[11px] text-danger">{aiError}</div>}
            {aiFallback && (
              <div className="text-[11px] text-warning">
                Drafted with the deterministic fallback (no AI provider configured). Review carefully before sending.
              </div>
            )}
            {aiQuestions.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-ink">
                <span className="font-semibold">Confirm before sending:</span> {aiQuestions.join(' · ')}
              </div>
            )}

            <textarea
              rows={4}
              autoFocus
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`Reply to ${thread.companyName || replyTo}...`}
              className="w-full bg-surface border border-line rounded-xl p-3 text-sm text-ink placeholder:text-ink-subtle focus:outline-none focus:ring-1 focus:ring-accent resize-none leading-relaxed"
            />
            {error && <div className="text-[11px] text-danger">{error}</div>}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setReplyOpen(false)}
                disabled={isReplying}
                className="px-3 py-2 rounded-xl text-xs font-medium text-ink-muted hover:text-ink hover:bg-surface-3 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={isReplying || !body.trim()}
                className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-strong text-accent-fg text-xs font-semibold flex items-center gap-2 transition-colors active:scale-[0.98] disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{isReplying ? 'Sending...' : 'Send'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Send, X, Paperclip } from 'lucide-react';

export interface ComposePayload {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
}

interface ComposePanelProps {
  isOpen: boolean;
  onClose: () => void;
  mailboxEmail: string;
  onSend: (payload: ComposePayload) => Promise<void>;
  isSending: boolean;
}

const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function ComposePanel({ isOpen, onClose, mailboxEmail, onSend, isSending }: ComposePanelProps) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setTo('');
      setCc('');
      setBcc('');
      setSubject('');
      setBody('');
      setShowCc(false);
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSend = async () => {
    setError(null);
    if (!to.trim()) {
      setError('Add at least one recipient.');
      return;
    }
    const primary = to.split(',')[0].trim();
    if (!EMAIL_REGEX.test(primary)) {
      setError(`Recipient address "${primary}" is not valid.`);
      return;
    }
    if (!subject.trim()) {
      setError('Add a subject line.');
      return;
    }
    if (!body.trim()) {
      setError('Write a message before sending.');
      return;
    }
    try {
      await onSend({
        to: to.trim(),
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject: subject.trim(),
        body,
      });
    } catch (err: any) {
      setError(err?.message || 'Unable to send message.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:justify-end p-0 sm:p-6 pointer-events-none">
      <div
        className="absolute inset-0 bg-overlay/50 pointer-events-auto sm:hidden"
        onClick={isSending ? undefined : onClose}
      />
      <div
        role="dialog"
        aria-modal="false"
        aria-label="Compose message"
        className="pointer-events-auto relative w-full sm:w-[32rem] max-h-full sm:max-h-[85vh] flex flex-col bg-surface border border-line shadow-pop rounded-t-xl sm:rounded-xl overflow-hidden animate-scale-in"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-surface-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">New Message</h2>
            <p className="text-[11px] text-ink-subtle truncate">From {mailboxEmail}</p>
          </div>
          <button
            onClick={onClose}
            disabled={isSending}
            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-3 transition-colors disabled:opacity-50"
            aria-label="Close composer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-line">
            <span className="text-xs text-ink-subtle w-12 shrink-0">To</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="name@company.com, another@company.com"
              autoFocus
              className="flex-1 bg-transparent text-xs text-ink placeholder:text-ink-subtle focus:outline-none"
            />
            {!showCc && (
              <button
                onClick={() => setShowCc(true)}
                className="text-[11px] font-medium text-ink-muted hover:text-accent transition-colors"
              >
                Cc/Bcc
              </button>
            )}
          </div>
          {showCc && (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-line">
                <span className="text-xs text-ink-subtle w-12 shrink-0">Cc</span>
                <input
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  className="flex-1 bg-transparent text-xs text-ink placeholder:text-ink-subtle focus:outline-none"
                  placeholder="optional"
                />
              </div>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-line">
                <span className="text-xs text-ink-subtle w-12 shrink-0">Bcc</span>
                <input
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  className="flex-1 bg-transparent text-xs text-ink placeholder:text-ink-subtle focus:outline-none"
                  placeholder="optional"
                />
              </div>
            </>
          )}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-line">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="flex-1 bg-transparent text-sm font-medium text-ink placeholder:text-ink-subtle focus:outline-none"
            />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message..."
            rows={10}
            className="w-full bg-transparent text-sm text-ink placeholder:text-ink-subtle focus:outline-none p-4 resize-none leading-relaxed"
          />
        </div>

        {error && (
          <div className="px-4 py-2 text-[11px] text-danger bg-danger/10 border-t border-danger/20">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-line bg-surface-2">
          <button
            type="button"
            disabled
            title="Attachments are not supported yet"
            className="flex items-center gap-1.5 text-[11px] text-ink-subtle cursor-not-allowed"
          >
            <Paperclip className="w-3.5 h-3.5" />
            <span>Attach (coming soon)</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={isSending}
              className="px-3 py-2 rounded-xl text-xs font-medium text-ink-muted hover:text-ink hover:bg-surface-3 transition-colors disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={handleSend}
              disabled={isSending}
              className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-strong text-accent-fg text-xs font-semibold flex items-center gap-2 transition-colors active:scale-[0.98] disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isSending ? 'Sending...' : 'Send'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

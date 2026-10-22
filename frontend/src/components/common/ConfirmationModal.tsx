import React, { useEffect, useId, useRef } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';

export interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  details?: string[];
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  isLoading?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  details = [],
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isDestructive = false,
  isLoading = false,
  icon: Icon = AlertTriangle,
}: ConfirmationModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;
    const node = dialogRef.current;
    const focusables = () =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('disabled')) : [];

    (focusables()[0] ?? node)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isLoading) {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [isOpen, isLoading, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay/50 animate-fade-in">
      <div
        className="fixed inset-0"
        aria-hidden="true"
        onClick={() => {
          if (!isLoading) onClose();
        }}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className="relative z-10 w-full max-w-md p-6 bg-surface border border-line rounded-xl shadow-pop space-y-5 outline-none animate-scale-in"
      >
        <button
          type="button"
          onClick={onClose}
          disabled={isLoading}
          aria-label="Close dialog"
          className="absolute top-4 right-4 p-1.5 rounded-lg text-ink-subtle hover:text-ink hover:bg-surface-3 transition-colors disabled:opacity-50"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-start gap-4">
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border ${
              isDestructive
                ? 'bg-danger/10 border-danger/25 text-danger'
                : 'bg-accent/10 border-accent/25 text-accent'
            }`}
          >
            <Icon className="w-5 h-5" />
          </div>

          <div className="space-y-1 pr-6">
            <h2 id={titleId} className="text-base font-semibold text-ink tracking-tight">
              {title}
            </h2>
            <p id={descId} className="text-xs text-ink-muted leading-relaxed">
              {description}
            </p>
          </div>
        </div>

        {details.length > 0 && (
          <ul className="p-3.5 rounded-xl bg-surface-2 border border-line space-y-1.5 text-[11px] text-ink-muted list-none">
            {details.map((item, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="text-ink-subtle mt-0.5" aria-hidden="true">
                  •
                </span>
                <span className="leading-relaxed">{item}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="ios-btn-secondary flex-1 py-2.5 text-xs font-semibold"
          >
            {cancelText}
          </button>

          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className={`flex-1 py-2.5 text-xs font-semibold flex items-center justify-center gap-2 ${
              isDestructive ? 'btn-danger' : 'ios-btn-primary'
            }`}
          >
            {isLoading ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Processing…</span>
              </>
            ) : (
              <span>{confirmText}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

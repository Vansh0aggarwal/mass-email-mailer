import { useState } from 'react';
import { AlertTriangle, Code2, Monitor, Smartphone } from 'lucide-react';
import type { StudioIssue } from '../../lib/email-studio';

interface EmailPreviewPanelProps {
  html: string | null;
  text: string;
  warnings: string[];
  subject: string;
  isRendering: boolean;
  error: string;
  issues: StudioIssue[];
}

type ViewMode = 'desktop' | 'mobile';
type PreviewTab = 'html' | 'text';

export function EmailPreviewPanel({
  html,
  text,
  warnings,
  subject,
  isRendering,
  error,
  issues,
}: EmailPreviewPanelProps) {
  const [mode, setMode] = useState<ViewMode>('desktop');
  const [tab, setTab] = useState<PreviewTab>('html');

  return (
    <section className="ios-card overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Live preview</h2>
            {isRendering ? (
              <span className="ios-pill">Rendering…</span>
            ) : (
              <span className="ios-pill">Server-rendered</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-ink-subtle">
            This is the exact table-based HTML that will be delivered, not a mockup.
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-line bg-[rgb(var(--surface-2))] p-0.5">
          <button
            type="button"
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
              tab === 'html' ? 'bg-[rgb(var(--surface))] text-ink shadow-sm' : 'text-ink-muted'
            }`}
            onClick={() => setTab('html')}
          >
            <Code2 className="h-3.5 w-3.5" /> HTML
          </button>
          <button
            type="button"
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
              tab === 'text' ? 'bg-[rgb(var(--surface))] text-ink shadow-sm' : 'text-ink-muted'
            }`}
            onClick={() => setTab('text')}
          >
            Plain text
          </button>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-line bg-[rgb(var(--surface-2))] p-0.5">
          <button
            type="button"
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
              mode === 'desktop' ? 'bg-[rgb(var(--surface))] text-ink shadow-sm' : 'text-ink-muted'
            }`}
            onClick={() => setMode('desktop')}
            title="Desktop preview"
          >
            <Monitor className="h-3.5 w-3.5" /> Desktop
          </button>
          <button
            type="button"
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
              mode === 'mobile' ? 'bg-[rgb(var(--surface))] text-ink shadow-sm' : 'text-ink-muted'
            }`}
            onClick={() => setMode('mobile')}
            title="Mobile preview"
          >
            <Smartphone className="h-3.5 w-3.5" /> Mobile
          </button>
        </div>
      </header>

      {subject.trim() && (
        <div className="border-b border-line px-4 py-2">
          <p className="text-[11px] uppercase tracking-wide text-ink-subtle">Subject</p>
          <p className="truncate text-sm text-ink">{subject}</p>
        </div>
      )}

      <div className="bg-[rgb(var(--surface-2))] p-3">
        {tab === 'text' ? (
          <pre className="h-[600px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-[rgb(var(--surface))] p-4 font-mono text-[12px] leading-relaxed text-ink">
            {text || 'The plain-text alternative appears here once the design is complete.'}
          </pre>
        ) : html ? (
          <div className="flex justify-center">
            <div
              className={`overflow-hidden bg-white shadow-sm transition-[width] duration-200 ${
                mode === 'mobile' ? 'w-[390px] max-w-full rounded-[26px] border-[7px] border-[#171717]' : 'w-full rounded-lg border border-line'
              }`}
            >
              <iframe
                title="Email preview"
                srcDoc={html}
                sandbox=""
                className="block h-[640px] w-full bg-white"
              />
            </div>
          </div>
        ) : (
          <div className="flex h-[420px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line bg-[rgb(var(--surface))] p-6 text-center">
            {isRendering ? (
              <>
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-[rgb(var(--accent))] border-t-transparent" />
                <p className="text-sm text-ink-muted">Rendering the email…</p>
              </>
            ) : (
              <>
                <AlertTriangle className="h-5 w-5 text-[rgb(var(--warning))]" />
                <p className="text-sm font-medium text-ink">Preview unavailable</p>
                {error ? (
                  <p className="max-w-sm text-xs text-ink-muted">{error}</p>
                ) : issues.length ? (
                  <ul className="max-w-sm space-y-1 text-left text-xs text-ink-muted">
                    {issues.map((issue, idx) => (
                      <li key={idx}>• {issue.message}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="max-w-sm text-xs text-ink-muted">
                    Complete the design to see the rendered email.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="border-t border-[rgb(var(--warning)/0.35)] bg-[rgb(var(--warning)/0.08)] px-4 py-3">
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[rgb(var(--warning))]">
            <AlertTriangle className="h-3.5 w-3.5" /> Review before sending
          </p>
          <ul className="space-y-1 text-[11px] leading-relaxed text-ink-muted">
            {warnings.map((warning, idx) => (
              <li key={idx}>• {warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

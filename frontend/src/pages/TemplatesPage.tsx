import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { EmailTemplate } from '../types';
import { FileCode } from 'lucide-react';

export function TemplatesPage() {
  const { data: templates = [], isLoading } = useQuery<EmailTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get<EmailTemplate[]>('/templates'),
  });

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-accent-fg">
            <FileCode className="w-4 h-4" />
          </span>
          <span>Email Templates Library</span>
        </h1>
        <p className="text-xs text-ink-subtle mt-1">
          Standard outreach templates with dynamic personalization variables and tone specifications.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {isLoading ? (
          [0, 1].map((i) => (
            <div key={i} className="ios-card rounded-xl p-5 space-y-3 bg-surface-2" aria-hidden="true">
              <div className="skeleton h-4 w-1/3" />
              <div className="skeleton h-3 w-2/3" />
              <div className="skeleton h-16 w-full" />
            </div>
          ))
        ) : templates.length === 0 ? (
          <div className="col-span-2 empty-state ios-card rounded-xl p-10 space-y-3 bg-surface-2">
            <FileCode className="w-10 h-10 text-ink-subtle" />
            <h3 className="text-sm font-semibold text-ink">No templates yet</h3>
            <p className="text-xs text-ink-subtle max-w-md">
              Email templates will appear here once they are available.
            </p>
          </div>
        ) : (
          templates.map((tpl) => (
            <div key={tpl._id} className="ios-card rounded-xl p-5 space-y-3.5 bg-surface-2 transition-colors">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-ink tracking-tight">{tpl.name}</h3>
                  <span className="badge badge-info uppercase mt-1">{tpl.category}</span>
                </div>
                <span className="badge badge-neutral tabular-nums">
                  v{tpl.version}
                </span>
              </div>
              <div className="bg-surface-2 p-3.5 rounded-xl border border-line text-xs text-ink-muted space-y-1.5">
                <div className="font-semibold text-ink">Subject: {tpl.subject}</div>
                <div className="line-clamp-3 text-ink-subtle text-[11px] whitespace-pre-wrap leading-relaxed">{tpl.body}</div>
              </div>
              <div className="text-[11px] text-ink-subtle flex items-center gap-1.5">
                <strong className="text-ink-muted">Variables:</strong> {tpl.variables.join(', ') || 'None'}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

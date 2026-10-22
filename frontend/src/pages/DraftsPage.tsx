import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { EmailDraft } from '../types';
import { FileEdit, Eye } from 'lucide-react';
import { Link } from 'react-router-dom';

export function DraftsPage() {
  const { data: drafts = [], isLoading } = useQuery<EmailDraft[]>({
    queryKey: ['drafts'],
    queryFn: () => api.get<EmailDraft[]>('/drafts'),
  });

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-accent-fg">
              <FileEdit className="w-4 h-4" />
            </span>
            <span>Outreach Drafts & Approval</span>
          </h1>
          <p className="text-xs text-ink-muted mt-1">
            All AI-generated messages begin as drafts. Explicit approval is required before delivery is attempted.
          </p>
        </div>
        <Link
          to="/ai-studio"
          className="ios-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2"
        >
          Compose in AI Studio
        </Link>
      </div>

      <div className="ios-card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-xs text-ink-muted">Loading drafts...</div>
        ) : drafts.length === 0 ? (
          <div className="p-12 empty-state space-y-3">
            <FileEdit className="w-10 h-10 text-ink-subtle mx-auto" />
            <h3 className="text-sm font-semibold text-ink">No Drafts Generated</h3>
            <p className="text-xs text-ink-muted max-w-sm mx-auto">
              Generate personalized drafts from the AI Email Studio or review recommended opportunities.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="bg-surface-2 border-b border-line text-ink-muted font-semibold uppercase tracking-wider text-[10px]">
              <tr>
                <th className="px-5 py-3.5">Company / Recipient</th>
                <th className="px-5 py-3.5">Subject Line</th>
                <th className="px-5 py-3.5">Service Need</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-ink">
              {drafts.map((d) => (
                <tr key={d._id} className="hover:bg-surface-3 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-ink">{d.companyName || 'Target Company'}</div>
                    <div className="text-[11px] text-ink-muted mt-0.5">{d.recipientEmail}</div>
                  </td>
                  <td className="px-5 py-3.5 max-w-xs truncate text-ink-muted">{d.subject}</td>
                  <td className="px-5 py-3.5 text-accent font-medium">
                    {d.recommendedServiceName || 'General Outreach'}
                  </td>
                  <td className="px-5 py-3.5">
                    <span
                      className={`badge ${
                        d.status === 'approved'
                          ? 'badge-success'
                          : d.status === 'draft'
                          ? 'badge-warning'
                          : 'badge-neutral'
                      }`}
                    >
                      {d.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-right space-x-2">
                    <Link
                      to={`/ai-studio?draftId=${d._id}`}
                      className="text-xs text-accent hover:underline font-semibold inline-flex items-center gap-1.5"
                    >
                      <Eye className="w-3.5 h-3.5" /> Review / Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

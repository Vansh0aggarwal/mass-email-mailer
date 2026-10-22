import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Mail,
  Search,
  Plus,
  Trash2,
  RefreshCw,
  Info,
  Clock,
  Slash,
} from 'lucide-react';
import { api } from '../lib/api';

interface MailboxHealth {
  emailAddress: string;
  provider: string;
  status: 'connected' | 'paused' | 'error' | 'disconnected';
  dailySendLimit: number;
  sendsToday: number;
  remainingQuota: number;
  quotaUsedPercent: number;
  spfConfigured: boolean;
  dkimConfigured: boolean;
  dmarcConfigured: boolean;
  isPaused: boolean;
  pausedReason?: string;
}

interface DeliverabilityOverview {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  mailboxes: MailboxHealth[];
  providerEvents: {
    totalDispatched: number;
    acceptedByProvider: number;
    failedAttempts: number;
    suppressionBlocks: number;
    repliesReceived: number;
    bouncesRecorded: number;
    unsubscribesRecorded: number;
  };
  suppressionSummary: {
    total: number;
    byReason: {
      unsubscribed: number;
      bounced: number;
      manual_block: number;
      competitor: number;
    };
  };
  queueHealth: {
    pendingDrafts: number;
    approvedAwaitingSend: number;
    activeCampaigns: number;
    pausedCampaigns: number;
  };
  recommendations: string[];
}

interface SuppressionItem {
  _id: string;
  email: string;
  reason: 'unsubscribed' | 'bounced' | 'manual_block' | 'competitor';
  createdAt: string;
}

export function DeliverabilityPage() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [filterReason, setFilterReason] = useState<string>('all');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newReason, setNewReason] = useState<'unsubscribed' | 'bounced' | 'manual_block' | 'competitor'>('manual_block');
  const [addError, setAddError] = useState<string | null>(null);

  const { data: overview, isLoading: overviewLoading, refetch: refetchOverview } = useQuery<DeliverabilityOverview>({
    queryKey: ['deliverability-overview'],
    queryFn: () => api.get<DeliverabilityOverview>('/deliverability/overview'),
  });

  const { data: suppressions = [], isLoading: suppressionsLoading, refetch: refetchSuppressions } = useQuery<SuppressionItem[]>({
    queryKey: ['suppressions', searchQuery, filterReason],
    queryFn: () => {
      const params = new URLSearchParams();
      if (searchQuery) params.set('q', searchQuery);
      if (filterReason !== 'all') params.set('reason', filterReason);
      return api.get<SuppressionItem[]>(`/deliverability/suppressions?${params.toString()}`);
    },
  });

  const addSuppressionMutation = useMutation({
    mutationFn: (data: { email: string; reason: string }) =>
      api.post('/deliverability/suppressions', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppressions'] });
      queryClient.invalidateQueries({ queryKey: ['deliverability-overview'] });
      setAddModalOpen(false);
      setNewEmail('');
      setAddError(null);
    },
    onError: (err: any) => {
      setAddError(err?.message || 'Failed to add email to suppression list');
    },
  });

  const deleteSuppressionMutation = useMutation({
    mutationFn: (email: string) => api.delete(`/deliverability/suppressions/${encodeURIComponent(email)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppressions'] });
      queryClient.invalidateQueries({ queryKey: ['deliverability-overview'] });
    },
  });

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim()) {
      setAddError('Email address is required');
      return;
    }
    addSuppressionMutation.mutate({ email: newEmail.trim(), reason: newReason });
  };

  const gradeColors: Record<string, string> = {
    A: 'text-success bg-success/10 border-success/30',
    B: 'text-accent bg-accent/10 border-accent/30',
    C: 'text-warning bg-warning/10 border-warning/30',
    D: 'text-danger bg-danger/10 border-danger/30',
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-accent" />
            Deliverability & Sender Reputation
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            Real-time mailbox health, DNS authentication status, verified provider events, and suppression management.
          </p>
        </div>
        <button
          onClick={() => {
            refetchOverview();
            refetchSuppressions();
          }}
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-surface-2 hover:bg-surface-3 border border-line text-xs font-semibold text-ink transition-colors self-start"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Scorecard
        </button>
      </div>

      {overviewLoading ? (
        <div className="p-12 text-center text-sm text-ink-muted">Loading deliverability intelligence...</div>
      ) : overview ? (
        <>
          {/* Top Scorecard & Provider Events */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-line bg-surface p-5 flex flex-col justify-between">
              <div>
                <span className="text-xs font-semibold text-ink-subtle uppercase tracking-wider">Reputation Grade</span>
                <div className="mt-2 flex items-baseline gap-3">
                  <span className={`text-4xl font-extrabold px-3 py-1 rounded-xl border ${gradeColors[overview.grade] || gradeColors.B}`}>
                    {overview.grade}
                  </span>
                  <span className="text-2xl font-bold text-ink">{overview.score} / 100</span>
                </div>
              </div>
              <p className="text-xs text-ink-muted mt-3">
                {overview.score >= 90
                  ? 'Optimal sending posture. High inbox placement likelihood.'
                  : overview.score >= 75
                  ? 'Healthy baseline. Monitor daily send volume pacing.'
                  : 'Action required. High bounce or suppression block rate detected.'}
              </p>
            </div>

            <div className="rounded-2xl border border-line bg-surface p-5 flex flex-col justify-between">
              <div>
                <span className="text-xs font-semibold text-ink-subtle uppercase tracking-wider">Provider Accepted</span>
                <div className="mt-2 text-2xl font-bold text-ink">
                  {overview.providerEvents.acceptedByProvider.toLocaleString()}
                </div>
                <div className="text-[11px] text-ink-subtle mt-0.5">
                  of {overview.providerEvents.totalDispatched.toLocaleString()} total dispatched
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-muted">
                <Info className="w-3 h-3 text-accent shrink-0" />
                <span>Verified 200 OK from Gmail / SMTP API</span>
              </div>
            </div>

            <div className="rounded-2xl border border-line bg-surface p-5 flex flex-col justify-between">
              <div>
                <span className="text-xs font-semibold text-ink-subtle uppercase tracking-wider">Verified Inbound Replies</span>
                <div className="mt-2 text-2xl font-bold text-success">
                  {overview.providerEvents.repliesReceived.toLocaleString()}
                </div>
                <div className="text-[11px] text-ink-subtle mt-0.5">
                  {overview.providerEvents.acceptedByProvider > 0
                    ? `${((overview.providerEvents.repliesReceived / overview.providerEvents.acceptedByProvider) * 100).toFixed(1)}% response rate`
                    : 'Awaiting responses'}
                </div>
              </div>
              <p className="text-[11px] text-ink-muted mt-3">Positive engagement actively boosts sender domain trust.</p>
            </div>

            <div className="rounded-2xl border border-line bg-surface p-5 flex flex-col justify-between">
              <div>
                <span className="text-xs font-semibold text-ink-subtle uppercase tracking-wider">Suppressed & Blocked</span>
                <div className="mt-2 text-2xl font-bold text-ink">
                  {overview.suppressionSummary.total.toLocaleString()}
                </div>
                <div className="text-[11px] text-ink-subtle mt-0.5">
                  {overview.providerEvents.suppressionBlocks} outreach attempts prevented
                </div>
              </div>
              <p className="text-[11px] text-ink-muted mt-3">Guarantees zero outreach to unsubscribed or invalid contacts.</p>
            </div>
          </div>

          {/* Mailbox Authentication & Daily Quota Health */}
          <div className="rounded-2xl border border-line bg-surface overflow-hidden">
            <div className="px-5 py-4 border-b border-line flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                <Mail className="w-4 h-4 text-accent" />
                Connected Sender Mailboxes & DNS Signals
              </h2>
              <span className="text-xs text-ink-subtle">
                {overview.mailboxes.length} Active Sender Account{overview.mailboxes.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="divide-y divide-line/60">
              {overview.mailboxes.map((mb) => (
                <div key={mb.emailAddress} className="p-4 sm:px-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink text-sm truncate">{mb.emailAddress}</span>
                      <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] uppercase font-bold text-ink-muted">
                        {mb.provider}
                      </span>
                      {mb.status === 'connected' ? (
                        <span className="flex items-center gap-1 text-[11px] text-success">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Ready
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[11px] text-warning">
                          <AlertTriangle className="w-3.5 h-3.5" /> {mb.status}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-4 mt-2 text-xs text-ink-subtle">
                      <div className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${mb.spfConfigured ? 'bg-success' : 'bg-warning'}`} />
                        SPF: {mb.spfConfigured ? 'Configured' : 'Check Record'}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${mb.dkimConfigured ? 'bg-success' : 'bg-warning'}`} />
                        DKIM: {mb.dkimConfigured ? 'Signed' : 'Check Record'}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${mb.dmarcConfigured ? 'bg-success' : 'bg-warning'}`} />
                        DMARC: {mb.dmarcConfigured ? 'Enforced' : 'Check Record'}
                      </div>
                    </div>
                  </div>

                  {/* Quota bar */}
                  <div className="w-full lg:w-72 shrink-0">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-ink-muted">Daily Sending Quota</span>
                      <span className="font-medium text-ink">
                        {mb.sendsToday} / {mb.dailySendLimit} ({mb.quotaUsedPercent}%)
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-surface-3 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          mb.quotaUsedPercent > 90 ? 'bg-danger' : mb.quotaUsedPercent > 70 ? 'bg-warning' : 'bg-accent'
                        }`}
                        style={{ width: `${Math.min(100, mb.quotaUsedPercent)}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-ink-subtle mt-1 text-right">
                      {mb.remainingQuota} remaining today
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recommendations & Queue Health */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-line bg-surface p-5">
              <h3 className="text-xs font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-2 mb-3">
                <CheckCircle2 className="w-4 h-4 text-success" />
                Recommendations & Safety Controls
              </h3>
              <ul className="space-y-2.5 text-xs text-ink-muted">
                {overview.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-accent font-bold">•</span>
                    <span>{rec}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-line bg-surface p-5">
              <h3 className="text-xs font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-2 mb-3">
                <Clock className="w-4 h-4 text-info" />
                Outbound Queue Health
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-surface-2 border border-line">
                  <div className="text-lg font-bold text-ink">{overview.queueHealth.pendingDrafts}</div>
                  <div className="text-[11px] text-ink-subtle">Pending Drafts</div>
                </div>
                <div className="p-3 rounded-xl bg-surface-2 border border-line">
                  <div className="text-lg font-bold text-ink">{overview.queueHealth.approvedAwaitingSend}</div>
                  <div className="text-[11px] text-ink-subtle">Approved Awaiting Send</div>
                </div>
                <div className="p-3 rounded-xl bg-surface-2 border border-line">
                  <div className="text-lg font-bold text-ink">{overview.queueHealth.activeCampaigns}</div>
                  <div className="text-[11px] text-ink-subtle">Active Campaigns</div>
                </div>
                <div className="p-3 rounded-xl bg-surface-2 border border-line">
                  <div className="text-lg font-bold text-ink">{overview.queueHealth.pausedCampaigns}</div>
                  <div className="text-[11px] text-ink-subtle">Paused Campaigns</div>
                </div>
              </div>
            </div>
          </div>

          {/* Suppression List Manager */}
          <div className="rounded-2xl border border-line bg-surface overflow-hidden">
            <div className="p-5 border-b border-line flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                  <Slash className="w-4 h-4 text-danger" />
                  Suppression List & Opt-Out Registry
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">
                  Emails in this registry are blocked by preflight checks before any dispatch occurs.
                </p>
              </div>
              <button
                onClick={() => setAddModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-accent hover:bg-accent-strong text-accent-fg text-xs font-medium self-start transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Suppression
              </button>
            </div>

            {/* Filter & Search Bar */}
            <div className="p-3 bg-surface-2 border-b border-line flex flex-col sm:flex-row items-center justify-between gap-2">
              <div className="relative w-full sm:w-72">
                <Search className="w-3.5 h-3.5 text-ink-subtle absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter by email address..."
                  className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-surface border border-line text-xs text-ink placeholder:text-ink-subtle outline-none"
                />
              </div>

              <div className="flex items-center gap-1.5 w-full sm:w-auto">
                {(['all', 'unsubscribed', 'bounced', 'manual_block', 'competitor'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setFilterReason(r)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-medium capitalize transition-colors ${
                      filterReason === r ? 'bg-accent text-accent-fg' : 'bg-surface border border-line text-ink-muted hover:text-ink'
                    }`}
                  >
                    {r.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>

            {/* Table */}
            {suppressionsLoading ? (
              <div className="p-8 text-center text-xs text-ink-muted">Loading suppressions...</div>
            ) : suppressions.length === 0 ? (
              <div className="p-8 text-center text-xs text-ink-subtle">
                No suppression records found matching the current filters.
              </div>
            ) : (
              <div className="divide-y divide-line/60">
                {suppressions.map((s) => (
                  <div key={s._id} className="px-5 py-3 flex items-center justify-between text-xs hover:bg-surface-2/60 transition-colors">
                    <div>
                      <div className="font-semibold text-ink">{s.email}</div>
                      <div className="text-[11px] text-ink-subtle mt-0.5">
                        Added {new Date(s.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] uppercase font-bold text-ink-muted">
                        {s.reason.replace('_', ' ')}
                      </span>
                      <button
                        onClick={() => deleteSuppressionMutation.mutate(s.email)}
                        className="p-1 rounded text-ink-subtle hover:text-danger hover:bg-danger/10 transition-colors"
                        title="Remove suppression"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* Add Suppression Modal */}
      {addModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setAddModalOpen(false)} />
          <div className="relative w-full max-w-md bg-surface border border-line rounded-2xl shadow-2xl p-5 z-10 space-y-4">
            <h3 className="text-base font-semibold text-ink">Add Email to Suppression Registry</h3>
            <p className="text-xs text-ink-muted">
              Prevent future outbound emails from being queued or sent to this email address.
            </p>

            {addError && <div className="p-2.5 rounded-xl bg-danger/10 text-danger text-xs">{addError}</div>}

            <form onSubmit={handleAddSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-ink-muted mb-1">Email Address</label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="contact@company.example.com"
                  className="w-full px-3 py-2 rounded-xl bg-surface-2 border border-line text-xs text-ink outline-none focus:border-accent"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-muted mb-1">Reason</label>
                <select
                  value={newReason}
                  onChange={(e: any) => setNewReason(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-surface-2 border border-line text-xs text-ink outline-none focus:border-accent"
                >
                  <option value="unsubscribed">Prospect Unsubscribed / Opted Out</option>
                  <option value="bounced">Hard Bounce / Invalid Mailbox</option>
                  <option value="manual_block">Manual Exclusion</option>
                  <option value="competitor">Competitor / Internal Exclusion</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAddModalOpen(false)}
                  className="px-3 py-1.5 rounded-xl border border-line text-xs font-medium text-ink-muted hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addSuppressionMutation.isPending}
                  className="px-4 py-1.5 rounded-xl bg-accent hover:bg-accent-strong text-accent-fg text-xs font-semibold transition-colors disabled:opacity-50"
                >
                  {addSuppressionMutation.isPending ? 'Adding...' : 'Confirm Suppression'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

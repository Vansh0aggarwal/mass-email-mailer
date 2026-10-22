import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Send,
  Plus,
  Users,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  Inbox,
} from 'lucide-react';
import { api } from '../lib/api';
import { Campaign } from '../types';
import { campaignStatusMeta } from '../lib/campaign';
import { ConfirmationModal } from '../components/common/ConfirmationModal';

export function CampaignsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [flashMessage, setFlashMessage] = useState<string | null>(
    (location.state as any)?.flashMessage || null
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [campaignToDelete, setCampaignToDelete] = useState<Campaign | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 8;

  // Clear navigation state so browser refresh doesn't replay the flash message
  useEffect(() => {
    if ((location.state as any)?.flashMessage) {
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  const {
    data: campaigns = [],
    isLoading,
    isRefetching,
    refetch,
  } = useQuery<Campaign[]>({
    queryKey: ['campaigns'],
    queryFn: () => api.get<Campaign[]>('/campaigns'),
    refetchOnMount: 'always',
  });

  const deleteMutation = useMutation({
    mutationFn: (campaignId: string) => api.delete(`/campaigns/${campaignId}`),
    onSuccess: async (_data, campaignId) => {
      const deletedName = campaignToDelete?.name || 'Campaign';
      setCampaignToDelete(null);
      await queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.removeQueries({ queryKey: ['campaign', campaignId] });
      queryClient.removeQueries({ queryKey: ['campaign-progress', campaignId] });
      queryClient.removeQueries({ queryKey: ['campaign-recipients', campaignId] });
      setFlashMessage(`Campaign "${deletedName}" was deleted successfully.`);
      setErrorMessage(null);
    },
    onError: (err: any) => {
      setCampaignToDelete(null);
      setErrorMessage(err.message || 'Failed to delete campaign.');
    },
  });

  const filteredCampaigns = useMemo(() => {
    return campaigns.filter((c) => {
      const matchesSearch =
        !searchQuery.trim() ||
        c.name.toLowerCase().includes(searchQuery.toLowerCase().trim()) ||
        c.mailboxId.toLowerCase().includes(searchQuery.toLowerCase().trim());

      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'draft'
          ? ['draft', 'ready_for_review'].includes(c.status)
          : c.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [campaigns, searchQuery, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredCampaigns.length / pageSize));

  // Automatically clamp current page if deleting the last campaign on the current page
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [totalPages, currentPage]);

  const pagedCampaigns = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredCampaigns.slice(start, start + pageSize);
  }, [filteredCampaigns, currentPage, pageSize]);

  // Aggregate statistics
  const totalCampaignsCount = campaigns.length;
  const activeCount = campaigns.filter((c) => ['sending', 'scheduled'].includes(c.status)).length;
  const totalRecipients = campaigns.reduce((acc, c) => acc + (c.stats?.totalRecipients || 0), 0);
  const totalSent = campaigns.reduce((acc, c) => acc + (c.stats?.sent || 0), 0);

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-accent-fg shadow-sm">
              <Send className="w-4 h-4" />
            </span>
            <span>Campaigns</span>
            <span className="badge badge-neutral text-xs font-semibold ml-1">
              {totalCampaignsCount}
            </span>
          </h1>
          <p className="text-xs text-ink-muted mt-1">
            Import prospect CSVs, personalize multi-step email sequences, review drafts, and dispatch reliably.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isRefetching}
            className="ios-btn-secondary px-3 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
            title="Reload campaign list"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <Link
            to="/campaigns/new"
            className="ios-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New campaign
          </Link>
        </div>
      </div>

      {/* Success Notification */}
      {flashMessage && (
        <div className="p-3.5 rounded-xl border border-success/30 bg-success/10 text-success text-xs font-medium flex items-center justify-between animate-in fade-in duration-200">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{flashMessage}</span>
          </div>
          <button
            onClick={() => setFlashMessage(null)}
            className="p-1 rounded-md hover:bg-success/20 text-success"
            title="Dismiss message"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Error Notification */}
      {errorMessage && (
        <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs font-medium flex items-center justify-between animate-in fade-in duration-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="p-1 rounded-md hover:bg-danger/20 text-danger"
            title="Dismiss message"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Metric Stat Summary Pills */}
      {totalCampaignsCount > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="ios-card rounded-xl p-3 border border-line flex flex-col justify-between">
            <span className="text-[11px] text-ink-muted">Total Campaigns</span>
            <span className="text-lg font-semibold text-ink mt-1 font-mono">{totalCampaignsCount}</span>
          </div>
          <div className="ios-card rounded-xl p-3 border border-line flex flex-col justify-between">
            <span className="text-[11px] text-ink-muted">Active / Sending</span>
            <span className="text-lg font-semibold text-brand mt-1 font-mono">{activeCount}</span>
          </div>
          <div className="ios-card rounded-xl p-3 border border-line flex flex-col justify-between">
            <span className="text-[11px] text-ink-muted">Total Recipients</span>
            <span className="text-lg font-semibold text-ink mt-1 font-mono">{totalRecipients}</span>
          </div>
          <div className="ios-card rounded-xl p-3 border border-line flex flex-col justify-between">
            <span className="text-[11px] text-ink-muted">Emails Dispatched</span>
            <span className="text-lg font-semibold text-success mt-1 font-mono">{totalSent}</span>
          </div>
        </div>
      )}

      {/* Search & Filters */}
      {totalCampaignsCount > 0 && (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              type="text"
              placeholder="Search by name or mailbox..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="input pl-9 pr-3 py-1.5 text-xs w-full"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto text-xs pb-1 sm:pb-0">
            {(['all', 'draft', 'scheduled', 'sending', 'paused', 'completed'] as const).map((st) => (
              <button
                key={st}
                onClick={() => {
                  setStatusFilter(st);
                  setCurrentPage(1);
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold capitalize transition-colors ${
                  statusFilter === st
                    ? 'bg-brand text-white'
                    : 'text-ink-muted hover:text-ink hover:bg-surface-2'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Campaign List */}
      {isLoading ? (
        <div className="ios-card p-8">
          <div className="skeleton h-24 rounded-xl" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="ios-card empty-state p-10 space-y-4 text-center">
          <div className="w-14 h-14 rounded-xl bg-accent/10 border border-accent/30 text-accent flex items-center justify-center mx-auto">
            <Send className="w-7 h-7" />
          </div>
          <h3 className="text-base font-semibold text-ink tracking-tight">No campaigns yet</h3>
          <p className="text-xs text-ink-muted max-w-md mx-auto leading-relaxed">
            Start by uploading a prospect CSV. Drafts are generated deterministically from your step
            templates and must be reviewed before any send.
          </p>
          <Link
            to="/campaigns/new"
            className="ios-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Create your first campaign
          </Link>
        </div>
      ) : filteredCampaigns.length === 0 ? (
        <div className="ios-card p-8 text-center text-xs text-ink-muted space-y-2">
          <p>No campaigns match your filter or search query.</p>
          <button
            onClick={() => {
              setSearchQuery('');
              setStatusFilter('all');
            }}
            className="text-xs text-brand font-semibold hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3">
            {pagedCampaigns.map((c) => {
              const meta = campaignStatusMeta(c.status);
              return (
                <div
                  key={c._id}
                  onClick={() => navigate(`/campaigns/${c._id}`)}
                  className="ios-card rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-surface-3 transition-colors cursor-pointer border border-line group"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <span className="text-sm font-semibold text-ink truncate group-hover:text-brand transition-colors">
                        {c.name}
                      </span>
                      <span className={`badge ${meta.className} uppercase font-semibold text-[10px]`}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="text-[11px] text-ink-subtle mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="inline-flex items-center gap-1">
                        <Users className="w-3 h-3 text-ink-subtle" />
                        <span>{c.stats.totalRecipients} recipients</span>
                      </span>
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <CheckCircle2 className="w-3 h-3 text-success" />
                        <span>{c.stats.sent} sent</span>
                      </span>
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <AlertTriangle className="w-3 h-3 text-danger" />
                        <span>{c.stats.failed} failed</span>
                      </span>
                      {c.repliesReceived !== undefined && c.repliesReceived > 0 && (
                        <span className="inline-flex items-center gap-1 text-success tabular-nums font-semibold">
                          <Inbox className="w-3 h-3" />
                          <span>{c.repliesReceived} replies</span>
                        </span>
                      )}
                      <span>
                        {c.steps.length} step{c.steps.length === 1 ? '' : 's'}
                      </span>
                      <span className="font-mono text-ink-muted">{c.mailboxId}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[11px] text-ink-subtle tabular-nums font-mono">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCampaignToDelete(c);
                      }}
                      disabled={deleteMutation.isPending}
                      className="p-1.5 rounded-lg text-ink-muted hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-40"
                      title={`Delete "${c.name}"`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-ink-muted pt-2 px-1">
              <span>
                Showing {(currentPage - 1) * pageSize + 1}–
                {Math.min(currentPage * pageSize, filteredCampaigns.length)} of {filteredCampaigns.length} campaigns
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  className="ios-btn-secondary px-2.5 py-1 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-40"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Prev</span>
                </button>
                <span className="px-2 font-mono font-medium text-ink">
                  {currentPage} / {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  className="ios-btn-secondary px-2.5 py-1 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-40"
                >
                  <span>Next</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Confirmation Modal for Direct Campaign Deletion */}
      {campaignToDelete && (
        <ConfirmationModal
          isOpen={!!campaignToDelete}
          onClose={() => !deleteMutation.isPending && setCampaignToDelete(null)}
          onConfirm={() => campaignToDelete && deleteMutation.mutate(campaignToDelete._id)}
          title="Delete Campaign"
          description={`Are you sure you want to delete "${campaignToDelete.name}"?`}
          details={[
            'All campaign recipients and generated email drafts will be removed.',
            'Any pending or scheduled sequence steps will be cancelled immediately.',
            'Companies and contacts in your workspace will NOT be deleted.',
            'This action cannot be undone.',
          ]}
          confirmText={deleteMutation.isPending ? 'Deleting…' : 'Delete Campaign'}
          cancelText="Cancel"
          isDestructive={true}
          isLoading={deleteMutation.isPending}
        />
      )}
    </div>
  );
}

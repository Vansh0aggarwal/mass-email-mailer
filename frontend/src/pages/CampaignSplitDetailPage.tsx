import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Layers,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wrench,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import type { CampaignStatus } from '../types';
import { campaignStatusMeta } from '../lib/campaign';
import {
  CampaignSplitJob,
  DEFAULT_SPLIT_PATTERN,
  SPLIT_PRESETS,
  SplitChildCampaignPage,
  SplitRecipientIntegrity,
  buildChildCampaignName,
  computeSplitPlan,
  formatDurationSeconds,
  formatFileSize,
  isSplitJobActive,
  isSplitJobTerminal,
  splitStatusMeta,
} from '../lib/campaign-split';
import { formatAuditDate } from '../lib/ownership';
import { ConfirmationModal } from '../components/common/ConfirmationModal';

const PAGE_SIZE = 50;

export function CampaignSplitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [contactsPerCampaign, setContactsPerCampaign] = useState(100);
  const [customContactsPerCampaign, setCustomContactsPerCampaign] = useState('100');
  const [groupName, setGroupName] = useState('');
  const [pattern, setPattern] = useState(DEFAULT_SPLIT_PATTERN);
  const [error, setError] = useState('');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const jobQuery = useQuery<CampaignSplitJob>({
    queryKey: ['campaign-split-job', id],
    queryFn: () => api.get<CampaignSplitJob>(`/campaign-splits/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && isSplitJobActive(status) ? 1500 : false;
    },
  });
  const job = jobQuery.data;

  const campaignsQuery = useQuery<SplitChildCampaignPage>({
    queryKey: ['campaign-split-campaigns', id, page],
    queryFn: () =>
      api.get<SplitChildCampaignPage>(`/campaign-splits/${id}/campaigns?page=${page}&limit=${PAGE_SIZE}`),
    enabled: Boolean(id),
    refetchInterval: () => (job && isSplitJobActive(job.status) ? 4000 : false),
  });
  const campaignPage = campaignsQuery.data;

  useEffect(() => {
    if (!job || initialized) return;
    setContactsPerCampaign(job.contactsPerCampaign || 100);
    setCustomContactsPerCampaign(String(job.contactsPerCampaign || 100));
    setGroupName(job.groupName || '');
    setPattern(job.campaignNamePattern || DEFAULT_SPLIT_PATTERN);
    setInitialized(true);
  }, [job, initialized]);

  const plan = useMemo(() => {
    const valid = job?.progress.analysis.validContacts || 0;
    return computeSplitPlan(valid, contactsPerCampaign);
  }, [job?.progress.analysis.validContacts, contactsPerCampaign]);

  const planMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/campaign-splits/${id}/plan`, {
        contactsPerCampaign: Math.max(1, Number(contactsPerCampaign) || 1),
        groupName: groupName.trim(),
        campaignNamePattern: pattern.trim(),
      });
      return api.post<CampaignSplitJob>(`/campaign-splits/${id}/generate`);
    },
    onSuccess: () => {
      setError('');
      jobQuery.refetch();
      campaignsQuery.refetch();
    },
    onError: (err: any) => setError(err?.message || 'Failed to start campaign generation.'),
  });

  const retryMutation = useMutation({
    mutationFn: () => api.post<CampaignSplitJob>(`/campaign-splits/${id}/retry`),
    onSuccess: () => {
      setError('');
      jobQuery.refetch();
    },
    onError: (err: any) => setError(err?.message || 'Failed to retry this import.'),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.post<CampaignSplitJob>(`/campaign-splits/${id}/cancel`),
    onSuccess: () => {
      setShowCancelConfirm(false);
      jobQuery.refetch();
    },
    onError: (err: any) => {
      setShowCancelConfirm(false);
      setError(err?.message || 'Failed to cancel this import.');
    },
  });

  const [integrity, setIntegrity] = useState<SplitRecipientIntegrity | null>(null);

  const integrityMutation = useMutation({
    mutationFn: (mode: 'audit' | 'repair') =>
      mode === 'repair'
        ? api.post<SplitRecipientIntegrity>(`/campaign-splits/${id}/recipients/repair`)
        : api.get<SplitRecipientIntegrity>(`/campaign-splits/${id}/recipients/integrity`),
    onSuccess: (report) => {
      setIntegrity(report);
      setError('');
      if (report.repaired) {
        jobQuery.refetch();
        campaignsQuery.refetch();
      }
    },
    onError: (err: any) =>
      setError(err?.message || 'Failed to check campaign recipients. Please try again.'),
  });

  if (jobQuery.isLoading) {
    return (
      <div className="max-w-5xl ios-card rounded-xl p-12 flex items-center justify-center text-ink-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="max-w-5xl ios-card rounded-xl p-10 text-center space-y-3">
        <XCircle className="w-8 h-8 text-danger mx-auto" />
        <h2 className="text-sm font-semibold text-ink">Split import not found</h2>
        <Link to="/campaigns/splits" className="ios-btn-secondary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2">
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to split imports
        </Link>
      </div>
    );
  }

  const meta = splitStatusMeta(job.status);
  const analysis = job.progress.analysis;
  const generation = job.progress.generation;
  const totalPages = campaignPage ? Math.max(1, Math.ceil(campaignPage.total / PAGE_SIZE)) : 1;
  const failureNumbers = campaignPage?.failedCampaignNumbers || generation.failedCampaignNumbers;
  // Split size is locked once generation starts; partial failures are retried,
  // never re-split.
  const canGenerate = job.status === 'ready';
  const canCheckRecipients =
    isSplitJobTerminal(job.status) &&
    generation.allocationComplete &&
    generation.campaignsCreated > 0;
  const integrityDrift = Boolean(
    integrity && (integrity.missingRecipients > 0 || integrity.campaignsWithStatsDrift > 0)
  );
  const driftingCampaigns =
    integrity?.campaigns.filter(
      (campaign) =>
        campaign.missingRecipients > 0 ||
        campaign.extraRecipients > 0 ||
        campaign.statsOutOfSync
    ) ?? [];

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <Link to="/campaigns/splits" className="text-xs text-ink-muted hover:text-ink inline-flex items-center gap-1.5 mb-3">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to split imports
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-accent-fg shadow-sm">
                <Layers className="w-4 h-4" />
              </span>
              {job.groupName}
            </h1>
            <p className="text-xs text-ink-muted mt-1 font-mono">
              {job.fileName} · {formatFileSize(job.fileSizeBytes)} · {analysis.totalRowsIsExact ? '' : '~'}
              {analysis.totalRows.toLocaleString()} rows
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`badge ${meta.className}`}>{meta.label}</span>
            <button
              onClick={() => {
                jobQuery.refetch();
                campaignsQuery.refetch();
              }}
              className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3 h-3 ${jobQuery.isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-[11px] font-semibold underline">
            Dismiss
          </button>
        </div>
      )}

      {job.errorMessage && (
        <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs">{job.errorMessage}</div>
      )}

      {isSplitJobActive(job.status) && (
        <div className="ios-card rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-ink flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-accent animate-spin" />
              {job.progress.message}
            </div>
            <button
              onClick={() => setShowCancelConfirm(true)}
              disabled={job.status === 'cancellation_requested' || cancelMutation.isPending}
              className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold text-danger border-danger/30 hover:bg-danger/10 inline-flex items-center gap-1 disabled:opacity-40"
            >
              <Ban className="w-3 h-3" />
              {job.status === 'cancellation_requested' ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] text-ink-muted">
                <span>Contact analysis</span>
                <span className="font-mono">{analysis.percent}%</span>
              </div>
              <div className="h-2 bg-surface-2 rounded-full overflow-hidden border border-line">
                <div className="h-full bg-accent transition-all duration-300" style={{ width: `${Math.max(2, analysis.percent)}%` }} />
              </div>
              <div className="text-[10px] text-ink-subtle font-mono">
                {analysis.processedRows.toLocaleString()} / {analysis.totalRows.toLocaleString()} rows
                {analysis.estimatedSecondsRemaining > 0 ? ` · ETA ${formatDurationSeconds(analysis.estimatedSecondsRemaining)}` : ''}
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] text-ink-muted">
                <span>Campaign generation</span>
                <span className="font-mono">{generation.percent}%</span>
              </div>
              <div className="h-2 bg-surface-2 rounded-full overflow-hidden border border-line">
                <div className="h-full bg-accent transition-all duration-300" style={{ width: `${Math.max(2, generation.percent)}%` }} />
              </div>
              <div className="text-[10px] text-ink-subtle font-mono">
                {generation.campaignsCreated.toLocaleString()} / {generation.expectedCampaigns.toLocaleString()} campaigns
                {generation.currentCampaignName ? ` · ${generation.currentCampaignName}` : ''}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 text-xs">
        {[
          { label: 'Valid contacts', value: analysis.validContacts, tone: 'text-success' },
          { label: 'Invalid', value: analysis.invalidContacts, tone: 'text-danger' },
          { label: 'Duplicates', value: analysis.duplicateContacts, tone: 'text-warning' },
          { label: 'Suppressed', value: analysis.suppressedContacts, tone: 'text-ink-muted' },
        ].map((stat) => (
          <div key={stat.label} className="ios-card p-3.5 rounded-xl">
            <div className="text-[10px] uppercase font-semibold text-ink-subtle">{stat.label}</div>
            <div className={`text-lg font-bold mt-1 tabular-nums ${stat.tone}`}>{stat.value.toLocaleString()}</div>
          </div>
        ))}
      </div>

      <div className="ios-card rounded-xl p-5">
        <div className="text-sm font-semibold text-ink mb-3">Parent import details</div>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px]">
          <div>
            <dt className="text-ink-subtle">Import ID</dt>
            <dd className="text-ink font-mono break-all">{job.id}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Created by (user ID)</dt>
            <dd className="text-ink font-mono break-all">{job.createdBy || '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Contacts per campaign</dt>
            <dd className="text-ink tabular-nums">{job.contactsPerCampaign.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Expected campaigns</dt>
            <dd className="text-ink tabular-nums">{generation.expectedCampaigns.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Campaigns created</dt>
            <dd className="text-ink tabular-nums">{generation.campaignsCreated.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Contacts assigned</dt>
            <dd className="text-ink tabular-nums">{generation.contactsAssigned.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Failed creations</dt>
            <dd className={`tabular-nums ${generation.failedCampaigns > 0 ? 'text-danger' : 'text-ink'}`}>
              {generation.failedCampaigns.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Created</dt>
            <dd className="text-ink">{formatAuditDate(job.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Analysis finished</dt>
            <dd className="text-ink">{formatAuditDate(job.analyzedAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Completed</dt>
            <dd className="text-ink">{formatAuditDate(job.completedAt)}</dd>
          </div>
        </dl>
      </div>

      {canCheckRecipients && (
        <div className="ios-card rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-ink flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-brand" />
                Recipient integrity
              </div>
              <p className="text-[11px] text-ink-muted mt-1 max-w-xl leading-relaxed">
                Compares every child campaign with the contacts reserved for it during this import.
                Missing recipients are restored from the import's staging rows; nothing is deleted
                and deleted campaigns are never recreated.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => integrityMutation.mutate('audit')}
                disabled={integrityMutation.isPending}
                className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
              >
                <RefreshCw
                  className={`w-3 h-3 ${integrityMutation.isPending ? 'animate-spin' : ''}`}
                />
                Check recipients
              </button>
              {integrityDrift && (
                <button
                  onClick={() => integrityMutation.mutate('repair')}
                  disabled={integrityMutation.isPending}
                  className="ios-btn-primary px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
                >
                  <Wrench className="w-3 h-3" />
                  Restore missing
                </button>
              )}
            </div>
          </div>

          {integrity && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                {[
                  { label: 'Reserved', value: integrity.expectedRecipients, tone: 'text-ink' },
                  { label: 'In campaigns', value: integrity.actualRecipients, tone: 'text-ink' },
                  {
                    label: 'Missing',
                    value: integrity.missingRecipients,
                    tone: integrity.missingRecipients > 0 ? 'text-danger' : 'text-success',
                  },
                  {
                    label: 'Extra',
                    value: integrity.extraRecipients,
                    tone: integrity.extraRecipients > 0 ? 'text-warning' : 'text-success',
                  },
                ].map((stat) => (
                  <div key={stat.label} className="rounded-lg border border-line bg-surface-2 p-3">
                    <div className="text-[10px] uppercase font-semibold text-ink-subtle">
                      {stat.label}
                    </div>
                    <div className={`text-lg font-bold mt-1 tabular-nums ${stat.tone}`}>
                      {stat.value.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>

              {integrity.repaired ? (
                <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-[11px] text-success">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  {integrity.repairedRecipients > 0
                    ? `Restored ${integrity.repairedRecipients.toLocaleString()} recipient(s) in ${integrity.repairedCampaigns.toLocaleString()} campaign(s). Campaign totals were reconciled with the actual recipient counts.`
                    : 'Campaign totals were reconciled with the actual recipient counts.'}
                </div>
              ) : integrityDrift ? (
                <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-[11px] text-warning">
                  {integrity.missingRecipients.toLocaleString()} reserved contact(s) are missing from
                  their campaigns
                  {integrity.campaignsWithStatsDrift > 0
                    ? ` and ${integrity.campaignsWithStatsDrift.toLocaleString()} campaign total(s) are out of sync`
                    : ''}
                  . Choose “Restore missing” to recreate them from the import staging rows.
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-[11px] text-success">
                  <ShieldCheck className="w-4 h-4 flex-shrink-0" />
                  No reserved contacts are missing and every campaign total matches its recipient
                  list.
                </div>
              )}

              {integrity.extraRecipients > 0 && (
                <div className="rounded-lg border border-line bg-surface-2/60 p-3 text-[11px] text-ink-muted">
                  {integrity.extraRecipients.toLocaleString()} recipient(s) exist beyond the
                  reserved set, likely added manually. They are left untouched.
                </div>
              )}

              {integrity.absentCampaignNumbers.length > 0 && (
                <div className="rounded-lg border border-line bg-surface-2/60 p-3 text-[11px] text-ink-muted">
                  Campaign number(s){' '}
                  <span className="font-mono">
                    {integrity.absentCampaignNumbers.slice(0, 20).join(', ')}
                    {integrity.absentCampaignNumbers.length > 20 ? '…' : ''}
                  </span>{' '}
                  no longer exist and are not recreated automatically.
                </div>
              )}

              {driftingCampaigns.length > 0 && (
                <div className="rounded-lg border border-line overflow-x-auto">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-surface-2 text-ink-subtle uppercase tracking-wider">
                      <tr>
                        <th className="px-3 py-2">Campaign</th>
                        <th className="px-3 py-2">Reserved</th>
                        <th className="px-3 py-2">In campaign</th>
                        <th className="px-3 py-2">Missing</th>
                        <th className="px-3 py-2">Recorded total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {driftingCampaigns.slice(0, 12).map((campaign) => (
                        <tr key={campaign.campaignId} className="border-t border-line">
                          <td className="px-3 py-2 text-ink">
                            <span className="font-mono text-ink-muted mr-2">
                              {String(campaign.campaignNumber).padStart(3, '0')}
                            </span>
                            {campaign.name}
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {campaign.expectedRecipients.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {campaign.actualRecipients.toLocaleString()}
                          </td>
                          <td
                            className={`px-3 py-2 tabular-nums ${
                              campaign.missingRecipients > 0 ? 'text-danger' : 'text-ink-muted'
                            }`}
                          >
                            {campaign.missingRecipients.toLocaleString()}
                          </td>
                          <td
                            className={`px-3 py-2 tabular-nums ${
                              campaign.statsOutOfSync ? 'text-warning' : 'text-ink-muted'
                            }`}
                          >
                            {campaign.recordedTotalRecipients.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {driftingCampaigns.length > 12 && (
                    <div className="px-3 py-2 text-[10px] text-ink-subtle border-t border-line">
                      Showing 12 of {driftingCampaigns.length.toLocaleString()} campaigns with drift.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {canGenerate && (
        <div className="ios-card rounded-xl p-5 space-y-4">
          <div className="text-sm font-semibold text-ink">Split configuration</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {SPLIT_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setContactsPerCampaign(preset);
                  setCustomContactsPerCampaign(String(preset));
                }}
                className={`rounded-xl border px-3 py-2.5 text-xs font-semibold transition ${
                  contactsPerCampaign === preset
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-line bg-surface-2 text-ink-muted hover:border-accent/30'
                }`}
              >
                {preset.toLocaleString()} / campaign
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1.5">Custom batch size</label>
              <input
                type="number"
                min={1}
                max={10000}
                className="input px-3 py-2 text-xs tabular-nums"
                value={customContactsPerCampaign}
                onChange={(e) => {
                  setCustomContactsPerCampaign(e.target.value);
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value >= 1) setContactsPerCampaign(Math.floor(value));
                }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1.5">Parent group name</label>
              <input className="input px-3 py-2 text-xs" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1.5">Naming pattern</label>
              <input
                className="input px-3 py-2 text-xs font-mono"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[11px] text-ink-muted">
              {plan.expectedCampaigns.toLocaleString()} campaigns · last campaign {plan.lastCampaignContacts.toLocaleString()} contacts
              {plan.expectedCampaigns > 0 && (
                <span className="block font-mono text-ink-subtle mt-1">
                  {buildChildCampaignName(pattern || DEFAULT_SPLIT_PATTERN, groupName, 1, plan.expectedCampaigns)} ·{' '}
                  {buildChildCampaignName(pattern || DEFAULT_SPLIT_PATTERN, groupName, plan.expectedCampaigns, plan.expectedCampaigns)}
                </span>
              )}
            </div>
            <button
              onClick={() => {
                setError('');
                planMutation.mutate();
              }}
              disabled={!plan.expectedCampaigns || planMutation.isPending || !pattern.includes('{number}')}
              className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-40 inline-flex items-center gap-2"
            >
              {planMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
              {`Create ${plan.expectedCampaigns.toLocaleString()} campaigns`}
            </button>
          </div>
        </div>
      )}

      {job.status === 'failed' && (
        <div className="ios-card rounded-xl p-5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-ink-muted">This import stopped before finishing. Already-created drafts are kept.</div>
          <button
            onClick={() => retryMutation.mutate()}
            disabled={retryMutation.isPending}
            className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-40"
          >
            {retryMutation.isPending ? 'Retrying…' : job.phase === 'analysis' ? 'Retry analysis' : 'Retry generation'}
          </button>
        </div>
      )}

      {job.status === 'completed_with_errors' && (
        <div className="p-3.5 rounded-xl border border-warning/40 bg-warning/10 text-warning text-xs flex flex-wrap items-center justify-between gap-3">
          <span>
            {generation.failedCampaigns.toLocaleString()} campaign(s) failed to create. Retrying only fills the missing ones.
          </span>
          <button
            onClick={() => retryMutation.mutate()}
            disabled={retryMutation.isPending}
            className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold disabled:opacity-40"
          >
            {retryMutation.isPending ? 'Retrying…' : 'Retry failed campaigns'}
          </button>
        </div>
      )}

      {failureNumbers.length > 0 && (
        <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs">
          Failed campaign numbers: {failureNumbers.slice(0, 30).join(', ')}
          {failureNumbers.length > 30 ? '…' : ''}
        </div>
      )}

      {job.hasErrorReport && (
        <a
          href={`/api/v1/campaign-splits/${job.id}/errors`}
          download
          className="ios-btn-secondary px-4 py-2 text-xs font-semibold inline-flex items-center gap-1.5 text-danger border-danger/40 hover:bg-danger/10"
        >
          <Download className="w-3.5 h-3.5" />
          Download rejected contacts (CSV)
        </a>
      )}

      <div className="ios-card rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-line flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-ink">
            Child campaigns
            <span className="badge badge-neutral text-[10px] ml-2">
              {(campaignPage?.total ?? generation.campaignsCreated).toLocaleString()}
            </span>
          </div>
          <div className="text-[11px] text-ink-subtle">
            Every campaign is a draft with its own review, schedule, and sending state.
          </div>
        </div>

        {campaignsQuery.isLoading ? (
          <div className="p-8 flex items-center justify-center text-ink-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : !campaignPage?.campaigns.length ? (
          <div className="p-8 text-center text-xs text-ink-muted">
            No child campaigns yet. Finish the split configuration to create them.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-surface-2 text-ink-subtle uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Campaign</th>
                    <th className="px-4 py-3">Contacts</th>
                    <th className="px-4 py-3">Creation</th>
                    <th className="px-4 py-3">Email sending</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignPage.campaigns.map((campaign) => {
                    const statusMeta = campaignStatusMeta(campaign.status as CampaignStatus);
                    return (
                      <tr key={campaign.id} className="border-t border-line hover:bg-surface-2/40">
                        <td className="px-4 py-3 font-mono text-ink-muted">
                          {String(campaign.campaignNumber ?? '').padStart(3, '0')}
                        </td>
                        <td className="px-4 py-3 text-ink font-medium">{campaign.name}</td>
                        <td className="px-4 py-3 tabular-nums">
                          {(campaign.stats?.totalRecipients || 0).toLocaleString()}
                        </td>
                        <td className="px-4 py-3">
                          <span className="badge badge-success inline-flex items-center gap-1">
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            Created
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`badge ${statusMeta.className}`}>{statusMeta.label}</span>
                        </td>
                        <td className="px-4 py-3 text-ink-muted">{formatAuditDate(campaign.createdAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <Link
                            to={`/campaigns/${campaign.id}`}
                            className="ios-btn-secondary px-2.5 py-1 text-[11px] font-semibold inline-flex items-center gap-1"
                          >
                            Open
                            <ArrowRight className="w-3 h-3" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="px-4 py-3 border-t border-line flex items-center justify-between text-[11px] text-ink-muted">
                <span>
                  Page {page} of {totalPages}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="ios-btn-secondary px-2 py-1 disabled:opacity-40"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="ios-btn-secondary px-2 py-1 disabled:opacity-40"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="text-[11px] text-ink-subtle bg-surface-2/60 p-3 rounded-xl border border-line/60 flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 text-brand flex-shrink-0 mt-0.5" />
        <p className="leading-relaxed">
          These campaigns never send automatically. Review drafts and approve each campaign using the existing campaign workflow; suppression lists, mailbox authorization, and daily quotas are still enforced at send time.
        </p>
      </div>

      <button
        onClick={() => navigate('/campaigns/splits/new?new=1')}
        className="ios-btn-secondary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2"
      >
        <FileSpreadsheet className="w-3.5 h-3.5" />
        Start another split import
      </button>

      <ConfirmationModal
        isOpen={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={() => cancelMutation.mutate()}
        title="Cancel this split import?"
        description="Analysis or campaign generation will stop. Campaigns already created are kept as drafts. No emails are sent."
        confirmText="Yes, cancel import"
        cancelText="Keep running"
        isDestructive
        isLoading={cancelMutation.isPending}
        icon={Ban}
      />
    </div>
  );
}

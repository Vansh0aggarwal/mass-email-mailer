import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, FileSpreadsheet, Layers, Loader2, Plus, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import {
  CampaignSplitJob,
  formatFileSize,
  isSplitJobActive,
  splitStatusMeta,
} from '../lib/campaign-split';
import { formatAuditDate } from '../lib/ownership';

export function CampaignSplitsPage() {
  const { data: jobs = [], isLoading, isRefetching, refetch } = useQuery<CampaignSplitJob[]>({
    queryKey: ['campaign-splits'],
    queryFn: () => api.get<CampaignSplitJob[]>('/campaign-splits?limit=50'),
    refetchInterval: (query) =>
      (query.state.data || []).some((job) => isSplitJobActive(job.status)) ? 3000 : false,
  });

  const createdCampaigns = jobs.reduce((sum, job) => sum + job.progress.generation.campaignsCreated, 0);
  const assignedContacts = jobs.reduce((sum, job) => sum + job.progress.generation.contactsAssigned, 0);
  const activeImports = jobs.filter((job) => isSplitJobActive(job.status)).length;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-accent-fg shadow-sm">
              <Layers className="w-4 h-4" />
            </span>
            Split imports
          </h1>
          <p className="text-xs text-ink-muted mt-1">
            One uploaded prospect file becomes a group of child campaigns — each contact assigned exactly once and every campaign created as a draft.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isRefetching}
            className="ios-btn-secondary px-3 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
            title="Reload split imports"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <Link
            to="/campaigns/splits/new?new=1"
            className="ios-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New split import
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 text-xs">
        {[
          { label: 'Imports', value: jobs.length },
          { label: 'Active now', value: activeImports },
          { label: 'Campaigns created', value: createdCampaigns },
          { label: 'Contacts assigned', value: assignedContacts },
        ].map((stat) => (
          <div key={stat.label} className="ios-card p-3.5 rounded-xl">
            <div className="text-[10px] uppercase font-semibold text-ink-subtle">{stat.label}</div>
            <div className="text-lg font-bold text-ink mt-1 tabular-nums">{stat.value.toLocaleString()}</div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="ios-card rounded-xl p-10 flex items-center justify-center text-ink-muted">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="ios-card rounded-xl p-10 text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-accent/10 border border-accent/25 text-accent flex items-center justify-center mx-auto">
            <FileSpreadsheet className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">No split imports yet</h3>
            <p className="text-xs text-ink-muted mt-1">
              Upload a prospect file and choose how many contacts each child campaign should contain.
            </p>
          </div>
          <Link
            to="/campaigns/splits/new?new=1"
            className="ios-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Start a split import
          </Link>
        </div>
      ) : (
        <div className="ios-card rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-surface-2 text-ink-subtle uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">Import group</th>
                  <th className="px-4 py-3">Contacts</th>
                  <th className="px-4 py-3">Split size</th>
                  <th className="px-4 py-3">Campaigns</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const meta = splitStatusMeta(job.status);
                  const analysis = job.progress.analysis;
                  const generation = job.progress.generation;
                  return (
                    <tr key={job.id} className="border-t border-line hover:bg-surface-2/40">
                      <td className="px-4 py-3">
                        <Link to={`/campaigns/splits/${job.id}`} className="font-semibold text-ink hover:text-accent">
                          {job.groupName}
                        </Link>
                        <div className="text-[10px] text-ink-subtle font-mono truncate max-w-[220px]">
                          {job.fileName} · {formatFileSize(job.fileSizeBytes)}
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        <span className="text-success">{analysis.validContacts.toLocaleString()} valid</span>
                        <div className="text-[10px] text-ink-subtle">
                          {analysis.invalidContacts.toLocaleString()} invalid · {analysis.duplicateContacts.toLocaleString()} dup
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-muted">
                        {job.contactsPerCampaign.toLocaleString()} / campaign
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {generation.campaignsCreated.toLocaleString()} / {generation.expectedCampaigns.toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`badge ${meta.className}`}>{meta.label}</span>
                      </td>
                      <td className="px-4 py-3 text-ink-muted">{formatAuditDate(job.createdAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          to={`/campaigns/splits/${job.id}`}
                          className="ios-btn-secondary px-2.5 py-1 text-[11px] font-semibold inline-flex items-center gap-1"
                        >
                          Overview
                          <ArrowRight className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

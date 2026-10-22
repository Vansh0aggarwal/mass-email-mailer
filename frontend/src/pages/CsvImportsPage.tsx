import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ImportSummary, ImportJobStatus } from '../types';
import { Upload, Check, FileText, Info, Download, RotateCw, Eye } from 'lucide-react';
import { FIXED_FIELD_DEFS, guessColumnMapping, normalizeTokenKey } from '../lib/campaign';
import { describeImportError, formatBytes } from '../lib/imports';
import { CsvImportProgressModal } from '../components/imports/CsvImportProgressModal';

const PIPELINE = ['1. Upload', '2. Map fields', '3. Import', '4. Results'];
const MAX_VISIBLE_ERRORS = 50;

interface CustomFieldRow {
  source: string;
  target: string;
  enabled: boolean;
}

interface JobRowError {
  row: number;
  field: string;
  reason: string;
}

interface ImportJobDetail {
  _id: string;
  jobId?: string;
  fileName: string;
  status: ImportJobStatus;
  totalRows: number;
  processedRows: number;
  importedCount: number;
  updatedCount: number;
  duplicateRows: number;
  invalidRows: number;
  failedRows: number;
  errorRows: number;
  rowErrorCount: number;
  lastProcessedRow?: number;
  fileBytes?: number;
  headers: string[];
  sampleRows: Record<string, string>[];
  detectedMapping?: Record<string, string>;
  unmappedHeaders?: string[];
  missingRequiredFields?: string[];
  rowErrors?: JobRowError[];
  errorReportPath?: string;
  errorMessage?: string;
}

const ACTIVE_STATUSES: ImportJobStatus[] = ['queued', 'processing', 'pending'];

function isActive(status: ImportJobStatus | undefined): boolean {
  return !!status && ACTIVE_STATUSES.includes(status);
}

function statusLabel(status: ImportJobStatus): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'completed_with_errors':
      return 'Completed with errors';
    case 'processing':
      return 'Importing…';
    case 'queued':
      return 'Queued';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

export function CsvImportsPage() {
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [job, setJob] = useState<ImportJobDetail | null>(null);
  const [activeJobId, setActiveJobId] = useState<string>('');
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [customFields, setCustomFields] = useState<CustomFieldRow[]>([]);
  const [duplicatePolicy, setDuplicatePolicy] = useState<'skip' | 'update'>('skip');
  const [error, setError] = useState('');
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [clientProgressState, setClientProgressState] = useState<'preparing' | 'uploading' | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Recovery: Reconnect on mount if an active job was running or page refreshed
  useEffect(() => {
    const savedJobId = localStorage.getItem('radar_active_import_job_id');
    if (savedJobId) {
      setActiveJobId(savedJobId);
      setShowProgressModal(true);
      return;
    }

    api.get<any>('/imports/active')
      .then((res) => {
        if (res && res._id) {
          setActiveJobId(String(res._id));
          setShowProgressModal(true);
        }
      })
      .catch(() => {});
  }, []);

  const effectiveCustomMapping = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cf of customFields) if (cf.enabled && cf.target) map[cf.source] = normalizeTokenKey(cf.target);
    return map;
  }, [customFields]);

  const { data: importHistory = [] } = useQuery<ImportSummary[]>({
    queryKey: ['csv-imports'],
    queryFn: () => api.get<ImportSummary[]>('/imports'),
  });

  // Poll the active job until it leaves the queued/processing states.
  const { data: polledJob } = useQuery<ImportJobDetail>({
    queryKey: ['import-job', activeJobId],
    queryFn: () => api.get<ImportJobDetail>(`/imports/jobs/${activeJobId}`),
    enabled: !!activeJobId,
    refetchInterval: (query) => {
      const status = (query.state.data as ImportJobDetail | undefined)?.status;
      return isActive(status) ? 1200 : false;
    },
  });

  useEffect(() => {
    if (polledJob) {
      setJob((prev) => ({ ...(prev ?? ({} as ImportJobDetail)), ...polledJob }));
      if (!isActive(polledJob.status)) {
        queryClient.invalidateQueries({ queryKey: ['csv-imports'] });
        queryClient.invalidateQueries({ queryKey: ['companies'] });
      }
    }
  }, [polledJob, queryClient]);

  const initializeFromJob = (data: ImportJobDetail) => {
    setJob(data);
    setActiveJobId('');
    const headers = data.headers || [];
    const merged = guessColumnMapping(headers);
    for (const [key, header] of Object.entries(data.detectedMapping || {})) {
      if (!merged[key]) merged[key] = header;
    }
    setColumnMapping(merged);
    const used = new Set(Object.values(merged));
    setCustomFields(
      headers
        .filter((h) => !used.has(h))
        .map((h) => ({ source: h, target: normalizeTokenKey(h), enabled: false }))
    );
  };

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<ImportJobDetail>('/imports/jobs', form);
    },
    onSuccess: (data) => {
      setError('');
      setClientProgressState(null);
      initializeFromJob(data);
    },
    onError: (err: unknown) => {
      setClientProgressState(null);
      setError(describeImportError(err));
    },
  });

  const startMutation = useMutation({
    mutationFn: (jobId: string) =>
      api.post<ImportJobDetail>(`/imports/jobs/${jobId}/start`, {
        mapping: columnMapping,
        customFieldMapping: effectiveCustomMapping,
        duplicateStrategy: duplicatePolicy,
      }),
    onSuccess: (_data, jobId) => {
      setError('');
      setActiveJobId(jobId);
      setShowProgressModal(true);
      queryClient.invalidateQueries({ queryKey: ['csv-imports'] });
    },
    onError: (err: unknown) => setError(describeImportError(err)),
  });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => api.post<ImportJobDetail>(`/imports/jobs/${jobId}/retry`, {}),
    onSuccess: (_data, jobId) => {
      setError('');
      setActiveJobId(jobId);
      setShowProgressModal(true);
      queryClient.invalidateQueries({ queryKey: ['csv-imports'] });
    },
    onError: (err: unknown) => setError(describeImportError(err)),
  });

  const onFile = (file: File) => {
    setError('');
    setJob(null);
    setActiveJobId('');
    setFileSize(file.size);
    setFileName(file.name);
    setClientProgressState('uploading');
    uploadMutation.reset();
    startMutation.reset();
    uploadMutation.mutate(file);
  };

  const activeStep = job ? (isActive(job.status) ? 2 : 3) : uploadMutation.isPending ? 0 : fileName ? 1 : 0;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-accent-fg">
            <Upload className="w-4 h-4" />
          </span>
          <span>CSV Data Import Hub</span>
        </h1>
        <p className="text-xs text-ink-muted mt-1">
          Upload large prospect lists directly — files are streamed from disk and imported in safe batches, so even
          hundreds of thousands of rows import without running out of memory.
        </p>
      </div>

      <div className="ios-card rounded-xl p-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
          {PIPELINE.map((label, i) => (
            <div
              key={label}
              className={`rounded-lg px-3 py-2 font-semibold ${
                i === activeStep ? 'bg-accent/10 text-accent border border-accent/25' : 'bg-surface-2 text-ink-subtle'
              }`}
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs whitespace-pre-line" role="alert">
          {error}
        </div>
      )}

      <div className="ios-card rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">1. Choose a CSV file</h3>
            <p className="text-xs text-ink-muted mt-0.5">
              Headers are detected automatically. Nothing is written until you start the import.
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            id="csv-file-input"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />
          <label htmlFor="csv-file-input" className="inline-flex items-center gap-2 px-4 py-2 ios-btn-secondary text-xs font-semibold cursor-pointer">
            <Upload className="w-3.5 h-3.5" /> {fileName || 'Choose CSV file'}
          </label>
        </div>

        {fileName && (
          <div className="text-[11px] text-ink-subtle">
            {fileName} · {formatBytes(fileSize)}
          </div>
        )}

        {uploadMutation.isPending && <div className="text-xs text-ink-muted">Uploading &amp; inspecting file…</div>}

        {job && (
          <div className="pt-2 space-y-4">
            <div className="rounded-lg border border-line bg-surface-2 p-3.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-ink">
                <FileText className="w-3.5 h-3.5" /> {job.fileName || 'Uploaded CSV'}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-muted">
                <span>{job.totalRows.toLocaleString()} rows · {(job.headers || []).length} columns</span>
                <span>File size: {formatBytes(job.fileBytes || fileSize)}</span>
                <span className="badge">{statusLabel(job.status)}</span>
              </div>
            </div>

            {(job.missingRequiredFields?.length ?? 0) > 0 && (
              <div className="p-3 rounded-lg border border-warning/30 bg-warning/10 text-warning text-xs">
                Missing required mapping: {job.missingRequiredFields!.join(', ')}
              </div>
            )}

            {job.sampleRows?.length > 0 && (
              <div className="rounded-lg border border-line overflow-hidden">
                <div className="px-3.5 py-2 border-b border-line text-[11px] font-semibold text-ink">
                  Sample rows (first {job.sampleRows.length})
                </div>
                <div className="overflow-x-auto">
                  <table className="text-left text-[11px]">
                    <thead className="bg-surface-2 text-ink-subtle">
                      <tr>
                        {(job.headers || []).map((h) => (
                          <th key={h} className="px-2.5 py-2 font-medium whitespace-nowrap max-w-[160px] truncate" title={h}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {job.sampleRows.map((row, i) => (
                        <tr key={i} className="align-top">
                          {(job.headers || []).map((h) => (
                            <td key={h} className="px-2.5 py-2 text-ink-muted max-w-[200px] truncate" title={row[h] || ''}>
                              {row[h] || <span className="text-ink-subtle">—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {FIXED_FIELD_DEFS.map((def) => (
                <div key={def.key}>
                  <label className="block text-[11px] font-medium text-ink-muted mb-1">
                    {def.label}
                    {def.required && <span className="text-danger"> *</span>}
                  </label>
                  <select
                    className="input px-2.5 py-1.5 text-xs"
                    value={columnMapping[def.key] || ''}
                    onChange={(e) => setColumnMapping((m) => ({ ...m, [def.key]: e.target.value }))}
                  >
                    <option value="">— not mapped —</option>
                    {(job.headers || []).map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {customFields.length > 0 && (
              <div className="border-t border-line pt-3">
                <div className="text-[11px] font-semibold text-ink mb-1">Extra columns</div>
                <p className="text-[11px] text-ink-subtle mb-2 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" /> Unmapped columns are preserved as source metadata when enabled.
                </p>
                <div className="space-y-1.5">
                  {customFields.map((cf, i) => (
                    <div key={cf.source} className="flex items-center gap-2 text-[11px]">
                      <input
                        type="checkbox"
                        checked={cf.enabled}
                        onChange={(e) =>
                          setCustomFields((rows) => rows.map((r, idx) => (idx === i ? { ...r, enabled: e.target.checked } : r)))
                        }
                      />
                      <span className="w-40 truncate text-ink-muted" title={cf.source}>
                        {cf.source}
                      </span>
                      <input
                        className="input px-2 py-1 text-xs flex-1"
                        value={cf.target}
                        onChange={(e) =>
                          setCustomFields((rows) => rows.map((r, idx) => (idx === i ? { ...r, target: e.target.value } : r)))
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t border-line pt-3">
              <div className="text-[11px] font-semibold text-ink mb-2">Duplicate handling</div>
              <div className="flex flex-wrap gap-4 text-[11px]">
                {[
                  { value: 'skip' as const, label: 'Skip duplicates', hint: 'Do not touch existing records' },
                  { value: 'update', label: 'Update (fill empty only)', hint: 'Never overwrite existing values' },
                ].map((opt) => (
                  <label key={opt.value} className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="dupe-policy"
                      checked={duplicatePolicy === opt.value}
                      onChange={() => setDuplicatePolicy(opt.value as 'skip' | 'update')}
                    />
                    <span>
                      <span className="text-ink">{opt.label}</span>
                      <span className="block text-ink-subtle">{opt.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                onClick={() => startMutation.mutate(job.jobId || job._id)}
                disabled={!columnMapping.company_name || startMutation.isPending || isActive(job.status)}
                className="ios-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-40"
              >
                <Check className="w-3.5 h-3.5" />
                {startMutation.isPending || isActive(job.status)
                  ? 'Importing…'
                  : `Start import (${job.totalRows.toLocaleString()} rows)`}
              </button>
            </div>
          </div>
        )}
      </div>

      {job && (isActive(job.status) || job.status === 'completed' || job.status === 'completed_with_errors' || job.status === 'failed') && (
        <div className="ios-card rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-ink">3. Import progress &amp; results</h3>

          {isActive(job.status) && (
            <div>
              <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${job.totalRows ? Math.round((job.processedRows / job.totalRows) * 100) : 0}%` }}
                />
              </div>
              <div className="mt-1.5 text-[11px] text-ink-subtle">
                Processing row {job.processedRows.toLocaleString()} of {job.totalRows.toLocaleString()}… Safe to leave this page — the import continues on the server.
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total', value: job.totalRows, tone: 'text-ink' },
              { label: 'Processed', value: job.processedRows, tone: 'text-ink' },
              { label: 'Created', value: job.importedCount, tone: 'text-success' },
              { label: 'Updated', value: job.updatedCount, tone: 'text-success' },
              { label: 'Duplicates', value: job.duplicateRows, tone: 'text-warning' },
              { label: 'Invalid', value: job.invalidRows, tone: 'text-danger' },
              { label: 'Failed', value: job.failedRows, tone: 'text-danger' },
              { label: 'Status', value: statusLabel(job.status), tone: 'text-ink' },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-line p-3">
                <div className="text-[10px] uppercase tracking-wider text-ink-subtle">{s.label}</div>
                <div className={`text-lg font-semibold tabular-nums ${s.tone}`}>{s.value}</div>
              </div>
            ))}
          </div>

          {job.errorMessage && (
            <div className="p-3 rounded-lg border border-danger/30 bg-danger/10 text-danger text-[11px]">{job.errorMessage}</div>
          )}

          {(job.rowErrorCount > 0 || (job.rowErrors?.length ?? 0) > 0) && (
            <div className="rounded-lg border border-line">
              <div className="px-3.5 py-2.5 border-b border-line text-[11px] font-semibold text-ink flex items-center justify-between">
                <span>Row errors ({job.rowErrorCount || job.rowErrors?.length || 0})</span>
                <a
                  href={`/api/v1/imports/jobs/${job.jobId || job._id}/errors`}
                  className="ios-btn-secondary px-2.5 py-1 text-[11px] font-medium inline-flex items-center gap-1.5"
                >
                  <Download className="w-3 h-3" />
                  <span>Download full error report (.csv)</span>
                </a>
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-line">
                {(job.rowErrors || []).slice(0, MAX_VISIBLE_ERRORS).map((r, i) => (
                  <div key={`${r.row}-${i}`} className="px-3.5 py-2 text-[11px] text-ink-muted">
                    <span className="text-ink font-medium">Row {r.row}:</span> {r.field} — {r.reason}
                  </div>
                ))}
              </div>
            </div>
          )}

          {job.status === 'failed' && (
            <button
              onClick={() => retryMutation.mutate(job.jobId || job._id)}
              disabled={retryMutation.isPending}
              className="ios-btn-secondary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-40"
            >
              <RotateCw className="w-3.5 h-3.5" />
              {retryMutation.isPending ? 'Resuming…' : 'Resume import from last saved row'}
            </button>
          )}
        </div>
      )}

      <div className="ios-card rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-line flex items-center justify-between">
          <h3 className="text-xs font-semibold text-ink uppercase tracking-wider">Past import executions</h3>
          <span className="text-[11px] text-ink-subtle tabular-nums bg-surface-2 px-2.5 py-0.5 rounded-full">
            {importHistory.length} total
          </span>
        </div>
        {importHistory.length === 0 ? (
          <div className="empty-state p-8 text-xs">No previous imports recorded.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-surface-2 border-b border-line text-ink-subtle font-semibold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="px-5 py-3.5">File name</th>
                  <th className="px-5 py-3.5">Total</th>
                  <th className="px-5 py-3.5">Created</th>
                  <th className="px-5 py-3.5">Updated</th>
                  <th className="px-5 py-3.5">Errors</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-ink">
                {importHistory.map((item) => (
                  <tr key={item._id} className="hover:bg-surface-3 transition-colors">
                    <td className="px-5 py-3.5 font-medium">{item.fileName}</td>
                    <td className="px-5 py-3.5 tabular-nums text-ink-muted">{item.totalRows}</td>
                    <td className="px-5 py-3.5 tabular-nums text-success">{item.importedCount}</td>
                    <td className="px-5 py-3.5 tabular-nums text-success">{item.updatedCount ?? 0}</td>
                    <td className="px-5 py-3.5 tabular-nums text-danger">{item.errorRows}</td>
                    <td className="px-5 py-3.5">
                      <span className="badge">{statusLabel(item.status)}</span>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveJobId(item._id);
                            setFileName(item.fileName || 'Import File');
                            setShowProgressModal(true);
                          }}
                          className="ios-btn-secondary px-2.5 py-1 text-[11px] font-medium inline-flex items-center gap-1.5"
                          title="View live metrics and progress details"
                        >
                          <Eye className="w-3 h-3" /> Details
                        </button>
                        {item.status === 'failed' && (
                          <button
                            type="button"
                            onClick={() => retryMutation.mutate(item._id)}
                            className="ios-btn-secondary px-2.5 py-1 text-[11px] font-medium inline-flex items-center gap-1.5"
                          >
                            <RotateCw className="w-3 h-3" /> Resume
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showProgressModal && activeJobId && (
        <CsvImportProgressModal
          jobId={activeJobId}
          isOpen={showProgressModal}
          fileName={fileName || job?.fileName || 'swaniki_verified_outbound_campaign.csv'}
          clientState={clientProgressState}
          onClose={() => {
            setShowProgressModal(false);
            setClientProgressState(null);
            queryClient.invalidateQueries({ queryKey: ['importHistory'] });
            queryClient.invalidateQueries({ queryKey: ['csv-imports'] });
            queryClient.invalidateQueries({ queryKey: ['companies'] });
          }}
        />
      )}
    </div>
  );
}

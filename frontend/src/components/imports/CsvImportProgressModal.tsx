import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Download,
  Building2,
  X,
  Clock,
  ShieldAlert,
  Ban,
  Loader2,
} from 'lucide-react';
import { api } from '../../lib/api';
import { ConfirmationModal } from '../common/ConfirmationModal';

export type ImportProgressState =
  | 'preparing'
  | 'uploading'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancellation_requested'
  | 'cancelling'
  | 'cancelled';

export interface ImportJobProgressData {
  _id?: string;
  jobId?: string;
  fileName: string;
  status:
    | 'queued'
    | 'processing'
    | 'completed'
    | 'completed_with_errors'
    | 'failed'
    | 'pending'
    | 'cancellation_requested'
    | 'cancelling'
    | 'cancelled';
  totalRows: number;
  processedRows: number;
  importedCount: number;
  updatedCount: number;
  duplicateRows: number;
  invalidRows: number;
  failedRows: number;
  errorRows?: number;
  percent?: number;
  errorMessage?: string;
  rowErrors?: { row: number; field: string; reason: string }[];
  rowErrorCount?: number;
}

interface CsvImportProgressModalProps {
  jobId: string;
  isOpen: boolean;
  onClose: () => void;
  fileName?: string;
  clientState?: 'preparing' | 'uploading' | null;
}

export function CsvImportProgressModal({
  jobId,
  isOpen,
  onClose,
  fileName: fallbackFileName,
  clientState,
}: CsvImportProgressModalProps) {
  const navigate = useNavigate();
  const [job, setJob] = useState<ImportJobProgressData | null>(null);
  const [isDownloadingErrors, setIsDownloadingErrors] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'streaming' | 'polling' | 'disconnected'>('streaming');
  const [showConfirmCancel, setShowConfirmCancel] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const pollTimerRef = useRef<any>(null);

  // Derive unified progress state
  const currentState: ImportProgressState = (() => {
    if (clientState === 'preparing') return 'preparing';
    if (clientState === 'uploading') return 'uploading';
    if (!job) return 'processing';
    if (job.status === 'completed') return 'completed';
    if (job.status === 'completed_with_errors') return 'completed_with_errors';
    if (job.status === 'failed') return 'failed';
    if (job.status === 'cancellation_requested') return 'cancellation_requested';
    if (job.status === 'cancelling') return 'cancelling';
    if (job.status === 'cancelled') return 'cancelled';
    return 'processing';
  })();

  const isDone = currentState === 'completed' || currentState === 'completed_with_errors' || currentState === 'failed' || currentState === 'cancelled';
  const isCancelled = currentState === 'cancelled';
  const isCancellingState = currentState === 'cancellation_requested' || currentState === 'cancelling' || isCancelling;

  const handleCancelConfirm = async () => {
    setShowConfirmCancel(false);
    setIsCancelling(true);
    try {
      setJob((prev) => (prev ? { ...prev, status: 'cancellation_requested' } : null));
      const res = await api.post<ImportJobProgressData>(`/imports/jobs/${jobId}/cancel`);
      if (res) {
        setJob((prev) => ({ ...prev, ...res }));
      }
      localStorage.removeItem('radar_active_import_job_id');
    } catch (err) {
      console.error('Failed to cancel import job:', err);
    } finally {
      setIsCancelling(false);
    }
  };

  // Fetch job via standard polling helper
  const fetchJobStatus = async () => {
    if (!jobId) return;
    try {
      const res = await api.get<ImportJobProgressData>(`/imports/jobs/${jobId}`);
      if (res) {
        setJob((prev) => ({ ...prev, ...res }));
      }
    } catch (err) {
      console.warn('Failed to poll import job status:', err);
    }
  };

  // Setup Server-Sent Events with fallback to polling
  useEffect(() => {
    if (!isOpen || !jobId) return;

    // Immediately fetch initial status
    fetchJobStatus();

    // Persist active job id in localStorage so progress survives page refresh
    localStorage.setItem('radar_active_import_job_id', jobId);

    let eventSource: EventSource | null = null;
    let fallbackInterval: any = null;

    try {
      // Connect to SSE stream
      eventSource = new EventSource(`/api/v1/imports/jobs/${jobId}/stream`);

      eventSource.onopen = () => {
        setConnectionStatus('streaming');
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setJob((prev) => ({ ...prev, ...data }));
          if (['completed', 'completed_with_errors', 'failed'].includes(data.status)) {
            localStorage.removeItem('radar_active_import_job_id');
            eventSource?.close();
          }
        } catch (e) {
          console.error('Error parsing SSE event data', e);
        }
      };

      eventSource.onerror = () => {
        setConnectionStatus('polling');
        eventSource?.close();
        // Fallback to active polling every 800ms
        if (!fallbackInterval) {
          fallbackInterval = setInterval(async () => {
            await fetchJobStatus();
          }, 800);
        }
      };
    } catch {
      setConnectionStatus('polling');
      fallbackInterval = setInterval(fetchJobStatus, 800);
    }

    return () => {
      if (eventSource) eventSource.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [isOpen, jobId]);

  // Clean up localStorage upon completion
  useEffect(() => {
    if (isDone) {
      localStorage.removeItem('radar_active_import_job_id');
    }
  }, [isDone]);

  if (!isOpen) return null;

  const total = job?.totalRows ?? 0;
  const processed = job?.processedRows ?? 0;
  const successful = (job?.importedCount ?? 0) + (job?.updatedCount ?? 0);
  const duplicates = job?.duplicateRows ?? 0;
  const failed = (job?.invalidRows ?? 0) + (job?.failedRows ?? 0);

  const calculatedPercent = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
  const formattedPercent = calculatedPercent.toFixed(2);

  const displayFileName = job?.fileName || fallbackFileName || 'import_file.csv';

  const handleDownloadErrorReport = async () => {
    if (!jobId) return;
    setIsDownloadingErrors(true);
    try {
      const token = localStorage.getItem('radar_token');
      const res = await fetch(`/api/v1/imports/jobs/${jobId}/errors`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to download error report');
      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `import_errors_${jobId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      console.error('Error downloading error report:', err);
    } finally {
      setIsDownloadingErrors(false);
    }
  };

  const handleViewCompanies = () => {
    onClose();
    navigate('/companies');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity" />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-xl bg-surface border border-line rounded-2xl shadow-2xl p-6 z-10 space-y-5 animate-in fade-in-0 zoom-in-95 duration-150 select-none">
        {/* Top Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 text-accent flex items-center justify-center shrink-0">
              {currentState === 'completed' ? (
                <CheckCircle2 className="w-5 h-5 text-success" />
              ) : currentState === 'completed_with_errors' ? (
                <AlertTriangle className="w-5 h-5 text-warning" />
              ) : currentState === 'failed' ? (
                <XCircle className="w-5 h-5 text-danger" />
              ) : (
                <FileSpreadsheet className="w-5 h-5 text-accent animate-pulse" />
              )}
            </div>

            <div>
              <h2 className="text-base font-bold text-ink tracking-tight">
                {currentState === 'completed'
                  ? 'Import Completed Successfully'
                  : currentState === 'completed_with_errors'
                  ? 'Import Completed with Issues'
                  : currentState === 'failed'
                  ? 'Import Failed'
                  : 'Importing Companies'}
              </h2>
              <div className="text-xs text-ink-muted truncate max-w-xs font-mono mt-0.5">
                {displayFileName}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                currentState === 'completed'
                  ? 'bg-success/15 text-success border border-success/30'
                  : currentState === 'completed_with_errors'
                  ? 'bg-warning/15 text-warning border border-warning/30'
                  : currentState === 'failed'
                  ? 'bg-danger/15 text-danger border border-danger/30'
                  : 'bg-accent/15 text-accent border border-accent/30 animate-pulse'
              }`}
            >
              {currentState.replace('_', ' ')}
            </span>

            {isDone && (
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-ink-subtle hover:text-ink hover:bg-surface-2 transition-colors"
                aria-label="Close dialog"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Live Counter & Progress Bar */}
        <div className="space-y-2 rounded-xl bg-surface-2 border border-line p-4">
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-semibold text-ink">
              {currentState === 'preparing' && 'Preparing file & calculating records…'}
              {currentState === 'uploading' && 'Uploading CSV to server…'}
              {currentState === 'processing' && (
                <span>
                  <strong className="text-accent tabular-nums">{processed.toLocaleString()}</strong> of{' '}
                  <strong className="tabular-nums">{total.toLocaleString()}</strong> processed
                </span>
              )}
              {isDone && (
                <span>
                  Processed <strong className="tabular-nums">{processed.toLocaleString()}</strong> of{' '}
                  <strong className="tabular-nums">{total.toLocaleString()}</strong> records
                </span>
              )}
            </div>
            <span className="text-base font-bold text-accent tabular-nums">
              {currentState === 'completed' ? '100%' : `${formattedPercent}%`}
            </span>
          </div>

          {/* Smooth Progress Bar */}
          <div className="w-full h-2.5 rounded-full bg-surface-3 overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ease-out ${
                currentState === 'completed'
                  ? 'bg-success'
                  : currentState === 'completed_with_errors'
                  ? 'bg-warning'
                  : currentState === 'failed'
                  ? 'bg-danger'
                  : 'bg-accent'
              }`}
              style={{
                width: currentState === 'completed' ? '100%' : `${Math.min(100, Math.max(2, calculatedPercent))}%`,
              }}
            />
          </div>

          {/* Sub-label */}
          <div className="flex items-center justify-between text-[11px] text-ink-subtle pt-0.5">
            <span>
              {currentState === 'processing' && 'Updating automatically from streaming database batches…'}
              {currentState === 'completed' && 'All company and contact records committed to database.'}
              {currentState === 'completed_with_errors' && 'Finished with non-fatal row validation errors.'}
              {currentState === 'failed' && (job?.errorMessage || 'Database write phase encountered an error.')}
            </span>
            {connectionStatus === 'streaming' && !isDone && (
              <span className="flex items-center gap-1 text-[10px] text-success">
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-ping" />
                Live Stream
              </span>
            )}
          </div>
        </div>

        {/* Real-Time Detailed Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
          <div className="rounded-xl border border-line bg-surface p-3 space-y-1">
            <span className="text-[10px] uppercase font-bold tracking-wider text-ink-subtle">Total records</span>
            <div className="text-lg font-bold text-ink tabular-nums">{total.toLocaleString()}</div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-3 space-y-1">
            <span className="text-[10px] uppercase font-bold tracking-wider text-ink-subtle">Uploaded/processed</span>
            <div className="text-lg font-bold text-ink tabular-nums">
              {processed.toLocaleString()} / {total.toLocaleString()}
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-3 space-y-1">
            <span className="text-[10px] uppercase font-bold tracking-wider text-ink-subtle">Progress</span>
            <div className="text-lg font-bold text-accent tabular-nums">{formattedPercent}%</div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-3 space-y-1">
            <span className="text-[10px] uppercase font-bold tracking-wider text-success">Successfully imported</span>
            <div className="text-lg font-bold text-success tabular-nums">{successful.toLocaleString()}</div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-3 space-y-1">
            <span className="text-[10px] uppercase font-bold tracking-wider text-warning">Skipped duplicates</span>
            <div className="text-lg font-bold text-warning tabular-nums">{duplicates.toLocaleString()}</div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-3 space-y-1">
            <span className="text-[10px] uppercase font-bold tracking-wider text-danger">Failed rows</span>
            <div className="text-lg font-bold text-danger tabular-nums">{failed.toLocaleString()}</div>
          </div>
        </div>

        {/* Inline Error Sample (if failed rows exist) */}
        {failed > 0 && (
          <div className="rounded-xl border border-line bg-surface overflow-hidden">
            <div className="px-3.5 py-2 border-b border-line bg-surface-2 flex items-center justify-between text-xs">
              <span className="font-semibold text-danger flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5" />
                Error Breakdown ({failed} issue{failed === 1 ? '' : 's'})
              </span>
              <button
                onClick={handleDownloadErrorReport}
                disabled={isDownloadingErrors}
                className="text-[11px] text-accent hover:underline flex items-center gap-1 font-medium disabled:opacity-50"
              >
                <Download className="w-3 h-3" />
                {isDownloadingErrors ? 'Downloading…' : 'Export CSV'}
              </button>
            </div>

            {job?.rowErrors && job.rowErrors.length > 0 ? (
              <div className="max-h-32 overflow-y-auto divide-y divide-line/60 text-[11px]">
                {job.rowErrors.slice(0, 10).map((err, i) => (
                  <div key={i} className="px-3.5 py-1.5 flex items-center justify-between text-ink-muted">
                    <span className="font-mono text-ink">Row {err.row}</span>
                    <span className="text-ink-subtle">{err.field}</span>
                    <span className="text-danger truncate max-w-[200px]" title={err.reason}>
                      {err.reason}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-3 text-center text-xs text-ink-subtle">
                Detailed row failure logs recorded. Click Download Error Report below to view.
              </div>
            )}
          </div>
        )}

        {/* Reliability Guarantee Note */}
        {!isDone && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-surface-2 border border-line text-[11px] text-ink-muted">
            <Clock className="w-3.5 h-3.5 text-accent shrink-0" />
            <span>
              Background processing is active on the server. You can safely navigate away or refresh the page; progress
              will resume automatically.
            </span>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-end gap-2 pt-2 border-t border-line">
          {failed > 0 && (
            <button
              onClick={handleDownloadErrorReport}
              disabled={isDownloadingErrors}
              className="w-full sm:w-auto px-4 py-2 rounded-xl border border-line text-xs font-semibold text-ink hover:bg-surface-2 inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5 text-ink-subtle" />
              {isDownloadingErrors ? 'Downloading Report…' : 'Download Error Report'}
            </button>
          )}

          {isDone ? (
            <>
              {!isCancelled && (
                <button
                  onClick={handleViewCompanies}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl bg-accent hover:bg-accent-strong text-accent-fg text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
                >
                  <Building2 className="w-3.5 h-3.5" />
                  View Imported Companies
                </button>
              )}

              <button
                onClick={onClose}
                className="w-full sm:w-auto px-4 py-2 rounded-xl border border-line text-xs font-semibold text-ink hover:bg-surface-2 inline-flex items-center justify-center transition-colors"
              >
                Close
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowConfirmCancel(true)}
                disabled={isCancellingState}
                className="w-full sm:w-auto px-4 py-2 rounded-xl border border-danger/40 text-xs font-semibold text-danger hover:bg-danger/10 inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
              >
                {isCancellingState ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Cancelling...</span>
                  </>
                ) : (
                  <>
                    <Ban className="w-3.5 h-3.5" />
                    <span>Cancel Import</span>
                  </>
                )}
              </button>

              <button
                onClick={onClose}
                className="w-full sm:w-auto px-4 py-2 rounded-xl border border-line text-xs font-semibold text-ink-muted hover:text-ink hover:bg-surface-2 inline-flex items-center justify-center transition-colors"
              >
                Run in Background
              </button>
            </>
          )}
        </div>
      </div>

      <ConfirmationModal
        isOpen={showConfirmCancel}
        onClose={() => setShowConfirmCancel(false)}
        onConfirm={handleCancelConfirm}
        title="Cancel CSV Import?"
        description="Are you sure you want to cancel this import? Uncommitted records will be discarded and partially imported companies from this run will be safely rolled back. Pre-existing records and other campaigns will not be affected."
        confirmText="Yes, Cancel Import"
        cancelText="Keep Importing"
        isDestructive={true}
        isLoading={isCancelling}
        icon={Ban}
      />
    </div>
  );
}

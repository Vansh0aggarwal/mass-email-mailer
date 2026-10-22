import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  ArrowRight,
  Users,
  ShieldCheck,
  Ban,
  FileSpreadsheet,
  Activity,
  Layers,
  Download,
  Zap,
  Database,
  Clock,
} from 'lucide-react';
import { api, ChunkedUploadProgress } from '../../lib/api';
import { CampaignImportJobProgressData } from '../../types';
import { ConfirmationModal } from '../common/ConfirmationModal';

interface CampaignCreationProgressModalProps {
  jobId: string | null;
  isOpen: boolean;
  onClose?: () => void;
  campaignName: string;
  fallbackTotalRows?: number;
  isUploading?: boolean;
  uploadProgress?: ChunkedUploadProgress | null;
  onCancelUpload?: () => void;
}

export function CampaignCreationProgressModal({
  jobId,
  isOpen,
  onClose,
  campaignName,
  fallbackTotalRows = 0,
  isUploading = false,
  uploadProgress = null,
  onCancelUpload,
}: CampaignCreationProgressModalProps) {
  const navigate = useNavigate();
  const [job, setJob] = useState<CampaignImportJobProgressData | null>(null);
  const [connectionMode, setConnectionMode] = useState<'streaming' | 'polling'>('streaming');
  const [showConfirmCancel, setShowConfirmCancel] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [pollError, setPollError] = useState('');
  const isFetchingRef = useRef<boolean>(false);
  const pollTimerRef = useRef<any>(null);

  // Poll status helper with overlap prevention and 404 handling
  const fetchStatus = async () => {
    if (!jobId || isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const res = await api.get<CampaignImportJobProgressData>(`/campaigns/jobs/${jobId}`);
      if (res) {
        setJob((prev) => ({ ...prev, ...res }));
        setPollError('');
        if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(res.status)) {
          sessionStorage.removeItem('swaniki_active_campaign_creation_job');
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        }
      }
    } catch (err: any) {
      console.warn('Campaign job polling error:', err);
      if (err?.status === 404) {
        setPollError('Import job not found or has expired. Please restart campaign creation.');
        sessionStorage.removeItem('swaniki_active_campaign_creation_job');
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      }
    } finally {
      isFetchingRef.current = false;
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    if (!jobId) {
      // If uploading before job id is minted, keep job state null
      return;
    }

    // Immediately fetch once
    fetchStatus();

    // Persist active job id in sessionStorage
    sessionStorage.setItem('swaniki_active_campaign_creation_job', JSON.stringify({ jobId, campaignName }));

    let eventSource: EventSource | null = null;
    let fallbackInterval: any = null;

    try {
      const token = localStorage.getItem('radar_token');
      const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
      eventSource = new EventSource(`/api/v1/campaigns/jobs/${jobId}/stream${tokenQuery}`);

      eventSource.onopen = () => {
        setConnectionMode('streaming');
        setPollError('');
      };

      eventSource.onmessage = (event) => {
        try {
          const data: CampaignImportJobProgressData = JSON.parse(event.data);
          setJob((prev) => ({ ...prev, ...data }));
          if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(data.status)) {
            sessionStorage.removeItem('swaniki_active_campaign_creation_job');
            eventSource?.close();
            if (fallbackInterval) clearInterval(fallbackInterval);
          }
        } catch (e) {
          console.error('Error parsing campaign SSE data', e);
        }
      };

      eventSource.onerror = () => {
        setConnectionMode('polling');
        eventSource?.close();
        if (!fallbackInterval) {
          fallbackInterval = setInterval(fetchStatus, 800);
          pollTimerRef.current = fallbackInterval;
        }
      };
    } catch {
      setConnectionMode('polling');
      fallbackInterval = setInterval(fetchStatus, 800);
      pollTimerRef.current = fallbackInterval;
    }

    return () => {
      if (eventSource) eventSource.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [isOpen, jobId, campaignName]);

  if (!isOpen) return null;

  const total = job?.totalRows || fallbackTotalRows || 0;
  const processed = job?.processedRows || 0;
  const imported = job?.importedCount || 0;
  const skipped = job?.skippedCount || 0;
  const failed = job?.failedRows || 0;

  let percent = 0;
  if (isUploading && uploadProgress) {
    percent = Math.min(99, Math.round(uploadProgress.percent));
  } else if (job?.percent !== undefined) {
    percent = job.percent;
  } else if (total > 0) {
    percent = Math.min(100, Math.round((processed / total) * 100));
  }

  const isCompleted = job?.status === 'completed' || job?.status === 'completed_with_errors';
  const isFailed = job?.status === 'failed';
  const isCancellingState = job?.status === 'cancellation_requested' || job?.status === 'cancelling' || isCancelling;
  const isCancelled = job?.status === 'cancelled';
  const isProcessing = !isCompleted && !isFailed && !isCancelled && !isCancellingState;
  const isStalled = Boolean(job?.isStalled) && isProcessing;

  const handleCancelClick = () => {
    setShowConfirmCancel(true);
  };

  const handleConfirmCancel = async () => {
    setShowConfirmCancel(false);
    setIsCancelling(true);
    setCancelError('');

    // Phase 1: Upload cancellation
    if (isUploading && onCancelUpload) {
      try {
        onCancelUpload();
        sessionStorage.removeItem('swaniki_active_campaign_creation_job');
        setIsCancelling(false);
        if (onClose) onClose();
        return;
      } catch (err: any) {
        setCancelError(err?.message || 'Failed to cancel upload');
        setIsCancelling(false);
        return;
      }
    }

    // Phase 2-7: Server job cancellation
    if (jobId) {
      try {
        setJob((prev) => (prev ? { ...prev, status: 'cancellation_requested' } : null));
        const res = await api.post<CampaignImportJobProgressData>(`/campaigns/jobs/${jobId}/cancel`);
        if (res) {
          setJob((prev) => ({ ...prev, ...res }));
          if (res.status === 'cancelled') {
            sessionStorage.removeItem('swaniki_active_campaign_creation_job');
          }
        }
      } catch (err: any) {
        console.error('Failed to cancel campaign import job:', err);
        setCancelError(err?.message || 'Failed to cancel import on server');
      } finally {
        setIsCancelling(false);
      }
    } else {
      setIsCancelling(false);
      if (onClose) onClose();
    }
  };

  const handleViewCampaign = () => {
    sessionStorage.removeItem('swaniki_active_campaign_creation_job');
    if (job?.campaignId) {
      navigate(`/campaigns/${job.campaignId}`);
    } else {
      navigate('/campaigns');
    }
  };

  const handleClose = () => {
    sessionStorage.removeItem('swaniki_active_campaign_creation_job');
    if (onClose) onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/50 backdrop-blur-md animate-in fade-in duration-200">
        <div className="ios-card w-full max-w-xl rounded-2xl shadow-2xl border border-line overflow-hidden bg-surface flex flex-col">
          {/* Header */}
          <div className="p-5 border-b border-line bg-surface-2/60 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-brand/10 text-brand">
                <FileSpreadsheet className="w-5 h-5" aria-hidden="true" focusable="false" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                  <span>{campaignName || 'Campaign Import'}</span>
                  <span className="badge badge-neutral text-[10px] uppercase font-mono">
                    {job?.fileName || 'CSV'}
                  </span>
                </h2>
                <p className="text-[11px] text-ink-muted">
                  {isCompleted
                    ? 'All recipients imported and campaign created'
                    : isFailed
                    ? 'Campaign creation stopped with error'
                    : isCancelled
                    ? 'Import cancelled and rolled back'
                    : isCancellingState
                    ? 'Cancelling import and rolling back uncommitted data...'
                    : isUploading
                    ? 'Uploading recipient file to server...'
                    : 'Importing recipients and materializing campaign structure'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Live stream or live polling badge */}
              <span
                className={`badge text-[9px] uppercase font-mono flex items-center gap-1 ${
                  connectionMode === 'streaming' ? 'badge-success' : 'badge-neutral'
                }`}
                title={
                  connectionMode === 'streaming'
                    ? 'Real-time Server-Sent Events stream active'
                    : 'Polling backend status'
                }
              >
                <Activity className="w-2.5 h-2.5" aria-hidden="true" focusable="false" />
                <span>{connectionMode === 'streaming' ? 'Live Stream' : 'Live Polling'}</span>
              </span>

              {/* Header-level quick cancel button when import is active */}
              {(isProcessing || isUploading) && (
                <button
                  type="button"
                  onClick={handleCancelClick}
                  disabled={isCancellingState}
                  className="ios-btn-secondary px-2.5 py-1 text-[11px] font-semibold text-danger border-danger/30 hover:bg-danger/10 disabled:opacity-50 inline-flex items-center gap-1"
                  title="Cancel import and roll back campaign recipients"
                >
                  <Ban className="w-3 h-3" />
                  <span>Cancel</span>
                </button>
              )}
            </div>
          </div>

          {/* Body Content */}
          <div className="p-6 space-y-6">
            {/* Stall warning banner if backend worker stops reporting */}
            {isStalled && (
              <div className="p-3.5 rounded-xl border border-warning/40 bg-warning/10 text-xs flex items-start justify-between gap-3 animate-in fade-in">
                <div className="flex items-start gap-2.5 text-warning-ink">
                  <Clock className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                  <div>
                    <strong className="block text-ink font-semibold">Import Activity Stalled</strong>
                    <p className="text-ink-muted mt-0.5 leading-relaxed">
                      The backend worker hasn't updated progress in {job?.stallSeconds ?? 45} seconds. Network latency or background processing may be delayed.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancelClick}
                  className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold text-danger border-danger/40 hover:bg-danger/15 flex-shrink-0"
                >
                  Cancel Import
                </button>
              </div>
            )}

            {/* Polling error notice */}
            {pollError && (
              <div className="p-3 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{pollError}</span>
                </div>
                <button
                  type="button"
                  onClick={handleClose}
                  className="ios-btn-secondary px-2.5 py-1 text-[11px] font-semibold text-danger border-danger/40 hover:bg-danger/15"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Cancel error notice */}
            {cancelError && (
              <div className="p-3 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>{cancelError}</span>
              </div>
            )}

            {/* Main Status Callout */}
            <div className="text-center space-y-2 py-2">
              {/* 1. Normal processing state */}
              {isProcessing && !isCancellingState && (
                <div className="space-y-3">
                  <div className="inline-flex p-3 rounded-2xl bg-brand/10 text-brand">
                    <Loader2 className="w-8 h-8 animate-spin" aria-hidden="true" focusable="false" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-ink">
                      {isUploading
                        ? 'Uploading recipient file...'
                        : processed > 0
                        ? `Loading recipient ${processed} of ${total}`
                        : job?.message || 'Preparing campaign...'}
                    </h3>
                    {job?.currentRecipientEmail && (
                      <p className="text-xs text-ink-muted mt-1 font-mono">
                        <span>{job.currentRecipientEmail}</span>
                        {job.currentCompanyName && (
                          <span className="font-sans text-ink-subtle"> • {job.currentCompanyName}</span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* 2. Cancellation in progress */}
              {isCancellingState && !isCancelled && (
                <div className="space-y-3">
                  <div className="inline-flex p-3 rounded-2xl bg-warning/15 text-warning">
                    <Loader2 className="w-8 h-8 animate-spin" aria-hidden="true" focusable="false" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-ink">Cancelling Import...</h3>
                    <p className="text-xs text-ink-muted mt-1">
                      Stopping background processing and rolling back uncommitted campaign recipients.
                    </p>
                  </div>
                </div>
              )}

              {/* 3. Fully cancelled */}
              {isCancelled && (
                <div className="space-y-3">
                  <div className="inline-flex p-3 rounded-2xl bg-neutral/15 text-ink-muted">
                    <Ban className="w-8 h-8 text-danger" aria-hidden="true" focusable="false" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-ink">Import Cancelled</h3>
                    <p className="text-xs text-ink-muted mt-1">
                      {job?.errorMessage || 'The import was cancelled. Partial recipients were removed and no emails will be sent.'}
                    </p>
                  </div>
                </div>
              )}

              {/* 4. Completed successfully */}
              {isCompleted && (
                <div className="space-y-3">
                  <div className="inline-flex p-3 rounded-2xl bg-success/15 text-success">
                    <CheckCircle2 className="w-8 h-8" aria-hidden="true" focusable="false" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-ink">Campaign Created Successfully</h3>
                    <p className="text-xs text-ink-muted mt-1">
                      All recipient data has been processed and linked to CRM entities.
                    </p>
                  </div>
                </div>
              )}

              {/* 5. Failed */}
              {isFailed && (
                <div className="space-y-3">
                  <div className="inline-flex p-3 rounded-2xl bg-danger/15 text-danger">
                    <XCircle className="w-8 h-8" aria-hidden="true" focusable="false" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-danger">Campaign Creation Failed</h3>
                    <p className="text-xs text-ink-muted mt-1">
                      {job?.errorMessage || 'An error occurred during CSV parsing or recipient creation.'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Progress Bar & Percentage */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold">
                <div className="flex items-center gap-2">
                  <span className="text-ink-muted">Overall Import Progress</span>
                  {job?.throughputRowsPerSecond !== undefined && job.throughputRowsPerSecond > 0 && isProcessing && (
                    <span className="badge badge-neutral text-[10px] font-mono flex items-center gap-1 text-accent">
                      <Zap className="w-2.5 h-2.5" />
                      <span>{job.throughputRowsPerSecond} rows/s</span>
                    </span>
                  )}
                  {job?.estimatedTimeRemainingSeconds !== undefined && job.estimatedTimeRemainingSeconds > 0 && isProcessing && (
                    <span className="text-[11px] text-ink-subtle font-mono">
                      ETA ~{job.estimatedTimeRemainingSeconds}s
                    </span>
                  )}
                </div>
                <span className="text-brand tabular-nums font-mono text-sm">{percent}%</span>
              </div>
              <div className="w-full h-3 bg-surface-2 rounded-full overflow-hidden p-0.5 border border-line">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    isCompleted
                      ? 'bg-success'
                      : isFailed
                      ? 'bg-danger'
                      : isCancelled
                      ? 'bg-ink-muted'
                      : isCancellingState
                      ? 'bg-warning'
                      : 'bg-brand'
                  }`}
                  style={{ width: `${Math.max(4, Math.min(100, percent))}%` }}
                />
              </div>
            </div>

            {/* 4-Stat Metric Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
              {/* Total Records */}
              <div className="p-3 rounded-xl border border-line bg-surface-2/40">
                <div className="text-[10px] uppercase font-semibold text-ink-subtle flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Layers className="w-3 h-3" aria-hidden="true" focusable="false" />
                    <span>Total</span>
                  </div>
                  {job?.totalRowsIsExact === false && (
                    <span className="badge badge-neutral text-[8px] uppercase">Est.</span>
                  )}
                </div>
                <div className="text-base font-bold text-ink mt-1 tabular-nums">
                  {total > 0 ? total.toLocaleString() : isProcessing ? 'Analyzing...' : '0'}
                  {job?.totalRowsIsExact === false && total > 0 && (
                    <span className="text-xs font-normal text-ink-muted"> ~</span>
                  )}
                </div>
                <div className="text-[10px] text-ink-muted mt-0.5">Records in file</div>
              </div>

              {/* Processed & Committed */}
              <div className="p-3 rounded-xl border border-line bg-surface-2/40">
                <div className="text-[10px] uppercase font-semibold text-brand flex items-center gap-1">
                  <Users className="w-3 h-3" aria-hidden="true" focusable="false" />
                  <span>Processed</span>
                </div>
                <div className="text-base font-bold text-brand mt-1 tabular-nums">
                  {processed.toLocaleString()}
                </div>
                <div className="text-[10px] text-ink-muted mt-0.5 flex items-center gap-1">
                  <Database className="w-2.5 h-2.5 text-accent" />
                  <span>{(job?.committedRows ?? imported).toLocaleString()} committed</span>
                </div>
              </div>

              {/* Successfully Imported */}
              <div className="p-3 rounded-xl border border-success/30 bg-success/5">
                <div className="text-[10px] uppercase font-semibold text-success flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" aria-hidden="true" focusable="false" />
                  <span>Imported</span>
                </div>
                <div className="text-base font-bold text-success mt-1 tabular-nums">
                  {imported.toLocaleString()}
                </div>
                <div className="text-[10px] text-ink-muted mt-0.5">Eligible recipients</div>
              </div>

              {/* Skipped */}
              <div className="p-3 rounded-xl border border-warning/30 bg-warning/5">
                <div className="text-[10px] uppercase font-semibold text-warning flex items-center gap-1">
                  <Ban className="w-3 h-3" aria-hidden="true" focusable="false" />
                  <span>Skipped</span>
                </div>
                <div className="text-base font-bold text-warning mt-1 tabular-nums">
                  {skipped.toLocaleString()}
                </div>
                <div className="text-[10px] text-ink-muted mt-0.5">Duplicates / missing</div>
              </div>
            </div>

            {/* Failed count notice and error report download */}
            {(failed > 0 || job?.hasErrorReport) && (
              <div className="p-3 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" focusable="false" />
                  <span>
                    <strong>{failed.toLocaleString()} record(s)</strong> flagged with errors or skipped. Eligible records were saved.
                  </span>
                </div>
                {jobId && (
                  <a
                    href={`/api/v1/campaigns/jobs/${jobId}/errors`}
                    download
                    className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold flex items-center gap-1.5 text-danger border-danger/40 hover:bg-danger/15 flex-shrink-0"
                  >
                    <Download className="w-3 h-3" />
                    <span>Download Error Report (.csv)</span>
                  </a>
                )}
              </div>
            )}

            {/* Non-sending guarantee banner */}
            <div className="text-[11px] text-ink-subtle bg-surface-2/60 p-3 rounded-xl border border-line/60 flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-brand flex-shrink-0 mt-0.5" aria-hidden="true" focusable="false" />
              <p className="leading-relaxed">
                <strong>Zero-Dispatch Guarantee:</strong> No emails are sent during campaign creation. Recipient drafts remain in review mode until individually approved and dispatched according to your campaign schedule.
              </p>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="p-5 border-t border-line bg-surface-2/40 flex items-center justify-between gap-3">
            <div className="text-xs text-ink-muted font-mono">
              {isProcessing && <span>Processing in safe batches…</span>}
              {isCancellingState && <span className="text-warning font-semibold">Cancelling import...</span>}
              {isCancelled && <span className="text-ink-muted font-semibold">Import cancelled</span>}
              {isCompleted && <span className="text-success font-semibold">Ready for review</span>}
              {isFailed && <span className="text-danger font-semibold">Import halted</span>}
            </div>

            <div className="flex items-center gap-2">
              {/* Prominent Cancel Button while import is active */}
              {(isProcessing || isUploading || isCancellingState) && (
                <button
                  type="button"
                  onClick={handleCancelClick}
                  disabled={isCancellingState}
                  className="ios-btn-secondary px-4 py-2 text-xs font-semibold text-danger border-danger/40 hover:bg-danger/10 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isCancellingState ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Cancelling import...</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      <span>Cancel Import</span>
                    </>
                  )}
                </button>
              )}

              {/* Close button when failed or cancelled */}
              {(isFailed || isCancelled) && (
                <button
                  type="button"
                  onClick={handleClose}
                  className="ios-btn-secondary px-4 py-2 text-xs font-semibold"
                >
                  Close
                </button>
              )}

              {/* View Campaign button when completed */}
              {isCompleted && (
                <button
                  type="button"
                  onClick={handleViewCampaign}
                  className="ios-btn-primary px-5 py-2 text-xs font-semibold inline-flex items-center gap-2 shadow-sm"
                >
                  <span>View Campaign</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" focusable="false" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Modal before cancellation */}
      <ConfirmationModal
        isOpen={showConfirmCancel}
        onClose={() => setShowConfirmCancel(false)}
        onConfirm={handleConfirmCancel}
        title="Cancel Campaign Import?"
        description="Are you sure you want to cancel this campaign import? All uncommitted recipient records will be discarded, and partial campaign data will be cleanly rolled back. Shared company and contact records from other campaigns will not be affected. No emails will be sent."
        confirmText="Yes, Cancel Import"
        cancelText="Keep Importing"
        isDestructive={true}
        isLoading={isCancelling}
        icon={Ban}
      />
    </>
  );
}
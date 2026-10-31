import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Gauge,
  Layers,
  Loader2,
  PauseCircle,
  ShieldCheck,
  Upload,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import { api, ChunkedUploadProgress } from '../lib/api';
import { EmailAccount, SenderAccount, WorkspaceSettings } from '../types';
import {
  FIXED_FIELD_DEFS,
  guessColumnMapping,
  normalizeTokenKey,
} from '../lib/campaign';
import {
  CampaignSplitJob,
  SPLIT_PRESETS,
  SplitUploadResult,
  buildChildCampaignName,
  computeSplitPlan,
  DEFAULT_SPLIT_PATTERN,
  describeCampaignRange,
  formatDurationSeconds,
  isSplitJobActive,
} from '../lib/campaign-split';
import { mailKeys } from '../lib/mail';
import { ConfirmationModal } from '../components/common/ConfirmationModal';

type Phase = 'upload' | 'setup' | 'analysis' | 'configure' | 'generation';

interface StepForm {
  subject: string;
  bodyText: string;
  delayDays: number;
}

const SESSION_KEY = 'swaniki_active_split_job';
const STAGES: { key: Phase; label: string }[] = [
  { key: 'upload', label: 'Upload file' },
  { key: 'analysis', label: 'Process contacts' },
  { key: 'generation', label: 'Create campaigns' },
];

function stageIndex(phase: Phase): number {
  if (phase === 'upload' || phase === 'setup') return 0;
  if (phase === 'analysis' || phase === 'configure') return 1;
  return 2;
}

function buildCustomFieldMapping(
  headers: string[],
  mapping: Record<string, string>
): Record<string, string> {
  const usedHeaders = new Set(Object.values(mapping).filter(Boolean));
  const usedTokens = new Set(Object.keys(mapping));
  const result: Record<string, string> = {};
  for (const header of headers) {
    if (usedHeaders.has(header)) continue;
    const key = normalizeTokenKey(header);
    if (!key || usedTokens.has(key)) continue;
    result[header] = key;
    usedTokens.add(key);
  }
  return result;
}

export function CampaignSplitNewPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [phase, setPhase] = useState<Phase>('upload');
  const [jobId, setJobId] = useState<string | null>(null);
  const [upload, setUpload] = useState<SplitUploadResult | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ChunkedUploadProgress | null>(null);
  const [fileName, setFileName] = useState('');
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [groupName, setGroupName] = useState('');
  const [pattern, setPattern] = useState(DEFAULT_SPLIT_PATTERN);
  const [contactsPerCampaign, setContactsPerCampaign] = useState(100);
  const [customContactsPerCampaign, setCustomContactsPerCampaign] = useState('100');

  const [mailboxId, setMailboxId] = useState('');
  const [senderAccountIds, setSenderAccountIds] = useState<string[]>([]);
  const [generationMode, setGenerationMode] = useState<'template' | 'ai'>('template');
  const [targetService, setTargetService] = useState('');
  const [steps, setSteps] = useState<StepForm[]>([{ subject: '', bodyText: '', delayDays: 0 }]);
  const [error, setError] = useState('');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [pausedUpload, setPausedUpload] = useState<{ file: File; uploadId: string | null } | null>(null);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const pauseRequestedRef = useRef(false);
  const restoreStageRef = useRef(false);

  const { data: mailboxes = [] } = useQuery<EmailAccount[]>({
    queryKey: mailKeys.mailboxes,
    queryFn: () => api.get<EmailAccount[]>('/mailboxes'),
  });

  const { data: senderAccounts = [] } = useQuery<SenderAccount[]>({
    queryKey: ['campaign-sender-accounts'],
    queryFn: () => api.get<SenderAccount[]>('/campaigns/sender-accounts'),
  });

  const { data: senderSettings } = useQuery<WorkspaceSettings>({
    queryKey: ['workspace-settings-sender'],
    queryFn: () => api.get<WorkspaceSettings>('/settings/sender'),
  });

  const jobQuery = useQuery<CampaignSplitJob>({
    queryKey: ['campaign-split-job', jobId],
    queryFn: () => api.get<CampaignSplitJob>(`/campaign-splits/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && isSplitJobActive(status) ? 1200 : false;
    },
  });
  const job = jobQuery.data ?? null;

  // `?new=1` (from the list/detail page) explicitly starts a fresh import;
  // otherwise an in-flight job survives refreshes and return visits.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      sessionStorage.removeItem(SESSION_KEY);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
      return;
    }
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (parsed?.jobId) {
        restoreStageRef.current = true;
        setJobId(parsed.jobId);
      }
    } catch {
      /* ignore corrupt session state */
    }
    // Runs once on mount: the query flag is consumed and removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (jobId) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ jobId }));
  }, [jobId]);

  useEffect(() => {
    if (senderSettings?.authorizedMailbox && !mailboxId) {
      setMailboxId(senderSettings.authorizedMailbox);
    } else if (!mailboxId && mailboxes.length) {
      setMailboxId(mailboxes[0].emailAddress);
    }
    if (senderSettings?.defaultServiceOffering && !targetService) {
      setTargetService(senderSettings.defaultServiceOffering);
    }
  }, [senderSettings, mailboxes, mailboxId, targetService]);

  // Keep the wizard aligned with the job's real backend state.
  useEffect(() => {
    if (!job) return;

    // Returning to the page (refresh, nav away) must land on the stage the job
    // is actually in, not restart at the upload screen.
    if (restoreStageRef.current) {
      restoreStageRef.current = false;
      if (job.status === 'ready') {
        setContactsPerCampaign(job.contactsPerCampaign || 100);
        setCustomContactsPerCampaign(String(job.contactsPerCampaign || 100));
        setGroupName(job.groupName || '');
        setPattern(job.campaignNamePattern || DEFAULT_SPLIT_PATTERN);
        setPhase('configure');
        return;
      }
      if (job.status === 'queued' || job.status === 'analyzing' || job.status === 'failed' || job.status === 'cancelled') {
        setPhase(job.phase === 'generation' ? 'generation' : 'analysis');
        return;
      }
      setPhase('generation');
      if (job.status === 'completed' || job.status === 'completed_with_errors') {
        sessionStorage.removeItem(SESSION_KEY);
      }
      return;
    }

    if (job.status === 'ready') {
      if (phase === 'analysis') {
        setContactsPerCampaign(job.contactsPerCampaign || 100);
        setCustomContactsPerCampaign(String(job.contactsPerCampaign || 100));
        setGroupName(job.groupName || '');
        setPattern(job.campaignNamePattern || DEFAULT_SPLIT_PATTERN);
        setPhase('configure');
      }
      return;
    }
    if (job.status === 'queued' || job.status === 'analyzing') {
      if (phase === 'upload' || phase === 'setup') setPhase('analysis');
      return;
    }
    if (job.phase === 'analysis' && job.status === 'failed') {
      setPhase('analysis');
      return;
    }
    if (job.status === 'generating' || job.status === 'cancellation_requested') {
      setPhase('generation');
      return;
    }
    if (job.status === 'completed' || job.status === 'completed_with_errors' || job.status === 'cancelled') {
      setPhase('generation');
      if (job.status !== 'cancelled') sessionStorage.removeItem(SESSION_KEY);
    }
  }, [job, phase]);

  const customFieldMapping = useMemo(
    () => (upload ? buildCustomFieldMapping(upload.headers, columnMapping) : {}),
    [upload, columnMapping]
  );

  const analysis = job?.progress.analysis;
  const splitPreview = useMemo(() => {
    const valid = job?.progress.analysis.validContacts || 0;
    const cpc = Math.max(1, Number(contactsPerCampaign) || 1);
    return computeSplitPlan(valid, cpc);
  }, [job?.progress.analysis.validContacts, contactsPerCampaign]);

  const namePreviews = useMemo(() => {
    const plan = job?.progress.split;
    return [1, 2, 3].map((number) =>
      buildChildCampaignName(pattern || DEFAULT_SPLIT_PATTERN, groupName || 'Group', number, plan?.expectedCampaigns || 1)
    );
  }, [pattern, groupName, job?.progress.split]);

  const toggleSenderAccount = (account: SenderAccount) => {
    setSenderAccountIds((current) => {
      const next = current.includes(account.accountId)
        ? current.filter((id) => id !== account.accountId)
        : [...current, account.accountId];
      const primary = next
        .map((id) => senderAccounts.find((a) => a.accountId === id))
        .find((a): a is SenderAccount => Boolean(a));
      if (primary) setMailboxId(primary.emailAddress);
      return next;
    });
  };

  const startUpload = async (file: File, resumeUploadId?: string) => {
    setError('');
    setUploadProgress(null);
    setPausedUpload(null);
    setIsUploading(true);
    setFileName(file.name);
    pauseRequestedRef.current = false;
    const controller = new AbortController();
    uploadAbortControllerRef.current = controller;
    let sessionId: string | null = resumeUploadId ?? null;
    try {
      const res = await api.uploadChunked(file, {
        basePath: '/campaign-splits',
        signal: controller.signal,
        onProgress: setUploadProgress,
        resumeUploadId,
        // A pause keeps the server-side chunks so the same file can resume.
        abortMode: 'pause',
        onSession: (id) => {
          sessionId = id;
        },
      });
      setUpload(res as SplitUploadResult);
      setFileName(res.fileName || file.name);
      const guessed = guessColumnMapping(res.headers);
      setColumnMapping(guessed);
      setGroupName(res.fileName.replace(/\.(csv|xlsx|xls|txt)$/i, '').slice(0, 120));
      setPhase('setup');
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        if (pauseRequestedRef.current) {
          setPausedUpload({ file, uploadId: sessionId });
          setError('');
        } else {
          setError('Upload cancelled.');
        }
      } else {
        setError(err?.message || 'Failed to upload and inspect the file.');
      }
    } finally {
      setIsUploading(false);
      uploadAbortControllerRef.current = null;
      pauseRequestedRef.current = false;
    }
  };

  const pauseUpload = () => {
    pauseRequestedRef.current = true;
    uploadAbortControllerRef.current?.abort();
  };

  const discardPausedUpload = async () => {
    if (pausedUpload?.uploadId) {
      await api.delete(`/campaign-splits/upload/${pausedUpload.uploadId}`).catch(() => {});
    }
    setPausedUpload(null);
    setUploadProgress(null);
  };

  const createMutation = useMutation({
    mutationFn: () => {
      if (!upload) throw new Error('Upload a file first.');
      return api.post<CampaignSplitJob>('/campaign-splits', {
        uploadId: upload.uploadId,
        fileName: upload.fileName,
        groupName: groupName.trim(),
        campaignNamePattern: pattern.trim(),
        contactsPerCampaign: Math.max(1, Number(contactsPerCampaign) || 100),
        mailboxId,
        ...(senderAccountIds.length > 1 ? { senderAccountIds } : {}),
        generationMode,
        ...(generationMode === 'ai' && targetService.trim() ? { targetService: targetService.trim() } : {}),
        steps,
        columnMapping,
        customFieldMapping,
        scaleType: 'standard',
      });
    },
    onSuccess: (created) => {
      setJobId(created.id);
      setPhase('analysis');
    },
    onError: (err: any) => setError(err?.message || 'Failed to analyze the file.'),
  });

  const planMutation = useMutation({
    mutationFn: async () => {
      if (!jobId) throw new Error('Missing import job.');
      await api.post(`/campaign-splits/${jobId}/plan`, {
        contactsPerCampaign: Math.max(1, Number(contactsPerCampaign) || 1),
        groupName: groupName.trim(),
        campaignNamePattern: pattern.trim(),
      });
      return api.post<CampaignSplitJob>(`/campaign-splits/${jobId}/generate`);
    },
    onSuccess: () => {
      setPhase('generation');
      jobQuery.refetch();
    },
    onError: (err: any) => setError(err?.message || 'Failed to start campaign generation.'),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.post<CampaignSplitJob>(`/campaign-splits/${jobId}/cancel`),
    onSuccess: () => {
      setShowCancelConfirm(false);
      jobQuery.refetch();
    },
    onError: (err: any) => {
      setShowCancelConfirm(false);
      setError(err?.message || 'Failed to cancel the import.');
    },
  });

  const retryMutation = useMutation({
    mutationFn: () => api.post<CampaignSplitJob>(`/campaign-splits/${jobId}/retry`),
    onSuccess: () => jobQuery.refetch(),
    onError: (err: any) => setError(err?.message || 'Failed to retry the import.'),
  });

  const canSetup =
    !!upload &&
    !!columnMapping.company_name &&
    !!columnMapping.contact_email &&
    !!groupName.trim() &&
    !!mailboxId &&
    steps.every((s) => s.subject.trim() && s.bodyText.trim());

  const planPreview = useMemo(() => {
    const expected = splitPreview.expectedCampaigns;
    const numbers =
      expected === 0
        ? []
        : expected <= 8
          ? Array.from({ length: expected }, (_, i) => i + 1)
          : [1, 2, 3, 4, 5, expected - 1, expected];
    const rows = numbers.map((number) => ({
      number,
      name: buildChildCampaignName(pattern || DEFAULT_SPLIT_PATTERN, groupName || 'Group', number, expected),
      size: number === expected ? splitPreview.lastCampaignContacts : splitPreview.contactsPerCampaign,
      range: describeCampaignRange(
        number,
        splitPreview.contactsPerCampaign,
        splitPreview.lastCampaignContacts,
        expected
      ),
    }));
    return {
      expected,
      head: rows.slice(0, 5),
      tail: rows.slice(5),
      hidden: Math.max(0, expected - numbers.length),
    };
  }, [splitPreview, pattern, groupName]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <Link
          to="/campaigns/splits"
          className="text-xs text-ink-muted hover:text-ink inline-flex items-center gap-1.5 mb-3"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to split imports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-ink flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-accent-fg shadow-sm">
            <Layers className="w-4 h-4" />
          </span>
          Smart campaign splitter
        </h1>
        <p className="text-xs text-ink-muted mt-1">
          Upload one prospect file, validate every contact, then generate a batch of child campaigns — each one created as a draft for review.
        </p>
      </div>

      <div className="ios-card rounded-xl p-5">
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          {STAGES.map((stage, index) => {
            const active = stageIndex(phase) === index;
            const done = stageIndex(phase) > index;
            return (
              <div
                key={stage.key}
                className={`rounded-lg px-3 py-2 font-semibold ${
                  active
                    ? 'bg-accent/10 text-accent border border-accent/25'
                    : done
                      ? 'bg-success/10 text-success'
                      : 'bg-surface-2 text-ink-subtle'
                }`}
              >
                {index + 1}. {stage.label}
              </div>
            );
          })}
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

      {phase === 'upload' && (
        <div className="ios-card rounded-xl p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-xl bg-accent/10 border border-accent/30 text-accent flex items-center justify-center mx-auto">
            <FileSpreadsheet className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">Select the master prospect file</h3>
            <p className="text-xs text-ink-muted mt-1">
              CSV, XLSX, or XLS. Large files stream in resumable chunks — the full sheet is never held in browser or Node memory.
            </p>
          </div>
          <input
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xls,application/vnd.ms-excel"
            id="split-file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && startUpload(e.target.files[0])}
          />
          <label
            htmlFor="split-file"
            className="inline-flex items-center gap-2 px-5 py-2.5 ios-btn-primary text-xs font-semibold cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            {isUploading ? 'Streaming file upload…' : fileName || 'Choose CSV or Excel file'}
          </label>

          {isUploading && uploadProgress && (
            <div className="w-full max-w-md mx-auto p-4 rounded-xl border border-line bg-surface-2/60 text-left space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-ink flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-accent animate-pulse" />
                  Uploading bytes
                </span>
                <span className="font-mono text-accent font-semibold">{uploadProgress.percent}%</span>
              </div>
              <div className="w-full h-2 bg-surface rounded-full overflow-hidden border border-line">
                <div
                  className="h-full bg-accent transition-all duration-200"
                  style={{ width: `${Math.max(2, Math.min(100, uploadProgress.percent))}%` }}
                />
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px] text-ink-muted">
                <div>
                  <span className="text-ink-subtle block">Size:</span>
                  <span className="font-mono text-ink">
                    {(uploadProgress.uploadedBytes / 1024 / 1024).toFixed(1)} / {(uploadProgress.totalBytes / 1024 / 1024).toFixed(1)} MB
                  </span>
                </div>
                <div>
                  <span className="text-ink-subtle block">Speed:</span>
                  <span className="font-mono text-ink">
                    {(uploadProgress.uploadSpeedBytesPerSecond / 1024 / 1024).toFixed(2)} MB/s
                  </span>
                </div>
                <div>
                  <span className="text-ink-subtle block">ETA:</span>
                  <span className="font-mono text-ink">
                    {uploadProgress.estimatedRemainingSeconds > 0
                      ? `~${uploadProgress.estimatedRemainingSeconds}s`
                      : 'finalizing…'}
                  </span>
                </div>
              </div>
              <div className="text-[10px] text-ink-subtle text-center pt-1 border-t border-line/60">
                Chunk {uploadProgress.currentChunk} of {uploadProgress.totalChunks} · failed chunks retry automatically
              </div>
              {uploadProgress.totalChunks > 1 && (
                <div className="text-center">
                  <button
                    onClick={pauseUpload}
                    className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5"
                  >
                    <PauseCircle className="w-3 h-3" />
                    Pause upload
                  </button>
                </div>
              )}
            </div>
          )}

          {pausedUpload && !isUploading && (
            <div className="w-full max-w-md mx-auto p-4 rounded-xl border border-warning/40 bg-warning/10 text-left space-y-3">
              <div className="text-xs font-semibold text-ink flex items-center gap-1.5">
                <PauseCircle className="w-3.5 h-3.5 text-warning" />
                Upload paused
              </div>
              <p className="text-[11px] text-ink-muted">
                {pausedUpload.uploadId
                  ? 'Received chunks are kept on the server. Resume to continue from where you stopped.'
                  : 'The upload stopped before the server session was created. Resume to start again.'}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => startUpload(pausedUpload.file, pausedUpload.uploadId ?? undefined)}
                  className="ios-btn-primary px-3 py-1.5 text-[11px] font-semibold"
                >
                  Resume upload
                </button>
                <button
                  onClick={discardPausedUpload}
                  className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold text-danger border-danger/30 hover:bg-danger/10"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          {isUploading && !uploadProgress && (
            <div className="text-xs text-ink-muted flex items-center justify-center gap-1.5">
              <Gauge className="w-3.5 h-3.5 animate-spin text-accent" />
              <span>Inspecting headers and sample rows…</span>
            </div>
          )}
        </div>
      )}

      {phase === 'setup' && upload && (
        <div className="space-y-5">
          <div className="ios-card rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-ink">Campaign setup</div>
              <div className="text-[11px] text-ink-muted font-mono">
                {fileName} · {upload.totalRowsIsExact === false ? `~${upload.totalRows.toLocaleString()}` : upload.totalRows.toLocaleString()} rows · {upload.headers.length} columns
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Parent group name</label>
                <input
                  className="input px-3 py-2 text-xs"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="e.g. October Prospect Import"
                />
                <p className="text-[11px] text-ink-subtle mt-1">Every child campaign belongs to this import group.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Sending mailbox</label>
                <select className="input px-3 py-2 text-xs" value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
                  <option value="">— select a mailbox —</option>
                  {mailboxes.map((m) => (
                    <option key={m._id} value={m.emailAddress}>
                      {m.emailAddress} ({m.provider})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Contacts per campaign</label>
                <select
                  className="input px-3 py-2 text-xs"
                  value={SPLIT_PRESETS.includes(contactsPerCampaign as any) ? String(contactsPerCampaign) : 'custom'}
                  onChange={(e) => {
                    if (e.target.value === 'custom') return;
                    const value = Number(e.target.value);
                    setContactsPerCampaign(value);
                    setCustomContactsPerCampaign(String(value));
                  }}
                >
                  {SPLIT_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset.toLocaleString()} contacts
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  className="input px-3 py-2 text-xs mt-2 tabular-nums"
                  value={customContactsPerCampaign}
                  onChange={(e) => {
                    setCustomContactsPerCampaign(e.target.value);
                    const value = Number(e.target.value);
                    if (Number.isFinite(value) && value >= 1) setContactsPerCampaign(Math.floor(value));
                  }}
                  placeholder="Custom batch size"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Draft generation</label>
                <select
                  className="input px-3 py-2 text-xs"
                  value={generationMode}
                  onChange={(e) => setGenerationMode(e.target.value as 'template' | 'ai')}
                >
                  <option value="template">Deterministic template ({'{{token}}'} merge)</option>
                  <option value="ai">AI-personalized (per company)</option>
                </select>
                {generationMode === 'ai' && (
                  <input
                    className="input px-3 py-2 text-xs mt-2"
                    value={targetService}
                    onChange={(e) => setTargetService(e.target.value)}
                    placeholder="Target service / theme"
                  />
                )}
              </div>
            </div>

            {senderAccounts.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Sender accounts (optional multi-mailbox drip)</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {senderAccounts.map((account) => {
                    const selected = senderAccountIds.includes(account.accountId);
                    return (
                      <label
                        key={account.accountId}
                        className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs transition ${
                          !account.authorized
                            ? 'border-line/60 bg-surface-2/40 opacity-60 cursor-not-allowed'
                            : selected
                              ? 'border-accent/40 bg-accent/5 cursor-pointer'
                              : 'border-line bg-surface-2 hover:border-accent/30 cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selected}
                          disabled={!account.authorized}
                          onChange={() => toggleSenderAccount(account)}
                        />
                        <span className="min-w-0">
                          <span className="block font-medium text-ink truncate">{account.emailAddress}</span>
                          <span className="block text-[11px] text-ink-subtle">
                            {account.authorized
                              ? `${account.remainingDailyAllowance} of ${account.dailySendLimit} sends left today`
                              : account.authorization?.reason || 'Not authorized to send'}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="ios-card rounded-xl p-5">
            <div className="text-sm font-semibold text-ink mb-4">Map columns</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {FIXED_FIELD_DEFS.map((def) => (
                <div key={def.key}>
                  <label className="block text-xs font-medium text-ink-muted mb-1.5">
                    {def.label}
                    {def.required && <span className="text-danger"> *</span>}
                  </label>
                  <select
                    className="input px-3 py-2 text-xs"
                    value={columnMapping[def.key] || ''}
                    onChange={(e) => setColumnMapping((m) => ({ ...m, [def.key]: e.target.value }))}
                  >
                    <option value="">— not mapped —</option>
                    {upload.headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            {Object.keys(customFieldMapping).length > 0 && (
              <p className="text-[11px] text-ink-subtle mt-4 border-t border-line pt-3">
                {Object.keys(customFieldMapping).length} extra column(s) will be preserved as custom fields and can be merged with{' '}
                <span className="font-mono">{'{{token}}'}</span>.
              </p>
            )}
          </div>

          <div className="space-y-3">
            {steps.map((step, i) => (
              <div key={i} className="ios-card rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink">
                    Step {i + 1}
                    {i > 0 ? ' (follow-up)' : ''}
                  </span>
                  {steps.length > 1 && (
                    <button
                      onClick={() => setSteps((s) => s.filter((_, idx) => idx !== i))}
                      className="text-[11px] text-danger hover:text-danger/80"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  className="input px-3 py-2 text-xs"
                  placeholder="Subject — supports {{company_name}}"
                  value={step.subject}
                  onChange={(e) =>
                    setSteps((s) => s.map((x, idx) => (idx === i ? { ...x, subject: e.target.value } : x)))
                  }
                />
                <textarea
                  className="input px-3 py-2 text-xs min-h-[120px]"
                  placeholder="Body — use {{tokens}} from your mapped columns"
                  value={step.bodyText}
                  onChange={(e) =>
                    setSteps((s) => s.map((x, idx) => (idx === i ? { ...x, bodyText: e.target.value } : x)))
                  }
                />
                {i > 0 && (
                  <div className="flex items-center gap-2 text-[11px] text-ink-muted">
                    Wait
                    <input
                      type="number"
                      min={0}
                      className="input px-2 py-1 w-20 tabular-nums"
                      value={step.delayDays}
                      onChange={(e) =>
                        setSteps((s) =>
                          s.map((x, idx) => (idx === i ? { ...x, delayDays: Number(e.target.value) } : x))
                        )
                      }
                    />
                    day(s) after the previous step
                  </div>
                )}
              </div>
            ))}
            <button
              onClick={() => setSteps((s) => [...s, { subject: '', bodyText: '', delayDays: 3 }])}
              className="ios-btn-secondary px-4 py-2 text-xs font-semibold"
            >
              Add follow-up step
            </button>
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                setUpload(null);
                setPhase('upload');
              }}
              className="ios-btn-secondary px-4 py-2 text-xs font-semibold"
            >
              Back
            </button>
            <button
              disabled={!canSetup || createMutation.isPending}
              onClick={() => {
                setError('');
                createMutation.mutate();
              }}
              className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-40 inline-flex items-center gap-2"
            >
              {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              {createMutation.isPending ? 'Starting analysis…' : 'Validate contacts'}
            </button>
          </div>
        </div>
      )}

      {phase === 'analysis' && (
        <div className="space-y-5">
          <div className="ios-card rounded-xl p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                  {job?.status === 'failed' ? (
                    <XCircle className="w-4 h-4 text-danger" />
                  ) : (
                    <Loader2 className="w-4 h-4 text-accent animate-spin" />
                  )}
                  {job?.status === 'failed' ? 'Contact processing failed' : 'Processing contacts'}
                </h3>
                <p className="text-[11px] text-ink-muted mt-1">{job?.progress.message || 'Reading and validating rows…'}</p>
              </div>
              {job && isSplitJobActive(job.status) && (
                <button
                  onClick={() => setShowCancelConfirm(true)}
                  className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold text-danger border-danger/30 hover:bg-danger/10 inline-flex items-center gap-1"
                >
                  <Ban className="w-3 h-3" /> Cancel
                </button>
              )}
            </div>

            {job?.status === 'failed' ? (
              <div className="space-y-3">
                <div className="p-3 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs">
                  {job.errorMessage || 'The analysis could not complete.'}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => retryMutation.mutate()}
                    disabled={retryMutation.isPending}
                    className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-40"
                  >
                    {retryMutation.isPending ? 'Retrying…' : 'Retry analysis'}
                  </button>
                  <button
                    onClick={() => {
                      sessionStorage.removeItem(SESSION_KEY);
                      setJobId(null);
                      setPhase('upload');
                    }}
                    className="ios-btn-secondary px-4 py-2 text-xs font-semibold"
                  >
                    Start over
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="text-ink-muted">
                      {analysis?.processedRows.toLocaleString() || 0} of{' '}
                      {analysis?.totalRowsIsExact === false ? '~' : ''}
                      {analysis?.totalRows.toLocaleString() || 0} rows
                    </span>
                    <span className="font-mono text-accent">{analysis?.percent || 0}%</span>
                  </div>
                  <div className="w-full h-2.5 bg-surface-2 rounded-full overflow-hidden border border-line">
                    <div
                      className="h-full bg-accent transition-all duration-300"
                      style={{ width: `${Math.max(2, Math.min(100, analysis?.percent || 0))}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-3 text-[10px] text-ink-subtle font-mono">
                    {analysis && analysis.throughputRowsPerSecond > 0 && (
                      <span>{Math.round(analysis.throughputRowsPerSecond).toLocaleString()} rows/s</span>
                    )}
                    {analysis && analysis.estimatedSecondsRemaining > 0 && (
                      <span>ETA {formatDurationSeconds(analysis.estimatedSecondsRemaining)}</span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                  {[
                    { label: 'Valid', value: analysis?.validContacts || 0, tone: 'text-success', icon: CheckCircle2 },
                    { label: 'Invalid', value: analysis?.invalidContacts || 0, tone: 'text-danger', icon: XCircle },
                    { label: 'Duplicates', value: analysis?.duplicateContacts || 0, tone: 'text-warning', icon: Layers },
                    { label: 'Suppressed', value: analysis?.suppressedContacts || 0, tone: 'text-ink', icon: ShieldCheck },
                  ].map((stat) => (
                    <div key={stat.label} className="p-3 rounded-xl border border-line bg-surface-2/40">
                      <div className={`text-[10px] uppercase font-semibold flex items-center gap-1 ${stat.tone}`}>
                        <stat.icon className="w-3 h-3" />
                        <span>{stat.label}</span>
                      </div>
                      <div className={`text-base font-bold mt-1 tabular-nums ${stat.tone}`}>
                        {stat.value.toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="text-[11px] text-ink-subtle bg-surface-2/60 p-3 rounded-xl border border-line/60 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 text-brand flex-shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    Invalid, duplicate, and suppressed contacts are excluded from every campaign. A downloadable error report becomes available when analysis finishes.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {phase === 'configure' && job && (
        <div className="space-y-5">
          <div className="ios-card rounded-xl p-5 space-y-4">
            <div className="text-sm font-semibold text-ink">How many contacts per campaign?</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {SPLIT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => {
                    setContactsPerCampaign(preset);
                    setCustomContactsPerCampaign(String(preset));
                  }}
                  className={`rounded-xl border px-3 py-3 text-xs font-semibold transition ${
                    contactsPerCampaign === preset
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-line bg-surface-2 text-ink-muted hover:border-accent/30'
                  }`}
                >
                  {preset.toLocaleString()}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Custom contacts per campaign</label>
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
                  placeholder={DEFAULT_SPLIT_PATTERN}
                />
                {!pattern.includes('{number}') && (
                  <p className="text-[11px] text-warning mt-1">Include {'{number}'} so each child campaign is uniquely named.</p>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 text-xs">
            {[
              { label: 'Total uploaded', value: job.progress.analysis.totalRows, tone: 'text-ink' },
              { label: 'Valid contacts', value: job.progress.analysis.validContacts, tone: 'text-success' },
              { label: 'Invalid + duplicate', value: job.progress.analysis.invalidContacts + job.progress.analysis.duplicateContacts, tone: 'text-warning' },
              { label: 'Suppressed', value: job.progress.analysis.suppressedContacts, tone: 'text-ink-muted' },
            ].map((stat) => (
              <div key={stat.label} className="ios-card p-3.5 rounded-xl">
                <div className="text-[10px] uppercase font-semibold text-ink-subtle">{stat.label}</div>
                <div className={`text-lg font-bold mt-1 tabular-nums ${stat.tone}`}>{stat.value.toLocaleString()}</div>
              </div>
            ))}
          </div>

          <div className="ios-card rounded-xl p-5 space-y-3">
            <div className="text-sm font-semibold text-ink">Split preview</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-xl border border-accent/30 bg-accent/5">
                <div className="text-[10px] uppercase font-semibold text-accent">Campaigns to create</div>
                <div className="text-lg font-bold text-accent mt-1 tabular-nums">
                  {splitPreview.expectedCampaigns.toLocaleString()}
                </div>
                <div className="text-[10px] text-ink-muted">
                  ceil({splitPreview.validContacts.toLocaleString()} ÷ {splitPreview.contactsPerCampaign.toLocaleString()})
                </div>
              </div>
              <div className="p-3 rounded-xl border border-line bg-surface-2/40">
                <div className="text-[10px] uppercase font-semibold text-ink-subtle">Contacts per campaign</div>
                <div className="text-lg font-bold text-ink mt-1 tabular-nums">{splitPreview.contactsPerCampaign.toLocaleString()}</div>
              </div>
              <div className="p-3 rounded-xl border border-line bg-surface-2/40">
                <div className="text-[10px] uppercase font-semibold text-ink-subtle">Final campaign contacts</div>
                <div className="text-lg font-bold text-ink mt-1 tabular-nums">{splitPreview.lastCampaignContacts.toLocaleString()}</div>
              </div>
            </div>

            {planPreview.head.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-surface-2 text-ink-subtle uppercase tracking-wider">
                    <tr>
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">Campaign name</th>
                      <th className="px-3 py-2">Contacts</th>
                      <th className="px-3 py-2">Row range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planPreview.head.map((row) => (
                      <tr key={row.number} className="border-t border-line">
                        <td className="px-3 py-2 font-mono text-ink-muted">{row.number}</td>
                        <td className="px-3 py-2 text-ink">{row.name}</td>
                        <td className="px-3 py-2 tabular-nums">{row.size.toLocaleString()}</td>
                        <td className="px-3 py-2 font-mono text-ink-subtle">{row.range}</td>
                      </tr>
                    ))}
                    {planPreview.hidden > 0 && (
                      <tr className="border-t border-line bg-surface-2/40">
                        <td colSpan={4} className="px-3 py-2 text-center text-ink-subtle">
                          … {planPreview.hidden.toLocaleString()} more campaigns
                        </td>
                      </tr>
                    )}
                    {planPreview.tail.map((row) => (
                      <tr key={`tail-${row.number}`} className="border-t border-line">
                        <td className="px-3 py-2 font-mono text-ink-muted">{row.number}</td>
                        <td className="px-3 py-2 text-ink">{row.name}</td>
                        <td className="px-3 py-2 tabular-nums">{row.size.toLocaleString()}</td>
                        <td className="px-3 py-2 font-mono text-ink-subtle">{row.range}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-[11px] text-ink-subtle">
              Name preview: {namePreviews.map((name) => `“${name}”`).join(' · ')}
            </p>
          </div>

          <div className="text-[11px] text-ink-subtle bg-surface-2/60 p-3 rounded-xl border border-line/60 flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-brand flex-shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              Every child campaign is created as a <strong>draft</strong>. Nothing is scheduled or sent automatically — each campaign still requires human review and approval.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate('/campaigns/splits')}
                className="ios-btn-secondary px-4 py-2 text-xs font-semibold"
              >
                Save for later
              </button>
              <button
                disabled={!splitPreview.expectedCampaigns || planMutation.isPending || !pattern.includes('{number}')}
                onClick={() => {
                  setError('');
                  planMutation.mutate();
                }}
                className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-40 inline-flex items-center gap-2"
              >
                {planMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
                {planMutation.isPending ? 'Starting generation…' : `Create ${splitPreview.expectedCampaigns.toLocaleString()} campaigns`}
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'generation' && job && (
        <div className="space-y-5">
          <div className="ios-card rounded-xl p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                  {job.status === 'completed' || job.status === 'completed_with_errors' ? (
                    <CheckCircle2 className={`w-4 h-4 ${job.status === 'completed' ? 'text-success' : 'text-warning'}`} />
                  ) : job.status === 'failed' || job.status === 'cancelled' ? (
                    <XCircle className="w-4 h-4 text-danger" />
                  ) : (
                    <Loader2 className="w-4 h-4 text-accent animate-spin" />
                  )}
                  {job.status === 'completed'
                    ? 'All campaigns created'
                    : job.status === 'completed_with_errors'
                      ? 'Finished with some failed campaigns'
                      : job.status === 'cancelled'
                        ? 'Generation cancelled'
                        : job.status === 'failed'
                          ? 'Generation failed'
                          : job.progress.message}
                </h3>
                <p className="text-[11px] text-ink-muted mt-1">
                  {job.status === 'completed' || job.status === 'completed_with_errors'
                    ? `${job.progress.generation.campaignsCreated.toLocaleString()} campaigns · ${job.progress.generation.contactsAssigned.toLocaleString()} contacts assigned`
                    : 'Campaigns are created in bounded batches. Progress is saved after every batch, so an interruption resumes safely.'}
                </p>
              </div>
              {(job.status === 'generating' || job.status === 'cancellation_requested') && (
                <button
                  onClick={() => setShowCancelConfirm(true)}
                  disabled={job.status === 'cancellation_requested' || cancelMutation.isPending}
                  className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold text-danger border-danger/30 hover:bg-danger/10 inline-flex items-center gap-1 disabled:opacity-40"
                >
                  <Ban className="w-3 h-3" /> {job.status === 'cancellation_requested' ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className="text-ink-muted">
                  {job.progress.generation.campaignsCreated.toLocaleString()} of{' '}
                  {job.progress.generation.expectedCampaigns.toLocaleString()} campaigns created
                </span>
                <span className="font-mono text-accent">{job.progress.generation.percent}%</span>
              </div>
              <div className="w-full h-2.5 bg-surface-2 rounded-full overflow-hidden border border-line">
                <div
                  className={`h-full transition-all duration-300 ${
                    job.status === 'completed'
                      ? 'bg-success'
                      : job.status === 'completed_with_errors'
                        ? 'bg-warning'
                        : job.status === 'failed' || job.status === 'cancelled'
                          ? 'bg-danger'
                          : 'bg-accent'
                  }`}
                  style={{ width: `${Math.max(2, Math.min(100, job.progress.generation.percent))}%` }}
                />
              </div>
              {job.progress.generation.currentCampaignName && isSplitJobActive(job.status) && (
                <div className="text-[11px] text-ink-subtle font-mono">
                  Now creating: {job.progress.generation.currentCampaignName}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
              {[
                { label: 'Campaigns', value: job.progress.generation.campaignsCreated, tone: 'text-accent' },
                { label: 'Expected', value: job.progress.generation.expectedCampaigns, tone: 'text-ink' },
                { label: 'Contacts assigned', value: job.progress.generation.contactsAssigned, tone: 'text-success' },
                { label: 'Failed', value: job.progress.generation.failedCampaigns, tone: job.progress.generation.failedCampaigns > 0 ? 'text-danger' : 'text-ink-muted' },
              ].map((stat) => (
                <div key={stat.label} className="p-3 rounded-xl border border-line bg-surface-2/40">
                  <div className="text-[10px] uppercase font-semibold text-ink-subtle flex items-center gap-1">
                    <Users className="w-3 h-3" />
                    <span>{stat.label}</span>
                  </div>
                  <div className={`text-base font-bold mt-1 tabular-nums ${stat.tone}`}>{stat.value.toLocaleString()}</div>
                </div>
              ))}
            </div>

            {job.progress.generation.failedCampaignNumbers.length > 0 && (
              <div className="p-3 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs">
                Failed campaign numbers: {job.progress.generation.failedCampaignNumbers.slice(0, 20).join(', ')}
                {job.progress.generation.failedCampaignNumbers.length > 20 ? '…' : ''}. Retry to create only the missing campaigns.
              </div>
            )}

            {job.errorMessage && (
              <div className="p-3 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs">{job.errorMessage}</div>
            )}

            {(job.status === 'failed' || job.status === 'completed_with_errors') && (
              <button
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending}
                className="ios-btn-secondary px-4 py-2 text-xs font-semibold disabled:opacity-40"
              >
                {retryMutation.isPending ? 'Retrying…' : 'Retry failed campaigns'}
              </button>
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

            <div className="text-[11px] text-ink-subtle bg-surface-2/60 p-3 rounded-xl border border-line/60 flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-brand flex-shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                <strong>Zero-dispatch guarantee:</strong> no email is sent while campaigns are created. Each child campaign starts as a draft and follows your existing review, approval, and scheduling workflow.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={() => navigate('/campaigns/splits')}
              className="ios-btn-secondary px-4 py-2 text-xs font-semibold"
            >
              All split imports
            </button>
            {isSplitJobActive(job.status) ? (
              <span className="text-[11px] text-ink-subtle">You can leave this page — generation continues in the background.</span>
            ) : (
              <button
                onClick={() => navigate(`/campaigns/splits/${job.id}`)}
                className="ios-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2"
              >
                Open import overview
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={() => cancelMutation.mutate()}
        title="Cancel this split import?"
        description="Analysis or campaign generation will stop. Campaigns already created are kept as drafts; no new campaigns will be added. No emails are sent."
        confirmText="Yes, cancel import"
        cancelText="Keep running"
        isDestructive
        isLoading={cancelMutation.isPending}
        icon={Ban}
      />
    </div>
  );
}

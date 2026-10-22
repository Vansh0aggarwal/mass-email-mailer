import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Upload, Gauge, Zap } from 'lucide-react';
import { api, ChunkedUploadProgress } from '../lib/api';
import { CampaignPreview, EmailAccount, SenderAccount, WorkspaceSettings } from '../types';
import {
  FIXED_FIELD_DEFS,
  buildAvailableTokens,
  findUnknownTokens,
  guessColumnMapping,
  normalizeTokenKey,
} from '../lib/campaign';
import { CampaignCreationProgressModal } from '../components/campaigns/CampaignCreationProgressModal';

interface StepForm {
  subject: string;
  bodyText: string;
  delayDays: number;
}

interface CustomFieldRow {
  source: string;
  target: string;
  enabled: boolean;
}

const PHASES = ['Upload', 'Map columns', 'Compose steps', 'Review & create'];

export function CampaignNewPage() {
  const navigate = useNavigate();

  const [phase, setPhase] = useState(1);
  const [fileName, setFileName] = useState('');
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ChunkedUploadProgress | null>(null);
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [customFields, setCustomFields] = useState<CustomFieldRow[]>([]);

  const [name, setName] = useState('');
  const [mailboxId, setMailboxId] = useState('');
  /** Connected mailboxes that send this campaign (2+ activates the multi-mailbox drip). */
  const [senderAccountIds, setSenderAccountIds] = useState<string[]>([]);
  const [generationMode, setGenerationMode] = useState<'template' | 'ai'>('template');
  const [targetService, setTargetService] = useState('');
  const [steps, setSteps] = useState<StepForm[]>([{ subject: '', bodyText: '', delayDays: 0 }]);
  const [error, setError] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);

  // Resume active campaign creation job if page was reloaded during import
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('swaniki_active_campaign_creation_job');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.jobId) {
          setActiveJobId(parsed.jobId);
          if (parsed.campaignName && !name) setName(parsed.campaignName);
          setIsModalOpen(true);
        }
      }
    } catch {
      /* ignore storage parse failure */
    }
  }, []);

  const { data: mailboxes = [] } = useQuery<EmailAccount[]>({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<EmailAccount[]>('/mailboxes'),
  });

  // Connected accounts that may act as a campaign sender (authorized only).
  const { data: senderAccounts = [] } = useQuery<SenderAccount[]>({
    queryKey: ['campaign-sender-accounts'],
    queryFn: () => api.get<SenderAccount[]>('/campaigns/sender-accounts'),
  });

  const { data: senderSettings } = useQuery<WorkspaceSettings>({
    queryKey: ['workspace-settings-sender'],
    queryFn: () => api.get<WorkspaceSettings>('/settings/sender'),
  });

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

  const effectiveCustomMapping = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cf of customFields) if (cf.enabled && cf.target) map[cf.source] = normalizeTokenKey(cf.target);
    return map;
  }, [customFields]);

  const availableTokens = useMemo(
    () => buildAvailableTokens(columnMapping, effectiveCustomMapping),
    [columnMapping, effectiveCustomMapping]
  );

  /**
   * Adds or removes a mailbox from the campaign's sender roster. The first
   * selected mailbox stays the primary sender (the legacy `mailboxId`), the
   * others join the campaign as additional senders.
   */
  const toggleSenderAccount = (account: SenderAccount) => {
    setSenderAccountIds((current) => {
      const next = current.includes(account.accountId)
        ? current.filter((id) => id !== account.accountId)
        : [...current, account.accountId];

      // Keep the primary mailbox in sync with the first selected account.
      const primary = next
        .map((id) => senderAccounts.find((a) => a.accountId === id))
        .find((a): a is SenderAccount => Boolean(a));
      if (primary) setMailboxId(primary.emailAddress);

      return next;
    });
  };

  const previewMutation = useMutation({
    mutationFn: (content: string) => api.post<CampaignPreview>('/campaigns/preview', { csvContent: content }),
    onSuccess: (data) => {
      setPreview(data);
      const guessed = guessColumnMapping(data.headers);
      setColumnMapping(guessed);
      const used = new Set(Object.values(guessed));
      setCustomFields(
        data.headers
          .filter((h) => !used.has(h))
          .map((h) => ({ source: h, target: normalizeTokenKey(h), enabled: false }))
      );

      // Auto-populate sequence steps if CSV contains Step 1/2/3 subjects and bodies
      if (guessed.step_1_subject && guessed.step_1_body) {
        const autoSteps: StepForm[] = [
          { subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 },
        ];
        if (guessed.step_2_subject && guessed.step_2_body) {
          autoSteps.push({
            subject: '{{step_2_subject}}',
            bodyText: '{{step_2_body}}',
            delayDays: senderSettings?.defaultFollowUpIntervalDays || 3,
          });
        }
        if (guessed.step_3_subject && guessed.step_3_body) {
          autoSteps.push({
            subject: '{{step_3_subject}}',
            bodyText: '{{step_3_body}}',
            delayDays: (senderSettings?.defaultFollowUpIntervalDays || 3) + 1,
          });
        }
        setSteps(autoSteps);
      }

      setPhase(2);
    },
    onError: (err: any) => setError(err.message),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string; campaignId: string; totalRows: number }>('/campaigns/jobs', {
        name,
        mailboxId,
        steps,
        uploadId,
        columnMapping,
        customFieldMapping: effectiveCustomMapping,
        generationMode,
        // A single mailbox keeps the classic single-sender behaviour; two or
        // more mailboxes activate the multi-mailbox drip (one recipient, one
        // mailbox, own pace per mailbox).
        ...(senderAccountIds.length > 1 ? { senderAccountIds } : {}),
        ...(generationMode === 'ai' && targetService.trim() ? { targetService: targetService.trim() } : {}),
      }),
    onMutate: () => {
      setIsModalOpen(true);
    },
    onSuccess: (data) => {
      setActiveJobId(data.jobId);
      setIsModalOpen(true);
    },
    onError: (err: any) => {
      setError(err.message || 'Failed to start campaign creation');
      setIsModalOpen(false);
    },
  });

  const onFile = async (file: File) => {
    setError('');
    setIsUploading(true);
    setUploadProgress(null);
    setFileName(file.name);
    const abortController = new AbortController();
    uploadAbortControllerRef.current = abortController;
    try {
      const res = await api.uploadChunked(file, {
        signal: abortController.signal,
        onProgress: (p) => setUploadProgress(p),
      });

      setUploadId(res.uploadId);
      setPreview({
        headers: res.headers,
        sampleRows: res.sampleRows,
        totalRows: res.totalRows,
        totalRowsIsExact: res.totalRowsIsExact,
      });

      const guessed = guessColumnMapping(res.headers);
      setColumnMapping(guessed);
      const used = new Set(Object.values(guessed));
      setCustomFields(
        res.headers
          .filter((h) => !used.has(h))
          .map((h) => ({ source: h, target: normalizeTokenKey(h), enabled: false }))
      );

      // Auto-populate sequence steps if CSV contains Step 1/2/3 subjects and bodies
      if (guessed.step_1_subject && guessed.step_1_body) {
        const autoSteps: StepForm[] = [
          { subject: '{{step_1_subject}}', bodyText: '{{step_1_body}}', delayDays: 0 },
        ];
        if (guessed.step_2_subject && guessed.step_2_body) {
          autoSteps.push({
            subject: '{{step_2_subject}}',
            bodyText: '{{step_2_body}}',
            delayDays: senderSettings?.defaultFollowUpIntervalDays || 3,
          });
        }
        if (guessed.step_3_subject && guessed.step_3_body) {
          autoSteps.push({
            subject: '{{step_3_subject}}',
            bodyText: '{{step_3_body}}',
            delayDays: (senderSettings?.defaultFollowUpIntervalDays || 3) + 1,
          });
        }
        setSteps(autoSteps);
      }

      setPhase(2);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setError('Upload cancelled.');
      } else {
        setError(err.message || 'Failed to upload and inspect file');
      }
    } finally {
      setIsUploading(false);
      uploadAbortControllerRef.current = null;
    }
  };

  const canGoNext =
    (phase === 1 && !!preview) ||
    (phase === 2 && !!columnMapping.company_name && !!columnMapping.contact_email) ||
    (phase === 3 &&
      !!name.trim() &&
      !!mailboxId &&
      (generationMode === 'template' || !!targetService.trim()) &&
      steps.every((s) => s.subject.trim() && s.bodyText.trim()));

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <button
          onClick={() => navigate('/campaigns')}
          className="text-xs text-ink-muted hover:text-ink inline-flex items-center gap-1.5 mb-3"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to campaigns
        </button>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">New campaign</h1>
        <p className="text-xs text-ink-muted mt-1">
          Upload a CSV, map columns (including custom ones), compose multi-step emails, then review before sending.
        </p>
      </div>

      <div className="ios-card rounded-xl p-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
          {PHASES.map((label, i) => {
            const n = i + 1;
            const active = phase === n;
            const done = phase > n;
            return (
              <div
                key={label}
                className={`rounded-lg px-3 py-2 font-semibold ${
                  active
                    ? 'bg-accent/10 text-accent border border-accent/25'
                    : done
                      ? 'bg-success/10 text-success'
                      : 'bg-surface-2 text-ink-subtle'
                }`}
              >
                {n}. {label}
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs">{error}</div>
      )}

      {phase === 1 && (
        <div className="ios-card rounded-xl p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-xl bg-accent/10 border border-accent/30 text-accent flex items-center justify-center mx-auto">
            <Upload className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">Select a prospect CSV or Excel file</h3>
            <p className="text-xs text-ink-muted mt-1">
              Supports .csv, .xlsx, and .xls files. Headers and sample rows are inspected directly with zero browser memory strain.
            </p>
          </div>
          <input
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xls,application/vnd.ms-excel"
            id="campaign-csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <label
            htmlFor="campaign-csv"
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
                  Streaming Upload
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
                Chunk {uploadProgress.currentChunk} of {uploadProgress.totalChunks} (Resumable stream)
              </div>
            </div>
          )}

          {isUploading && !uploadProgress && (
            <div className="text-xs text-ink-muted flex items-center justify-center gap-1.5">
              <Gauge className="w-3.5 h-3.5 animate-spin text-accent" />
              <span>Inspecting headers & sample rows…</span>
            </div>
          )}

          {preview && (
            <div className="text-left pt-4">
              <div className="text-[11px] text-ink-subtle mb-2">
                {preview.totalRowsIsExact === false ? `~${preview.totalRows.toLocaleString()} (est.)` : preview.totalRows.toLocaleString()} rows · {preview.headers.length} columns detected
              </div>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-surface-2 text-ink-subtle uppercase tracking-wider">
                    <tr>
                      {preview.headers.map((h) => (
                        <th key={h} className="px-3 py-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sampleRows.map((row, i) => (
                      <tr key={i} className="border-t border-line">
                        {preview.headers.map((h) => (
                          <td key={h} className="px-3 py-2">{row[h]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {previewMutation.isPending && <div className="text-xs text-ink-muted">Reading columns…</div>}
        </div>
      )}

      {phase === 2 && preview && (
        <div className="ios-card rounded-xl p-5">
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
                  {preview.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {customFields.length > 0 && (
            <div className="mt-6 border-t border-line pt-4">
              <div className="text-xs font-semibold text-ink mb-1">Extra columns</div>
              <p className="text-[11px] text-ink-muted mb-3">
                Toggle any you want to preserve and personalize with <span className="font-mono">{'{{token}}'}</span>.
              </p>
              <div className="space-y-2">
                {customFields.map((cf, i) => (
                  <div key={cf.source} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={cf.enabled}
                      onChange={(e) =>
                        setCustomFields((rows) =>
                          rows.map((r, idx) => (idx === i ? { ...r, enabled: e.target.checked } : r))
                        )
                      }
                    />
                    <span className="text-[11px] text-ink-muted w-40 truncate">{cf.source}</span>
                    <input
                      className="input px-2.5 py-1.5 text-xs flex-1"
                      placeholder="token key"
                      value={cf.target}
                      onChange={(e) =>
                        setCustomFields((rows) =>
                          rows.map((r, idx) => (idx === i ? { ...r, target: e.target.value } : r))
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 3 && (
        <div className="space-y-6">
          <div className="ios-card rounded-xl p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-ink-muted mb-1.5">Campaign name</label>
              <input className="input px-3 py-2 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q4 Web Redesign Outreach" />
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
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-ink-muted mb-1.5">Sender accounts (multi-mailbox drip)</label>
              {senderAccounts.length === 0 ? (
                <p className="text-[11px] text-ink-subtle">
                  No connected mailbox is available yet. Connect a Gmail account to send campaigns.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {senderAccounts.map((account) => {
                    const selected = senderAccountIds.includes(account.accountId);
                    const disabled = !account.authorized;
                    return (
                      <label
                        key={account.accountId}
                        className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs transition ${
                          disabled
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
                          disabled={disabled}
                          onChange={() => toggleSenderAccount(account)}
                        />
                        <span className="min-w-0">
                          <span className="block font-medium text-ink truncate">{account.emailAddress}</span>
                          <span className="block text-[11px] text-ink-subtle">
                            {disabled
                              ? account.authorization?.reason || 'Not authorized to send'
                              : `${account.provider} · ${account.remainingDailyAllowance} of ${account.dailySendLimit} left today`}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-[11px] text-ink-subtle mt-1.5">
                {senderAccountIds.length > 1
                  ? `The recipients are split evenly over the ${senderAccountIds.length} selected mailboxes. Each recipient is contacted from one mailbox only, and every mailbox sends at its own pace.`
                  : 'Select two or more connected mailboxes to spread the campaign over several inboxes. A single mailbox keeps the classic behaviour.'}
              </p>
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
              <p className="text-[11px] text-ink-subtle mt-1">
                AI mode calls the configured provider per company and falls back to a template if it is unavailable.
              </p>
            </div>
            {generationMode === 'ai' && (
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Target service / theme</label>
                <input
                  className="input px-3 py-2 text-xs"
                  value={targetService}
                  onChange={(e) => setTargetService(e.target.value)}
                  placeholder="e.g. Speed Optimization"
                />
                <p className="text-[11px] text-ink-subtle mt-1">Grounds the AI on what you are offering.</p>
              </div>
            )}
          </div>

          <div className="space-y-3">
            {steps.map((step, i) => {
              const unknown = findUnknownTokens(`${step.subject} ${step.bodyText}`, availableTokens);
              return (
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
                    placeholder="Body — use {{tokens}} from the list above"
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

                  {unknown.length > 0 && (
                    <div className="text-[11px] text-warning">
                      Unknown tokens: {unknown.map((t) => `{{${t}}}`).join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ios-card rounded-xl p-5">
            <div className="text-[11px] text-ink-subtle mb-2">Available merge tokens (click to copy the token name)</div>
            <div className="flex flex-wrap gap-1.5">
              {availableTokens.map((t) => (
                <span key={t} className="ios-pill font-mono">{`{{${t}}}`}</span>
              ))}
            </div>
          </div>

          <button
            onClick={() => setSteps((s) => [...s, { subject: '', bodyText: '', delayDays: 3 }])}
            className="ios-btn-secondary px-4 py-2 text-xs font-semibold"
          >
            Add follow-up step
          </button>
        </div>
      )}

      {phase === 4 && (
        <div className="ios-card rounded-xl p-5 space-y-4 text-xs">
          <div className="text-sm font-semibold text-ink">About to create</div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <dt className="text-ink-subtle">Name</dt>
              <dd className="text-ink">{name}</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Mailbox</dt>
              <dd className="text-ink font-mono">{mailboxId}</dd>
            </div>
            {senderAccountIds.length > 1 && (
              <div className="sm:col-span-2">
                <dt className="text-ink-subtle">Sender accounts</dt>
                <dd className="text-ink font-mono">
                  {senderAccountIds
                    .map((id) => senderAccounts.find((a) => a.accountId === id)?.emailAddress)
                    .filter(Boolean)
                    .join(', ')}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-ink-subtle">Rows in file</dt>
              <dd className="text-ink tabular-nums">{preview?.totalRows ?? 0}</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Email steps</dt>
              <dd className="text-ink tabular-nums">{steps.length}</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Generation</dt>
              <dd className="text-ink">
                {generationMode === 'ai' ? `AI-personalized — ${targetService || 'no service set'}` : 'Deterministic template'}
              </dd>
            </div>
          </dl>
          <p className="text-ink-muted">
            {generationMode === 'ai'
              ? 'Drafts are AI-personalized per company (grounded on stored facts) and must be individually approved before any send. Failed AI calls fall back to a deterministic template and are flagged.'
              : 'Drafts are generated deterministically from your templates and must be individually approved before any send.'}
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          disabled={phase === 1}
          onClick={() => setPhase((p) => Math.max(1, p - 1))}
          className="ios-btn-secondary px-4 py-2 text-xs font-semibold disabled:opacity-40"
        >
          Back
        </button>

        {phase < 4 ? (
          <button
            disabled={!canGoNext}
            onClick={() => setPhase((p) => p + 1)}
            className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-40"
          >
            Continue
          </button>
        ) : (
          <button
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
            className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-40 inline-flex items-center gap-2"
          >
            <Upload className="w-3.5 h-3.5" />
            {createMutation.isPending ? 'Creating…' : 'Create campaign'}
          </button>
        )}
      </div>

      <CampaignCreationProgressModal
        jobId={activeJobId}
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setActiveJobId(null);
        }}
        campaignName={name}
        fallbackTotalRows={preview?.totalRows || 0}
        isUploading={createMutation.isPending && !activeJobId}
        onCancelUpload={() => {
          uploadAbortControllerRef.current?.abort();
          setIsModalOpen(false);
        }}
      />
    </div>
  );
}

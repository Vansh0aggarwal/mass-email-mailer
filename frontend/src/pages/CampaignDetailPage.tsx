import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Sparkles,
  Check,
  Send,
  Pause,
  Trash2,
  RefreshCw,
  CalendarClock,
  Play,
  XCircle,
  RotateCcw,
  Eye,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  AlertCircle,
  Info,
  Globe,
  Download,
  Layers,
  ShieldCheck,
  ArrowRight,
  Search,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { Campaign, CampaignProgress, CampaignRecipient } from '../types';
import { campaignStatusMeta, recipientStatusClass, isValidEmailFormat } from '../lib/campaign';
import { getTargetingEvidence, getAiRecommendation, getRecipientValidationIssues } from '../lib/targeting';
import { RecipientDraftInspectorModal } from '../components/campaigns/RecipientDraftInspectorModal';
import { SenderAccountsPanel } from '../components/campaigns/SenderAccountsPanel';
import { ConfirmationModal } from '../components/common/ConfirmationModal';

interface RecipientsResponse {
  recipients: CampaignRecipient[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export function CampaignDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState<CampaignRecipient | null>(null);
  const [expandedWhy, setExpandedWhy] = useState<Set<string>>(new Set());
  const [step2Delay, setStep2Delay] = useState(3);
  const [step3Delay, setStep3Delay] = useState(4);

  // Pagination, search, and status filter state for recipients review table
  const [recipientPage, setRecipientPage] = useState(1);
  const [recipientPageSize, setRecipientPageSize] = useState(50);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [recipientStatusFilter, setRecipientStatusFilter] = useState('all');

  // Debounce search input to avoid spamming the backend
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(recipientSearch.trim());
      setRecipientPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [recipientSearch]);

  const [startAt, setStartAt] = useState(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setSeconds(0, 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const [timezone, setTimezone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  });
  const [batchSize, setBatchSize] = useState(25);
  const [paceMinutes, setPaceMinutes] = useState(0);
  const [useWindow, setUseWindow] = useState(false);
  const [windowStartHour, setWindowStartHour] = useState(9);
  const [windowEndHour, setWindowEndHour] = useState(17);
  // Drip pacing (campaign wide default for every mailbox of the roster).
  const [allowedWeekdays, setAllowedWeekdays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [minIntervalSeconds, setMinIntervalSeconds] = useState(60);
  const [jitterSeconds, setJitterSeconds] = useState(30);
  const [maxPerHour, setMaxPerHour] = useState(60);
  const [dailySendCap, setDailySendCap] = useState(100);

  const { data: campaign, isLoading } = useQuery<Campaign>({
    queryKey: ['campaign', id],
    queryFn: () => api.get<Campaign>(`/campaigns/${id}`),
  });

  const { data: progress } = useQuery<CampaignProgress>({
    queryKey: ['campaign-progress', id],
    queryFn: () => api.get<CampaignProgress>(`/campaigns/${id}/progress`),
  });

  const {
    data: recipientsData,
    isFetching: isRecipientsFetching,
  } = useQuery<RecipientsResponse>({
    queryKey: ['campaign-recipients', id, recipientPage, recipientPageSize, debouncedSearch, recipientStatusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(recipientPage));
      params.set('limit', String(recipientPageSize));
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (recipientStatusFilter && recipientStatusFilter !== 'all') {
        params.set('status', recipientStatusFilter);
      }
      return api.get<RecipientsResponse>(`/campaigns/${id}/recipients?${params.toString()}`);
    },
    placeholderData: (previousData) => previousData,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['campaign', id] });
    queryClient.invalidateQueries({ queryKey: ['campaign-progress', id] });
    queryClient.invalidateQueries({ queryKey: ['campaign-recipients', id] });
  };

  const sendMutation = useMutation({
    mutationFn: (batchSize: number) =>
      api.post<{
        processed: number;
        remaining: number;
        status: string;
        throttledAccounts?: { accountId: string; emailAddress: string; reason: string }[];
      }>(`/campaigns/${id}/send`, { batchSize }),
    onSuccess: (data) => {
      const throttled = data.throttledAccounts?.length
        ? ` ${data.throttledAccounts.length} mailbox(es) hit their cap and keep their recipients queued.`
        : '';
      setMessage(
        `Dispatched ${data.processed}; ${data.remaining} remaining. Status: ${data.status}.${throttled}`
      );
      refresh();
    },
    onError: (err: any) => setMessage(err.message),
  });

  const pauseMutation = useMutation({
    mutationFn: () => api.post(`/campaigns/${id}/pause`, {}),
    onSuccess: () => {
      setMessage('Campaign paused.');
      refresh();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/campaigns/${id}`),
    onSuccess: async () => {
      // Invalidate campaigns list so the cache is fresh
      await queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      // Remove detail queries from cache
      queryClient.removeQueries({ queryKey: ['campaign', id] });
      queryClient.removeQueries({ queryKey: ['campaign-progress', id] });
      queryClient.removeQueries({ queryKey: ['campaign-recipients', id] });

      // Navigate to existing /campaigns route with flash message
      navigate('/campaigns', {
        state: {
          flashMessage: `Campaign "${campaign?.name || 'Campaign'}" was deleted successfully.`,
          deletedCampaignId: id,
        },
        replace: true,
      });
    },
    onError: (err: any) => {
      setShowDeleteModal(false);
      setMessage(err.message || 'Failed to delete campaign.');
    },
  });

  const retryMutation = useMutation({
    mutationFn: (recipientId: string) => api.post(`/campaigns/${id}/recipients/${recipientId}/retry`, {}),
    onSuccess: () => {
      setMessage('Recipient re-validated and queued for processing.');
      refresh();
    },
    onError: (err: any) => setMessage(err.message),
  });

  const [isExporting, setIsExporting] = useState(false);

  const handleExportCsv = async () => {
    setIsExporting(true);
    try {
      const token = localStorage.getItem('radar_token');
      const res = await fetch(`/api/v1/campaigns/${id}/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to export campaign report');
      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `campaign_${(campaign?.name || 'report').toLowerCase().replace(/\s+/g, '_')}_export.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err: any) {
      setMessage(err?.message || 'CSV export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const runGenerateAll = async () => {
    setBusy('generate');
    setMessage('');
    try {
      for (let i = 0; i < 100; i++) {
        const res = await api.post<{ processed: number; remaining: number }>(`/campaigns/${id}/generate`, { batchSize: 50 });
        if (res.remaining === 0 || res.processed === 0) break;
      }
      setMessage('Draft generation complete.');
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const runSendAll = async () => {
    setBusy('send');
    setMessage('');
    try {
      for (let i = 0; i < 100; i++) {
        const res = await api.post<{ processed: number; remaining: number; status: string }>(`/campaigns/${id}/send`, {
          batchSize: 50,
        });
        if (res.remaining === 0 || res.processed === 0 || res.status === 'paused') break;
      }
      setMessage('Send run complete.');
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const approveAll = () => {
    setBusy('approve');
    setMessage('');
    api
      .post<{ approved: number; excluded: number; reasons: string[] }>(`/campaigns/${id}/approve`, {})
      .then((data) => {
        const excl = data.excluded > 0 ? ` (${data.excluded} skipped: no drafts generated)` : '';
        setMessage(`Approved ${data.approved} recipient draft(s)${excl}.`);
      })
      .catch((err) => setMessage(err.message))
      .finally(() => {
        setBusy(null);
        refresh();
      });
  };

  useEffect(() => {
    if (campaign?.steps) {
      if (campaign.steps[1]) setStep2Delay(campaign.steps[1].delayDays || 3);
      if (campaign.steps[2]) setStep3Delay(campaign.steps[2].delayDays || 4);
    }
  }, [campaign?.steps]);

  const scheduleMutation = useMutation({
    mutationFn: async () => {
      const schedule = {
        startAt: new Date(startAt).toISOString(),
        timezone,
        batchSize,
        paceMinutes,
        windowStartHour: useWindow ? windowStartHour : undefined,
        windowEndHour: useWindow ? windowEndHour : undefined,
        allowedWeekdays: allowedWeekdays.length > 0 ? allowedWeekdays : undefined,
        minIntervalSeconds,
        jitterSeconds,
        maxPerHour,
        dailySendCap,
      };

      await api.patch(`/campaigns/${id}/schedule-settings`, {
        stepDelays: [
          ...(campaign?.steps[1] ? [{ stepIndex: campaign.steps[1].stepIndex, delayDays: step2Delay }] : []),
          ...(campaign?.steps[2] ? [{ stepIndex: campaign.steps[2].stepIndex, delayDays: step3Delay }] : []),
        ],
        schedule,
      });

      return api.post(`/campaigns/${id}/schedule`, schedule);
    },
    onSuccess: () => {
      setMessage('Campaign scheduled. The server will send approved recipients and follow-ups automatically.');
      setShowSchedule(false);
      refresh();
    },
    onError: (err: any) => setMessage(err.message),
  });

  const resumeMutation = useMutation({
    mutationFn: () => api.post(`/campaigns/${id}/resume`, {}),
    onSuccess: () => {
      setMessage('Campaign resumed.');
      refresh();
    },
    onError: (err: any) => setMessage(err.message),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.post(`/campaigns/${id}/cancel`, {}),
    onSuccess: () => {
      setMessage('Campaign cancelled.');
      refresh();
    },
    onError: (err: any) => setMessage(err.message),
  });

  if (isLoading || !campaign) {
    return <div className="ios-card p-8 max-w-4xl"><div className="skeleton h-32 rounded-xl" /></div>;
  }

  const meta = campaignStatusMeta(campaign.status);
  const recipients = recipientsData?.recipients ?? [];
  const hasUngenerated =
    progress?.hasUngeneratedDrafts ??
    recipients.some((r) =>
      (campaign.steps || []).some((step) => {
        const slot = r.stepDrafts?.find((s) => s.stepIndex === step.stepIndex);
        return !slot || !slot.draftId;
      }) && !['skipped', 'suppressed'].includes(r.status)
    );
  const canGenerate = hasUngenerated || (progress?.byStatus?.pending ?? 0) > 0;

  const toggleWhy = (recipientId: string) => {
    setExpandedWhy((prev) => {
      const next = new Set(prev);
      if (next.has(recipientId)) next.delete(recipientId);
      else next.add(recipientId);
      return next;
    });
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <button onClick={() => navigate('/campaigns')} className="text-xs text-ink-muted hover:text-ink inline-flex items-center gap-1.5 mb-3">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to campaigns
        </button>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink flex items-center gap-2.5">
              {campaign.name}
              <span className={`badge ${meta.className} uppercase font-semibold`}>{meta.label}</span>
            </h1>
            <p className="text-xs text-ink-muted mt-1 font-mono">{campaign.mailboxId}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canGenerate && (
              <button onClick={runGenerateAll} disabled={!!busy} className="ios-btn-secondary px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-40">
                <Sparkles className="w-3.5 h-3.5" /> {busy === 'generate' ? 'Generating…' : 'Generate drafts'}
              </button>
            )}
            <button onClick={approveAll} disabled={!!busy} className="ios-btn-secondary px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-40">
              <Check className="w-3.5 h-3.5" /> {busy === 'approve' ? 'Approving…' : 'Approve all'}
            </button>
            <button onClick={runSendAll} disabled={!!busy} data-cursor-label="Send all" className="ios-btn-primary px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-40">
              <Send className="w-3.5 h-3.5" /> {busy === 'send' ? 'Sending…' : 'Send all'}
            </button>
            <button onClick={() => sendMutation.mutate(25)} disabled={!!busy} data-cursor-label="Batch of 25" className="ios-btn-secondary px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-40">
              <RefreshCw className="w-3.5 h-3.5" /> Send batch
            </button>
            <button
              onClick={handleExportCsv}
              disabled={isExporting}
              className="ios-btn-secondary px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-40"
              title="Download full campaign report CSV with recipients, send statuses, and reply records"
            >
              <Download className="w-3.5 h-3.5 text-accent" />
              {isExporting ? 'Exporting…' : 'Export CSV'}
            </button>
            {campaign.status === 'sending' && (
              <button onClick={() => pauseMutation.mutate()} className="ios-btn-secondary px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2">
                <Pause className="w-3.5 h-3.5" /> Pause
              </button>
            )}
            {!['scheduled', 'sending', 'completed', 'failed'].includes(campaign.status) && (
              <button
                onClick={() => setShowSchedule((v) => !v)}
                disabled={!!busy}
                className="ios-btn-secondary px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-40"
              >
                <CalendarClock className="w-3.5 h-3.5" /> Schedule
              </button>
            )}
            {campaign.status === 'paused' && (
              <button
                onClick={() => resumeMutation.mutate()}
                disabled={!!busy}
                className="ios-btn-secondary px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-40"
              >
                <Play className="w-3.5 h-3.5" /> Resume
              </button>
            )}
            {['scheduled', 'paused', 'sending'].includes(campaign.status) && (
              <button
                onClick={() => window.confirm('Cancel this campaign? No further messages will be sent.') && cancelMutation.mutate()}
                disabled={!!busy}
                className="px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2 rounded-xl border border-danger/30 text-danger hover:bg-danger/10 disabled:opacity-40"
              >
                <XCircle className="w-3.5 h-3.5" /> Cancel
              </button>
            )}
            <button
              onClick={() => setShowDeleteModal(true)}
              disabled={deleteMutation.isPending || !!busy}
              className="px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-2 rounded-xl border border-danger/30 text-danger hover:bg-danger/10 disabled:opacity-40"
              title="Delete campaign and generated drafts"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </div>

      {message && <div className="p-3.5 rounded-xl border border-line bg-surface-2 text-xs text-ink">{message}</div>}

      {showSchedule && (
        <div className="ios-card rounded-xl p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-ink">Schedule sending</h3>
            <p className="text-[11px] text-ink-muted mt-1">
              The server sends approved recipients in paced batches and keeps running across restarts. No browser tab needs to stay open.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="block text-ink-muted mb-1.5">Start date &amp; time</label>
              <input
                type="datetime-local"
                className="input px-3 py-2 text-xs"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-ink-muted mb-1.5">Timezone</label>
              <input className="input px-3 py-2 text-xs" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
            <div>
              <label className="block text-ink-muted mb-1.5">Batch size</label>
              <input
                type="number"
                min={1}
                max={200}
                className="input px-3 py-2 text-xs"
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-ink-muted mb-1.5">Minutes between batches</label>
              <input
                type="number"
                min={0}
                max={1440}
                className="input px-3 py-2 text-xs"
                value={paceMinutes}
                onChange={(e) => setPaceMinutes(Number(e.target.value))}
              />
            </div>
            <div className="flex items-end gap-2">
              <label className="inline-flex items-center gap-2 text-ink-muted">
                <input type="checkbox" checked={useWindow} onChange={(e) => setUseWindow(e.target.checked)} />
                Limit to a daily window
              </label>
            </div>
            {useWindow && (
              <>
                <div>
                  <label className="block text-ink-muted mb-1.5">Window start hour</label>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    className="input px-3 py-2 text-xs"
                    value={windowStartHour}
                    onChange={(e) => setWindowStartHour(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="block text-ink-muted mb-1.5">Window end hour</label>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    className="input px-3 py-2 text-xs"
                    value={windowEndHour}
                    onChange={(e) => setWindowEndHour(Number(e.target.value))}
                  />
                </div>
              </>
            )}
            <div className="col-span-full border-t border-line/60 pt-3">
              <div className="text-[11px] font-semibold text-ink uppercase tracking-wider mb-2">
                Drip Pacing (per mailbox)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-ink-muted mb-1.5">Seconds between sends</label>
                  <input
                    type="number"
                    min={0}
                    max={86400}
                    className="input px-3 py-2 text-xs"
                    value={minIntervalSeconds}
                    onChange={(e) => setMinIntervalSeconds(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="block text-ink-muted mb-1.5">Random extra delay (s)</label>
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    className="input px-3 py-2 text-xs"
                    value={jitterSeconds}
                    onChange={(e) => setJitterSeconds(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="block text-ink-muted mb-1.5">Max per hour</label>
                  <input
                    type="number"
                    min={0}
                    max={2000}
                    className="input px-3 py-2 text-xs"
                    value={maxPerHour}
                    onChange={(e) => setMaxPerHour(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="block text-ink-muted mb-1.5">Daily cap</label>
                  <input
                    type="number"
                    min={0}
                    max={2000}
                    className="input px-3 py-2 text-xs"
                    value={dailySendCap}
                    onChange={(e) => setDailySendCap(Number(e.target.value))}
                  />
                </div>
              </div>
              <div className="mt-3">
                <label className="block text-ink-muted mb-1.5">Sending days</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { value: 1, label: 'Mon' },
                    { value: 2, label: 'Tue' },
                    { value: 3, label: 'Wed' },
                    { value: 4, label: 'Thu' },
                    { value: 5, label: 'Fri' },
                    { value: 6, label: 'Sat' },
                    { value: 0, label: 'Sun' },
                  ].map((day) => (
                    <label key={day.value} className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                      <input
                        type="checkbox"
                        checked={allowedWeekdays.includes(day.value)}
                        onChange={(e) =>
                          setAllowedWeekdays((current) =>
                            e.target.checked
                              ? [...current, day.value].sort((a, b) => a - b)
                              : current.filter((d) => d !== day.value)
                          )
                        }
                      />
                      {day.label}
                    </label>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-ink-subtle mt-2">
                Each mailbox sends at most one message per interval and never exceeds its hourly or daily cap. A mailbox
                with its own limits keeps them.
              </p>
            </div>
            <div className="col-span-full border-t border-line/60 pt-3">
              <div className="text-[11px] font-semibold text-ink uppercase tracking-wider mb-2">
                Automatic Follow-up Delays
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-ink-muted mb-1.5">
                    Step 2 Delay (days after Step 1 send)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={90}
                    className="input px-3 py-2 text-xs"
                    value={step2Delay}
                    onChange={(e) => setStep2Delay(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="block text-ink-muted mb-1.5">
                    Step 3 Delay (days after Step 2 send)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={90}
                    className="input px-3 py-2 text-xs"
                    value={step3Delay}
                    onChange={(e) => setStep3Delay(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => scheduleMutation.mutate()}
              disabled={scheduleMutation.isPending}
              className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-40 inline-flex items-center gap-2"
            >
              <CalendarClock className="w-3.5 h-3.5" />
              {scheduleMutation.isPending ? 'Scheduling…' : 'Confirm schedule'}
            </button>
            <button onClick={() => setShowSchedule(false)} className="ios-btn-secondary px-4 py-2 text-xs font-semibold">
              Cancel
            </button>
            <span className="text-[11px] text-ink-subtle">Needs at least one approved draft.</span>
          </div>
        </div>
      )}

      {progress?.schedule && (
        <div className="ios-card rounded-xl p-4 text-xs flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="font-semibold text-ink inline-flex items-center gap-1.5">
            <CalendarClock className="w-3.5 h-3.5 text-accent" /> Scheduled
          </span>
          <span className="text-ink-muted">
            Starts {new Date(progress.schedule.startAt).toLocaleString()} ({progress.schedule.timezone})
          </span>
          <span className="text-ink-muted">Batch {progress.schedule.batchSize}</span>
          {progress.schedule.paceMinutes > 0 && <span className="text-ink-muted">Every {progress.schedule.paceMinutes} min</span>}
          {progress.schedule.windowStartHour != null && progress.schedule.windowEndHour != null && (
            <span className="text-ink-muted">
              Window {progress.schedule.windowStartHour}:00–{progress.schedule.windowEndHour}:00
            </span>
          )}
          {progress.schedule.minIntervalSeconds != null && (
            <span className="text-ink-muted">1 message / {progress.schedule.minIntervalSeconds}s per mailbox</span>
          )}
          {progress.schedule.allowedWeekdays && progress.schedule.allowedWeekdays.length < 7 && (
            <span className="text-ink-muted">
              {progress.schedule.allowedWeekdays
                .map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] || d)
                .join(', ')}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Recipients', value: progress?.totalRecipients ?? campaign.stats.totalRecipients },
          { label: 'Sent', value: progress?.sent ?? campaign.stats.sent },
          { label: 'Replies', value: progress?.repliesReceived ?? campaign.repliesReceived ?? 0 },
          { label: 'Failed', value: progress?.failed ?? campaign.stats.failed },
          { label: 'Skipped', value: progress?.skipped ?? campaign.stats.skipped },
        ].map((s) => (
          <div key={s.label} className="ios-card rounded-xl p-4">
            <div className="text-[11px] uppercase tracking-wider text-ink-subtle">{s.label}</div>
            <div className="text-xl font-semibold text-ink tabular-nums mt-1">{s.value}</div>
          </div>
        ))}
      </div>

      <SenderAccountsPanel campaignId={id} legacyMailboxId={campaign.mailboxId} onChanged={refresh} />

      {/* Visual Multi-Step Email Sequence Pipeline */}
      <div className="ios-card rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-accent" />
            <h3 className="text-xs font-semibold text-ink uppercase tracking-wider">
              Visual Sequence Architecture
            </h3>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-ink-muted">
            <span className="flex items-center gap-1 text-success">
              <ShieldCheck className="w-3.5 h-3.5" /> Auto-cancellation on reply active
            </span>
            <span>•</span>
            <span className="text-ink-subtle">Suppression filtering enforced</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 items-center gap-3 py-1">
          {/* Step 1 Node */}
          <div className="p-3.5 rounded-xl border border-line bg-surface-2 space-y-1.5 md:col-span-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-accent uppercase tracking-wider">Step 1</span>
              <span className="px-2 py-0.5 rounded-full bg-accent/10 text-accent text-[10px] font-bold">
                Initial Outreach
              </span>
            </div>
            <div className="font-semibold text-xs text-ink truncate">
              {campaign.steps?.[0]?.subject || 'Pitch & Value Proposition'}
            </div>
            <div className="text-[11px] text-ink-subtle">
              Direct or AI Personalized
            </div>
          </div>

          {/* Transition 1 -> 2 */}
          <div className="flex flex-col items-center justify-center text-center text-xs text-ink-subtle md:col-span-1 py-1">
            <div className="px-2 py-1 rounded-full bg-surface-3 border border-line text-[10px] font-medium text-ink-muted flex items-center gap-1 mb-1">
              Wait {step2Delay} days
            </div>
            <div className="hidden md:flex items-center text-ink-subtle">
              <ArrowRight className="w-4 h-4 text-accent" />
            </div>
          </div>

          {/* Step 2 Node */}
          <div className="p-3.5 rounded-xl border border-line bg-surface-2 space-y-1.5 md:col-span-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-info uppercase tracking-wider">Step 2</span>
              <span className="px-2 py-0.5 rounded-full bg-info/10 text-info text-[10px] font-bold">
                Follow-up
              </span>
            </div>
            <div className="font-semibold text-xs text-ink truncate">
              {campaign.steps?.[1]?.subject || 'Re: Value & Case Study'}
            </div>
            <div className="text-[11px] text-ink-subtle">
              Triggered if no reply
            </div>
          </div>

          {/* Transition 2 -> 3 */}
          <div className="flex flex-col items-center justify-center text-center text-xs text-ink-subtle md:col-span-1 py-1">
            <div className="px-2 py-1 rounded-full bg-surface-3 border border-line text-[10px] font-medium text-ink-muted flex items-center gap-1 mb-1">
              Wait {step3Delay} days
            </div>
            <div className="hidden md:flex items-center text-ink-subtle">
              <ArrowRight className="w-4 h-4 text-accent" />
            </div>
          </div>

          {/* Step 3 Node */}
          <div className="p-3.5 rounded-xl border border-line bg-surface-2 space-y-1.5 md:col-span-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-purple-500 uppercase tracking-wider">Step 3</span>
              <span className="px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-400 text-[10px] font-bold">
                Final Check-in
              </span>
            </div>
            <div className="font-semibold text-xs text-ink truncate">
              {campaign.steps?.[2]?.subject || 'Final Closing Note'}
            </div>
            <div className="text-[11px] text-ink-subtle">
              Closes cadence cleanly
            </div>
          </div>
        </div>
      </div>

      <div className="ios-card rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-ink uppercase tracking-wider">Recipients</h3>
            <span className="badge badge-neutral text-[10px] font-mono tabular-nums">
              {recipientsData?.total ?? 0} total
            </span>
            {isRecipientsFetching && (
              <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
            )}
          </div>

          {/* Search & Status Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none" />
              <input
                type="text"
                placeholder="Search email, company, name…"
                value={recipientSearch}
                onChange={(e) => setRecipientSearch(e.target.value)}
                className="ios-input pl-8 pr-7 py-1 text-xs w-48 sm:w-60"
              />
              {recipientSearch && (
                <button
                  onClick={() => setRecipientSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-subtle hover:text-ink"
                  title="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <select
              value={recipientStatusFilter}
              onChange={(e) => {
                setRecipientStatusFilter(e.target.value);
                setRecipientPage(1);
              }}
              className="ios-select text-xs py-1 px-2.5"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="prepared">Prepared</option>
              <option value="approved">Approved</option>
              <option value="sending">Sending</option>
              <option value="sent">Sent</option>
              <option value="replied">Replied</option>
              <option value="skipped">Skipped</option>
              <option value="failed">Failed</option>
              <option value="suppressed">Suppressed</option>
            </select>
          </div>
        </div>

        {recipients.length === 0 ? (
          <div className="empty-state p-8 text-xs text-center text-ink-muted">
            {debouncedSearch || recipientStatusFilter !== 'all'
              ? 'No recipients match the selected search or status filter.'
              : 'No recipients yet.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-left text-xs">
              <thead className="bg-surface-2 border-b border-line text-ink-subtle font-semibold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="px-5 py-3">Company</th>
                  <th className="px-5 py-3">Recipient</th>
                  <th className="px-5 py-3">Target Topic</th>
                  <th className="px-5 py-3">Sequence Steps (1 / 2 / 3)</th>
                  <th className="px-5 py-3">Recipient Status</th>
                  <th className="px-5 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-ink">
                {recipients.map((r) => {
                  const validEmail = isValidEmailFormat(r.email);

                  return (
                    <tr
                      key={r._id}
                      onClick={() => setSelectedRecipient(r)}
                      className="hover:bg-surface-3 transition-colors cursor-pointer group"
                      title="Click to view full email drafts and sequence timeline"
                    >
                      <td className="px-5 py-3 font-medium align-top">
                        <div className="group-hover:text-brand transition-colors">{r.companyName || '—'}</div>
                        <div className="text-[10px] text-ink-subtle font-mono">Row #{r.rowNumber}</div>
                      </td>
                      <td className="px-5 py-3 align-top">
                        <div className="font-mono text-ink font-medium text-xs group-hover:text-brand transition-colors">
                          {r.email}
                        </div>
                        {r.name && <div className="text-[11px] text-ink-muted">{r.name}</div>}
                        <div className="mt-0.5">
                          {validEmail ? (
                            <span className="text-[10px] text-success font-medium">Valid email</span>
                          ) : (
                            <span className="text-[10px] text-danger font-medium">Invalid / missing email</span>
                          )}
                        </div>
                        {r.assignedAccountEmail && (
                          <div className="text-[10px] text-ink-subtle font-mono" title="Mailbox this recipient is contacted from">
                            via {r.assignedAccountEmail}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top min-w-[190px] max-w-[260px]">
                        {(() => {
                          const evidence = getTargetingEvidence(r);
                          const aiRecommendation = getAiRecommendation(r);
                          const issues = getRecipientValidationIssues(r);
                          const isExpanded = expandedWhy.has(r._id);

                          return (
                            <div className="space-y-1.5">
                              {evidence.topic ? (
                                <div className="text-[11px] font-medium text-ink leading-snug">
                                  {evidence.topic}
                                </div>
                              ) : (
                                <div className="text-[11px] text-ink-subtle italic">
                                  Target topic not provided
                                </div>
                              )}

                              {aiRecommendation && (
                                <div className="text-[10px] text-brand leading-snug">
                                  <span className="font-semibold uppercase tracking-wide mr-1">AI rec</span>
                                  {aiRecommendation}
                                </div>
                              )}

                              {issues.companyNameMismatch && (
                                <div className="flex items-start gap-1 text-[10px] text-danger leading-snug font-medium">
                                  <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0 text-danger" aria-hidden="true" focusable="false" />
                                  <span>Company name mismatch: copy references &ldquo;{issues.companyNameMismatch}&rdquo;. Review before sending.</span>
                                </div>
                              )}

                              {issues.unsupportedIncorporationClaim && (
                                <div className="flex items-start gap-1 text-[10px] text-warning leading-snug">
                                  <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0 text-warning" aria-hidden="true" focusable="false" />
                                  <span>Unsupported incorporation claim: review draft before sending.</span>
                                </div>
                              )}

                              {issues.unsupportedWebsiteClaim && (
                                <div className="flex items-start gap-1 text-[10px] text-warning leading-snug">
                                  <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0 text-warning" aria-hidden="true" focusable="false" />
                                  <span>Unsupported website claim: copy contradicts live HTTP status. Review before sending.</span>
                                </div>
                              )}

                              {issues.personalizationWarning && (
                                <div className="flex items-start gap-1 text-[10px] text-ink-muted leading-snug">
                                  <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-ink-subtle" aria-hidden="true" focusable="false" />
                                  <span>{issues.personalizationWarning}</span>
                                </div>
                              )}

                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleWhy(r._id);
                                }}
                                className="text-[10px] text-brand font-medium inline-flex items-center gap-1 hover:underline"
                                title="Show the source evidence behind this target topic"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-3 h-3" aria-hidden="true" focusable="false" />
                                ) : (
                                  <ChevronRight className="w-3 h-3" aria-hidden="true" focusable="false" />
                                )}
                                <span>Why are we targeting this company?</span>
                              </button>

                              {isExpanded && (
                                <div className="mt-1 rounded-lg border border-line/60 bg-surface-2 p-2 space-y-1.5">
                                  <div className="flex items-center gap-1 text-[10px] text-ink-subtle font-mono">
                                    <Globe className="w-3 h-3" aria-hidden="true" focusable="false" />
                                    <span>{evidence.domain || 'No domain recorded'}</span>
                                  </div>
                                  <div>
                                    <span
                                      className={`badge text-[9px] uppercase font-semibold ${
                                        evidence.audit.statusType === 'success'
                                          ? 'badge-success'
                                          : evidence.audit.statusType === 'warning'
                                          ? 'badge-warning'
                                          : evidence.audit.statusType === 'danger'
                                          ? 'badge-danger'
                                          : 'badge-neutral'
                                      }`}
                                    >
                                      {evidence.audit.headline}
                                    </span>
                                  </div>
                                  <p className="text-[10px] text-ink-muted leading-relaxed">
                                    {evidence.audit.explanation}
                                  </p>
                                  {evidence.rows.length > 0 ? (
                                    <dl className="pt-1.5 border-t border-line/40 space-y-1">
                                      {evidence.rows.map((row) => (
                                        <div key={row.label} className="flex justify-between gap-2 text-[10px]">
                                          <dt className="text-ink-subtle flex-shrink-0">{row.label}</dt>
                                          <dd className="text-ink-muted text-right truncate" title={row.value}>
                                            {row.value}
                                          </dd>
                                        </div>
                                      ))}
                                    </dl>
                                  ) : (
                                    <p className="text-[10px] text-ink-subtle">
                                      No supporting source data recorded for this company.
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-5 py-3 min-w-[280px] max-w-[380px] align-top">
                        <div className="space-y-2">
                          {(campaign.steps || [{ stepIndex: 0, subject: '', bodyText: '', delayDays: 0 }]).map((st) => {
                            const slot = r.stepDrafts?.find((s) => s.stepIndex === st.stepIndex);
                            const isDraftGenerated = !!slot?.draftId;
                            const isApproved = slot?.status === 'approved';
                            const isSent = slot?.status === 'sent';
                            const isFailed = slot?.status === 'failed';
                            const isSkipped = slot?.status === 'skipped';

                            const badgeClass = isSent
                              ? 'badge-success'
                              : isApproved
                              ? 'badge-info'
                              : isDraftGenerated
                              ? 'badge-warning'
                              : isFailed
                              ? 'badge-danger'
                              : isSkipped
                              ? 'badge-neutral'
                              : 'badge-neutral opacity-60';

                            const statusLabel = isSent
                              ? 'Sent'
                              : isApproved
                              ? 'Approved'
                              : isDraftGenerated
                              ? 'Draft'
                              : isFailed
                              ? 'Failed'
                              : isSkipped
                              ? 'Skipped'
                              : 'Not generated';

                            return (
                              <div
                                key={st.stepIndex}
                                className="text-[11px] p-2 rounded-lg bg-surface-2 border border-line/60"
                              >
                                <div className="flex items-center justify-between gap-1.5">
                                  <span className="font-semibold text-ink">
                                    Step {st.stepIndex + 1}
                                    {st.delayDays > 0 && (
                                      <span className="text-[10px] text-ink-subtle font-normal ml-1">
                                        (+{st.delayDays}d)
                                      </span>
                                    )}
                                  </span>
                                  <span className={`badge text-[9px] uppercase font-semibold ${badgeClass}`}>
                                    {statusLabel}
                                  </span>
                                </div>
                                {slot?.draft?.subject ? (
                                  <div
                                    className="text-[10px] text-ink-muted truncate mt-1"
                                    title={slot.draft.subject}
                                  >
                                    {slot.draft.subject}
                                  </div>
                                ) : slot?.error ? (
                                  <div className="text-[10px] text-danger mt-1 leading-snug">
                                    {slot.error}
                                  </div>
                                ) : null}
                                {slot?.sentAt && (
                                  <div className="text-[9px] text-ink-subtle mt-1 font-mono">
                                    Sent: {new Date(slot.sentAt).toLocaleString()}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-5 py-3 max-w-[240px] align-top">
                        <div className="flex items-center gap-1.5">
                          <span className={`badge ${recipientStatusClass(r.status)} uppercase font-semibold`}>
                            {r.status}
                          </span>
                          {r.replied && (
                            <span className="badge badge-success text-[10px] uppercase font-semibold">Replied</span>
                          )}
                        </div>
                        {r.replied && r.replySnippet && (
                          <div className="text-[11px] text-ink-muted italic line-clamp-2 mt-1 bg-surface-2/60 px-2 py-1 rounded border border-line" title={r.replySnippet}>
                            "{r.replySnippet}"
                          </div>
                        )}
                        {r.skipReason && (
                          <div className="text-[11px] text-warning mt-1.5 leading-snug">
                            {r.skipReason}
                          </div>
                        )}
                        {r.lastError && r.lastError !== r.skipReason && (
                          <div className="text-[11px] text-danger mt-1.5 leading-snug">
                            {r.lastError}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right align-top space-x-1.5 whitespace-nowrap">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedRecipient(r);
                          }}
                          className="ios-btn-secondary px-2.5 py-1 text-[11px] font-semibold inline-flex items-center gap-1.5 hover:bg-surface-2"
                          title="Inspect draft, edit copy, and view sequence timeline"
                        >
                          <Eye className="w-3 h-3 text-brand" />
                          Inspect Draft
                        </button>
                        {['skipped', 'failed', 'suppressed'].includes(r.status) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              retryMutation.mutate(r._id);
                            }}
                            disabled={retryMutation.isPending}
                            className="ios-btn-secondary px-2.5 py-1 text-[11px] font-semibold inline-flex items-center gap-1.5 hover:bg-surface-2 disabled:opacity-40"
                            title="Re-validate recipient eligibility and retry"
                          >
                            <RotateCcw className="w-3 h-3" />
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Complete Pagination Footer */}
        {(() => {
          const totalRecords = recipientsData?.total ?? 0;
          const totalPages = recipientsData?.totalPages ?? Math.max(1, Math.ceil(totalRecords / recipientPageSize));
          const startRecord = totalRecords === 0 ? 0 : (recipientPage - 1) * recipientPageSize + 1;
          const endRecord = Math.min(recipientPage * recipientPageSize, totalRecords);

          // Build pagination buttons with ellipses
          const getPageNumbers = () => {
            const delta = 1;
            const range: number[] = [];
            const rangeWithDots: (number | string)[] = [];

            for (let i = 1; i <= totalPages; i++) {
              if (i === 1 || i === totalPages || (i >= recipientPage - delta && i <= recipientPage + delta)) {
                range.push(i);
              }
            }

            let l: number | undefined;
            for (const i of range) {
              if (l !== undefined) {
                if (i - l === 2) {
                  rangeWithDots.push(l + 1);
                } else if (i - l !== 1) {
                  rangeWithDots.push('…');
                }
              }
              rangeWithDots.push(i);
              l = i;
            }
            return rangeWithDots;
          };

          return (
            <div className="p-3.5 border-t border-line bg-surface-2/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-3 text-ink-muted">
                <span>
                  Showing <strong className="text-ink font-mono">{startRecord.toLocaleString()}–{endRecord.toLocaleString()}</strong> of <strong className="text-ink font-mono">{totalRecords.toLocaleString()}</strong> records
                </span>

                <div className="flex items-center gap-1.5 pl-3 border-l border-line">
                  <span className="text-[11px] text-ink-subtle">Rows per page:</span>
                  <select
                    value={recipientPageSize}
                    onChange={(e) => {
                      setRecipientPageSize(Number(e.target.value));
                      setRecipientPage(1);
                    }}
                    className="ios-select py-0.5 px-2 text-xs font-mono"
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                    <option value={200}>200</option>
                  </select>
                </div>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  {/* First Page */}
                  <button
                    onClick={() => setRecipientPage(1)}
                    disabled={recipientPage <= 1}
                    className="p-1 rounded-lg border border-line bg-surface text-ink-subtle hover:text-ink hover:bg-surface-2 disabled:opacity-30 disabled:pointer-events-none"
                    title="First page"
                  >
                    <ChevronsLeft className="w-3.5 h-3.5" />
                  </button>

                  {/* Prev */}
                  <button
                    onClick={() => setRecipientPage((p) => Math.max(1, p - 1))}
                    disabled={recipientPage <= 1}
                    className="ios-btn-secondary px-2 py-1 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Previous</span>
                  </button>

                  {/* Page Numbers */}
                  <div className="flex items-center gap-1 px-1">
                    {getPageNumbers().map((item, idx) => {
                      if (item === '…') {
                        return (
                          <span key={`dots-${idx}`} className="px-1 text-ink-subtle font-mono text-xs">
                            …
                          </span>
                        );
                      }
                      const pageNum = item as number;
                      const isActive = pageNum === recipientPage;
                      return (
                        <button
                          key={pageNum}
                          onClick={() => setRecipientPage(pageNum)}
                          className={`w-7 h-7 rounded-lg text-xs font-semibold transition-all font-mono ${
                            isActive
                              ? 'bg-brand text-white shadow-sm'
                              : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                          }`}
                        >
                          {pageNum}
                        </button>
                      );
                    })}
                  </div>

                  {/* Next */}
                  <button
                    onClick={() => setRecipientPage((p) => Math.min(totalPages, p + 1))}
                    disabled={recipientPage >= totalPages}
                    className="ios-btn-secondary px-2 py-1 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>

                  {/* Last Page */}
                  <button
                    onClick={() => setRecipientPage(totalPages)}
                    disabled={recipientPage >= totalPages}
                    className="p-1 rounded-lg border border-line bg-surface text-ink-subtle hover:text-ink hover:bg-surface-2 disabled:opacity-30 disabled:pointer-events-none"
                    title="Last page"
                  >
                    <ChevronsRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {selectedRecipient && (
        <RecipientDraftInspectorModal
          campaign={campaign}
          recipient={
            recipients.find((x) => x._id === selectedRecipient._id) || selectedRecipient
          }
          isOpen={!!selectedRecipient}
          onClose={() => setSelectedRecipient(null)}
          onUpdated={() => {
            refresh();
          }}
        />
      )}

      {campaign && (
        <ConfirmationModal
          isOpen={showDeleteModal}
          onClose={() => !deleteMutation.isPending && setShowDeleteModal(false)}
          onConfirm={() => deleteMutation.mutate()}
          title="Delete Campaign"
          description={`Are you sure you want to delete "${campaign.name}"?`}
          details={[
            'All campaign recipients and generated email drafts will be removed.',
            'Any pending or scheduled sequence steps will be cancelled immediately.',
            'Companies and contacts in your workspace will NOT be deleted.',
            'This action cannot be undone.',
          ]}
          confirmText={deleteMutation.isPending ? 'Deleting…' : 'Delete Campaign'}
          cancelText="Keep Campaign"
          isDestructive={true}
          isLoading={deleteMutation.isPending}
        />
      )}
    </div>
  );
}

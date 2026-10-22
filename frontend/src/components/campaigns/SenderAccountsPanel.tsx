import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Scale,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import { AllocationResult, CampaignSenderAccount, SenderAccount, SenderQueueAccount } from '../../types';

interface SenderAccountsResponse {
  roster: CampaignSenderAccount[];
  accounts: SenderQueueAccount[];
  legacyMailboxId: string;
}

interface RosterDraft {
  accountId: string;
  enabled: boolean;
  dailySendCap: number;
  maxPerHour: number;
  minIntervalSeconds: number;
  jitterSeconds: number;
}

interface SenderAccountsPanelProps {
  campaignId: string;
  /** The legacy single mailbox of the campaign. */
  legacyMailboxId: string;
  onChanged?: () => void;
}

function formatTime(value?: string): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function defaultDraft(account: SenderAccount): RosterDraft {
  return {
    accountId: account.accountId,
    enabled: true,
    dailySendCap: 100,
    maxPerHour: 60,
    minIntervalSeconds: 60,
    jitterSeconds: 30,
  };
}

/** Human readable label for the machine readable reason of the sender queue. */
const REASON_LABELS: Record<string, string> = {
  ACCOUNT_DISCONNECTED: 'Disconnected',
  ACCOUNT_ERROR: 'Connection error',
  ACCOUNT_PAUSED: 'Paused',
  ACCOUNT_NOT_FOUND: 'Removed',
  MISSING_REFRESH_TOKEN: 'Reconnect required',
  MISSING_SEND_SCOPE: 'Scope missing',
  UNSUPPORTED_PROVIDER: 'Unsupported',
  DAILY_LIMIT_REACHED: 'Daily cap',
  HOURLY_LIMIT_REACHED: 'Hourly cap',
  INTERVAL_NOT_ELAPSED: 'Waiting for slot',
  NO_READY_RECIPIENT: 'Nothing due',
};

function reasonLabel(code?: string, enabled?: boolean): string {
  if (!code) return enabled === false ? 'Paused' : 'Waiting';
  return REASON_LABELS[code] || code.replace(/_/g, ' ').toLowerCase();
}

export function SenderAccountsPanel({ campaignId, legacyMailboxId, onChanged }: SenderAccountsPanelProps) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [drafts, setDrafts] = useState<RosterDraft[]>([]);

  const { data: rosterData, isLoading } = useQuery<SenderAccountsResponse>({
    queryKey: ['campaign-sender-accounts', campaignId],
    queryFn: () => api.get<SenderAccountsResponse>(`/campaigns/${campaignId}/sender-accounts`),
    refetchInterval: 15000,
  });

  const { data: availableAccounts = [] } = useQuery<SenderAccount[]>({
    queryKey: ['campaign-sender-accounts-available'],
    queryFn: () => api.get<SenderAccount[]>('/campaigns/sender-accounts'),
    enabled: showPicker,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['campaign-sender-accounts', campaignId] });
    queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
    queryClient.invalidateQueries({ queryKey: ['campaign-progress', campaignId] });
    onChanged?.();
  };

  const roster = rosterData?.roster ?? [];
  const queue = rosterData?.accounts ?? [];

  // The editable copy of the roster (limits + enabled flag).
  useEffect(() => {
    setDrafts(
      roster.map((entry) => ({
        accountId: entry.accountId,
        enabled: entry.enabled,
        dailySendCap: entry.dailySendCap,
        maxPerHour: entry.maxPerHour,
        minIntervalSeconds: entry.minIntervalSeconds,
        jitterSeconds: entry.jitterSeconds,
      }))
    );
  }, [roster]);

  const saveMutation = useMutation({
    mutationFn: (accounts: RosterDraft[]) =>
      api.put<{ roster: CampaignSenderAccount[] }>(`/campaigns/${campaignId}/sender-accounts`, { accounts }),
    onSuccess: () => {
      setMessage('Sender accounts updated.');
      setShowPicker(false);
      refresh();
    },
    onError: (err: any) => setMessage(err.message),
  });

  const allocateMutation = useMutation({
    mutationFn: (redistribute: boolean) =>
      api.post<AllocationResult>(`/campaigns/${campaignId}/sender-accounts/allocate`, { redistribute }),
    onSuccess: (data) => {
      setMessage(
        `Allocated ${data.newlyAssigned} recipient(s) over the sender accounts` +
          (data.duplicatesSkipped ? `, skipped ${data.duplicatesSkipped} duplicate(s)` : '') +
          (data.orphaned ? `, ${data.orphaned} held back on an unavailable account` : '') +
          '.'
      );
      refresh();
    },
    onError: (err: any) => setMessage(err.message),
  });

  const rebalanceMutation = useMutation({
    mutationFn: () => api.post<AllocationResult>(`/campaigns/${campaignId}/sender-accounts/rebalance`, { balance: true }),
    onSuccess: (data) => {
      setMessage(`Rebalanced ${data.migrated} recipient(s). ${data.lockedRecipients ?? 0} stayed on their mailbox.`);
      refresh();
    },
    onError: (err: any) => setMessage(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ accountId, enabled }: { accountId: string; enabled: boolean }) =>
      api.post(`/campaigns/${campaignId}/sender-accounts/${accountId}/toggle`, { enabled }),
    onSuccess: () => {
      setMessage('Sender account updated.');
      refresh();
    },
    onError: (err: any) => setMessage(err.message),
  });

  const addAccount = (account: SenderAccount) => {
    if (drafts.some((d) => d.accountId === account.accountId)) return;
    setDrafts((current) => [...current, defaultDraft(account)]);
    setShowPicker(false);
  };

  const removeAccount = (accountId: string) => {
    setDrafts((current) => current.filter((d) => d.accountId !== accountId));
  };

  const updateDraft = (accountId: string, patch: Partial<RosterDraft>) => {
    setDrafts((current) => current.map((d) => (d.accountId === accountId ? { ...d, ...patch } : d)));
  };

  const isDirty = useMemo(() => {
    if (drafts.length !== roster.length) return true;
    return drafts.some((draft) => {
      const entry = roster.find((r) => r.accountId === draft.accountId);
      if (!entry) return true;
      return (
        entry.enabled !== draft.enabled ||
        entry.dailySendCap !== draft.dailySendCap ||
        entry.maxPerHour !== draft.maxPerHour ||
        entry.minIntervalSeconds !== draft.minIntervalSeconds ||
        entry.jitterSeconds !== draft.jitterSeconds
      );
    });
  }, [drafts, roster]);

  const totalWaiting = queue.reduce((sum, a) => sum + a.waiting, 0);
  const totalSent = queue.reduce((sum, a) => sum + a.sent, 0);

  return (
    <div className="ios-card rounded-xl p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink inline-flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" /> Sender accounts
          </h3>
          <p className="text-[11px] text-ink-muted mt-1">
            {roster.length === 0
              ? 'This campaign sends from a single mailbox. Add sender accounts to spread the recipients over several inboxes.'
              : `${roster.length} mailbox(es) send this campaign · ${totalWaiting} recipient(s) waiting · ${totalSent} message(s) sent.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {roster.length > 0 && (
            <>
              <button
                onClick={() => allocateMutation.mutate(false)}
                disabled={allocateMutation.isPending}
                className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
              >
                {allocateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Scale className="w-3.5 h-3.5" />}
                Allocate recipients
              </button>
              <button
                onClick={() => rebalanceMutation.mutate()}
                disabled={rebalanceMutation.isPending}
                title="Move recipients that never received a message to a less loaded mailbox (owner/admin only)"
                className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
              >
                {rebalanceMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Rebalance
              </button>
            </>
          )}
          <button
            onClick={() => setShowPicker((v) => !v)}
            className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5"
          >
            {showPicker ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {showPicker ? 'Close' : 'Add mailbox'}
          </button>
        </div>
      </div>

      {message && <div className="text-[11px] text-ink-muted border border-line rounded-lg px-3 py-2">{message}</div>}

      {showPicker && (
        <div className="rounded-lg border border-line bg-surface-2 p-3 space-y-2">
          {availableAccounts.length === 0 ? (
            <p className="text-[11px] text-ink-subtle">No connected mailbox was found for this organization.</p>
          ) : (
            availableAccounts.map((account) => {
              const already = drafts.some((d) => d.accountId === account.accountId);
              return (
                <div key={account.accountId} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-ink font-mono truncate">{account.emailAddress}</p>
                    <p className="text-[10px] text-ink-subtle">
                      {account.authorized
                        ? `${account.provider} · ${account.remainingDailyAllowance}/${account.dailySendLimit} left today`
                        : account.authorization?.reason || 'Not authorized to send'}
                    </p>
                  </div>
                  <button
                    onClick={() => addAccount(account)}
                    disabled={already || !account.authorized}
                    className="ios-btn-secondary px-2.5 py-1 text-[10px] font-semibold disabled:opacity-40"
                  >
                    {already ? 'Added' : 'Add'}
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}

      {isLoading ? (
        <div className="skeleton h-16 rounded-lg" />
      ) : drafts.length === 0 ? (
        <div className="text-[11px] text-ink-subtle flex items-center gap-2">
          <Mail className="w-3.5 h-3.5" />
          Single-mailbox mode — all messages are sent from <span className="font-mono">{legacyMailboxId}</span>.
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.map((draft) => {
            const state = queue.find((q) => q.accountId === draft.accountId);
            const entry = roster.find((r) => r.accountId === draft.accountId);
            const blocked = state && !state.authorized;
            return (
              <div
                key={draft.accountId}
                className="rounded-lg border border-line bg-surface-2 p-3 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-ink font-mono truncate">
                      {entry?.emailAddress || state?.emailAddress || draft.accountId}
                    </p>
                    <p className="text-[10px] text-ink-subtle">
                      {state ? (
                        <>
                          {state.waiting} waiting · {state.sent} sent · {state.sendsToday}/{state.effectiveDailyCap} used today
                        </>
                      ) : (
                        'Not yet part of the roster'
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {state?.ready ? (
                      <span className="badge badge-success text-[10px] font-semibold inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Ready
                      </span>
                    ) : (
                      <span className="badge badge-warning text-[10px] font-semibold inline-flex items-center gap-1">
                        {blocked ? <AlertTriangle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                        {reasonLabel(state?.reasonCode, state?.enabled)}
                      </span>
                    )}
                    <button
                      onClick={() =>
                        toggleMutation.mutate({
                          accountId: draft.accountId,
                          enabled: !(entry?.enabled ?? draft.enabled),
                        })
                      }
                      disabled={!entry || toggleMutation.isPending}
                      title={
                        !entry
                          ? 'Save the roster before pausing or enabling a mailbox'
                          : entry?.enabled === false
                          ? 'Enable this mailbox'
                          : 'Pause this mailbox'
                      }
                      className="ios-btn-secondary px-2 py-1 text-[10px] font-semibold inline-flex items-center gap-1 disabled:opacity-40"
                    >
                      {entry?.enabled === false ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                      {entry?.enabled === false ? 'Enable' : 'Pause'}
                    </button>
                    <button
                      onClick={() => removeAccount(draft.accountId)}
                      title="Remove from this campaign"
                      className="px-2 py-1 text-[10px] font-semibold inline-flex items-center gap-1 rounded-lg border border-danger/30 text-danger hover:bg-danger/10"
                    >
                      <Trash2 className="w-3 h-3" /> Remove
                    </button>
                  </div>
                </div>

                {state?.reason && (
                  <p className="text-[10px] text-ink-subtle">{state.reason}</p>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <label className="text-[10px] text-ink-muted">
                    Daily cap
                    <input
                      type="number"
                      min={0}
                      max={2000}
                      className="input px-2 py-1 text-[11px] mt-0.5"
                      value={draft.dailySendCap}
                      onChange={(e) => updateDraft(draft.accountId, { dailySendCap: Number(e.target.value) })}
                    />
                  </label>
                  <label className="text-[10px] text-ink-muted">
                    Per hour
                    <input
                      type="number"
                      min={0}
                      max={2000}
                      className="input px-2 py-1 text-[11px] mt-0.5"
                      value={draft.maxPerHour}
                      onChange={(e) => updateDraft(draft.accountId, { maxPerHour: Number(e.target.value) })}
                    />
                  </label>
                  <label className="text-[10px] text-ink-muted">
                    Interval (s)
                    <input
                      type="number"
                      min={0}
                      max={86400}
                      className="input px-2 py-1 text-[11px] mt-0.5"
                      value={draft.minIntervalSeconds}
                      onChange={(e) => updateDraft(draft.accountId, { minIntervalSeconds: Number(e.target.value) })}
                    />
                  </label>
                  <label className="text-[10px] text-ink-muted">
                    Jitter (s)
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      className="input px-2 py-1 text-[11px] mt-0.5"
                      value={draft.jitterSeconds}
                      onChange={(e) => updateDraft(draft.accountId, { jitterSeconds: Number(e.target.value) })}
                    />
                  </label>
                </div>

                {state?.nextSendAt && (
                  <p className="text-[10px] text-ink-subtle">Next send at {formatTime(state.nextSendAt)}</p>
                )}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => saveMutation.mutate(drafts)}
              disabled={!isDirty || saveMutation.isPending || drafts.length === 0}
              className="ios-btn-primary px-3 py-1.5 text-[11px] font-semibold disabled:opacity-40"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save limits'}
            </button>
            {isDirty && <span className="text-[10px] text-ink-subtle">Unsaved changes</span>}
          </div>
        </div>
      )}
    </div>
  );
}

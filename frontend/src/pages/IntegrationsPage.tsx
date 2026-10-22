import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Mail,
  Sparkles,
  ShieldCheck,
  RefreshCw,
  LogOut,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  Calendar,
  Video,
  ExternalLink,
  CalendarCheck,
  HelpCircle,
  Copy,
  Check,
} from 'lucide-react';
import { EmailAccount, CalendarAccount, ParsedMeetingResult, CreatedCalendarEvent } from '../types';
import { useAuth } from '../context/AuthContext';
import { ConfirmationModal } from '../components/common/ConfirmationModal';
import { api } from '../lib/api';

export function IntegrationsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [isConfirmDisconnectOpen, setIsConfirmDisconnectOpen] = useState(false);
  const [disconnectTargetEmail, setDisconnectTargetEmail] = useState<string | null>(null);

  const justConnected = searchParams.get('gmail_connected') === 'true';
  const calendarConnected = searchParams.get('calendar_connected');
  const urlError = searchParams.get('error');

  const { data: mailboxes = [] } = useQuery<EmailAccount[]>({
    queryKey: ['mailboxes'],
    queryFn: async () => {
      const res = await fetch('/api/v1/mailboxes', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load mailboxes');
      const json = await res.json();
      return json.data || [];
    },
  });

  const { data: calendarAccounts = [] } = useQuery<CalendarAccount[]>({
    queryKey: ['calendarAccounts'],
    queryFn: async () => {
      const res = await fetch('/api/v1/calendar/accounts', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load calendar accounts');
      const json = await res.json();
      return json.data || [];
    },
  });

  const [meetingPrompt, setMeetingPrompt] = useState('');
  const [isParsingMeeting, setIsParsingMeeting] = useState(false);
  const [parsedMeeting, setParsedMeeting] = useState<ParsedMeetingResult | null>(null);
  const [meetingSummary, setMeetingSummary] = useState('Discovery Call');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('15:00');
  const [meetingDuration, setMeetingDuration] = useState(30);
  const [meetingTimezone, setMeetingTimezone] = useState('Asia/Kolkata');
  const [meetingAttendees, setMeetingAttendees] = useState('');
  const [meetingAddMeet, setMeetingAddMeet] = useState(true);
  const [isCreatingEvent, setIsCreatingEvent] = useState(false);
  const [createdEvent, setCreatedEvent] = useState<CreatedCalendarEvent | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const gmailAccounts = mailboxes.filter((m) => m.provider === 'gmail');
  const gmailAccount = gmailAccounts[0];

  useEffect(() => {
    if (justConnected) {
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      setActionMessage('Gmail connected successfully! Mailbox authorization is active.');
      setTimeout(() => setActionMessage(null), 5000);
    }
  }, [justConnected]);

  useEffect(() => {
    if (calendarConnected) {
      queryClient.invalidateQueries({ queryKey: ['calendarAccounts'] });
      setActionMessage(`Google Calendar connected (${calendarConnected})! You can now generate Google Meet links.`);
      setTimeout(() => setActionMessage(null), 5000);
    }
  }, [calendarConnected]);

  const syncMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch(`/api/v1/integrations/google/gmail/${encodeURIComponent(email)}/sync`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const error = data?.error || {};
        const err: any = new Error(error.message || `Sync failed with status ${res.status}`);
        err.status = res.status;
        err.code = error.code;
        err.requiresReconnect = error.requiresReconnect;
        throw err;
      }
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      setActionMessage(`Inbox synchronized successfully. ${data.data?.syncedCount || 0} threads updated.`);
      setTimeout(() => setActionMessage(null), 5000);
    },
    onError: (err: any) => {
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      if (err.code === 'UNAUTHORIZED' || (err.status === 401 && err.code !== 'GMAIL_REAUTH_REQUIRED')) {
        setActionMessage('Session expired. Please sign in to Swaniki again.');
      } else if (err.code === 'GMAIL_REAUTH_REQUIRED' || err.requiresReconnect) {
        setActionMessage('Gmail authorization expired or revoked. Please reconnect your account.');
      } else {
        setActionMessage(`Sync failed: ${err.message}`);
      }
      setTimeout(() => setActionMessage(null), 6000);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch(`/api/v1/integrations/google/gmail/${encodeURIComponent(email)}/disconnect`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error?.message || 'Disconnect failed');
      }
      return res.json();
    },
    onSuccess: (data, email) => {
      setIsConfirmDisconnectOpen(false);
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      queryClient.removeQueries({ queryKey: ['threads', email] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      const warning = data.data?.revocationWarning;
      if (warning) {
        setActionMessage(`Gmail disconnected and synced mail deleted. Note: ${warning}`);
      } else {
        setActionMessage('Gmail account disconnected, Google OAuth grant revoked, and synced mail data deleted.');
      }
      setTimeout(() => setActionMessage(null), 6000);
      setDisconnectTargetEmail(null);
    },
    onError: (err: any) => {
      setIsConfirmDisconnectOpen(false);
      setActionMessage(`Disconnect failed: ${err.message}`);
      setTimeout(() => setActionMessage(null), 6000);
    },
  });

  const disconnectCalendarMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/v1/calendar/accounts/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to disconnect calendar account');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendarAccounts'] });
      setActionMessage('Google Calendar disconnected.');
      setTimeout(() => setActionMessage(null), 5000);
    },
    onError: (err: any) => {
      setActionMessage(`Calendar disconnect failed: ${err.message}`);
      setTimeout(() => setActionMessage(null), 6000);
    },
  });

  const handleConnectGmail = (email?: string) => {
    const hint = email ? `&email=${encodeURIComponent(email)}` : '';
    window.location.href = `/api/v1/integrations/google/gmail/connect?returnTo=/integrations${hint}`;
  };

  const handleConnectCalendar = () => {
    window.location.href = `/api/v1/calendar/google/connect?returnTo=/integrations`;
  };

  const handleParseMeeting = async () => {
    if (!meetingPrompt.trim()) return;
    setIsParsingMeeting(true);
    setCreatedEvent(null);
    try {
      const res = await api.post<ParsedMeetingResult>('/calendar/parse-meeting', {
        text: meetingPrompt,
        timezone: meetingTimezone,
      });
      setParsedMeeting(res);
      setMeetingSummary(res.parsedDetails.summary);
      setMeetingDuration(res.parsedDetails.durationMinutes);
      setMeetingTimezone(res.parsedDetails.timezone);
      setMeetingAddMeet(res.parsedDetails.addMeetLink);
      if (res.parsedDetails.attendees && res.parsedDetails.attendees.length > 0) {
        setMeetingAttendees(res.parsedDetails.attendees.join(', '));
      }
      if (!meetingDate) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        setMeetingDate(tomorrow.toISOString().split('T')[0]);
      }
    } catch (err: any) {
      setActionMessage(`Failed to parse meeting: ${err.message}`);
      setTimeout(() => setActionMessage(null), 5000);
    } finally {
      setIsParsingMeeting(false);
    }
  };

  const handleCreateMeetingEvent = async () => {
    if (!meetingDate || !meetingTime) {
      setActionMessage('Please specify both meeting date and time.');
      return;
    }
    setIsCreatingEvent(true);
    try {
      const startDateTime = new Date(`${meetingDate}T${meetingTime}:00`);
      const endDateTime = new Date(startDateTime.getTime() + meetingDuration * 60 * 1000);

      const attendees = meetingAttendees
        .split(/[,\s]+/)
        .map((a) => a.trim())
        .filter((a) => a.includes('@'));

      const res = await api.post<CreatedCalendarEvent>('/calendar/events', {
        summary: meetingSummary,
        startTime: startDateTime.toISOString(),
        endTime: endDateTime.toISOString(),
        timezone: meetingTimezone,
        attendees,
        addMeetLink: meetingAddMeet,
      });

      setCreatedEvent(res);
      setActionMessage('Meeting scheduled and Google Meet link created successfully!');
      setTimeout(() => setActionMessage(null), 6000);
    } catch (err: any) {
      setActionMessage(`Failed to schedule meeting: ${err.message}`);
      setTimeout(() => setActionMessage(null), 6000);
    } finally {
      setIsCreatingEvent(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-accent-fg">
            <Mail className="w-4 h-4" />
          </span>
          <span>Integrations & Service Connectors</span>
        </h1>
        <p className="text-xs text-ink-subtle mt-1">
          Decoupled Google Sign-In identity, Gmail API mailbox synchronization, and AI engines.
        </p>
      </div>

      {/* Notifications */}
      {justConnected && (
        <div className="ios-card p-4 rounded-xl bg-success/10 border-success/25 flex items-center gap-3 text-success text-xs">
          <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
          <div>
            <p className="font-semibold text-ink">Gmail Connected Successfully!</p>
            <p className="text-[11px] text-ink-muted mt-0.5">
              Your mailbox has been authorized with AES-256-GCM encrypted tokens. You can now send grounded AI outreach and read threads directly.
            </p>
          </div>
        </div>
      )}

      {urlError && (
        <div className="ios-card p-4 rounded-xl bg-danger/10 border-danger/25 flex items-center gap-3 text-danger text-xs">
          <AlertCircle className="w-5 h-5 text-danger shrink-0" />
          <div>
            <p className="font-semibold text-ink">Integration Error</p>
            <p className="text-[11px] text-ink-muted mt-0.5">{decodeURIComponent(urlError)}</p>
          </div>
        </div>
      )}

      {actionMessage && (
        <div className="ios-card p-3.5 rounded-xl bg-accent/10 border-accent/25 flex items-center gap-3 text-accent text-xs">
          <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
          <span className="font-medium">{actionMessage}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Gmail API Card */}
        <div className="ios-card p-6 rounded-xl bg-surface-2 md:col-span-2 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-xl bg-danger/10 border border-danger/30 flex items-center justify-center text-danger">
                <Mail className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink tracking-tight">Gmail Mailbox Integration</h3>
                  <span className="badge badge-neutral">
                    Decoupled Mailbox Flow
                  </span>
                </div>
                <p className="text-[11px] text-ink-subtle mt-0.5">
                  Official Google Gmail API (v1) with AES-256-GCM token encryption
                </p>
              </div>
            </div>

            {gmailAccount && gmailAccount.status === 'connected' ? (
              <div className="flex items-center gap-2">
                <span className="badge badge-success text-[11px] px-3 py-1">
                  <span className="status-dot" />
                  Connected ({gmailAccount.emailAddress})
                </span>
              </div>
            ) : gmailAccount && (gmailAccount.status === 'error' || gmailAccount.isPaused) ? (
              <div className="flex items-center gap-2">
                <span className="badge badge-danger text-[11px] px-3 py-1">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Reconnection Required
                </span>
                <button
                  type="button"
                  onClick={() => handleConnectGmail(gmailAccount.emailAddress)}
                  className="ios-btn-primary flex items-center justify-center gap-1.5 px-3 py-1 text-xs"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Reconnect</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleConnectGmail()}
                className="ios-btn-primary flex items-center justify-center gap-2 px-4 py-2 text-xs"
              >
                <Mail className="w-4 h-4" />
                <span>Connect Gmail</span>
              </button>
            )}
          </div>

          <div className="text-xs text-ink-muted leading-relaxed bg-surface-2 p-4 rounded-xl border border-line space-y-2">
            <div className="flex items-start gap-2.5 text-ink-muted">
              <KeyRound className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <span>
                <strong className="text-ink">Strict Permission Scope:</strong> Connects via{' '}
                <code className="text-accent font-mono text-[11px] bg-surface-3 px-1.5 py-0.5 rounded">
                  https://www.googleapis.com/auth/gmail.modify
                </code>
                . Refresh tokens are never exposed to the frontend and are authenticated using AES-256-GCM.
              </span>
            </div>
          </div>

          {gmailAccount && (gmailAccount.status === 'error' || gmailAccount.isPaused) && (
            <div className="p-3.5 rounded-xl bg-danger/10 border border-danger/25 flex items-start gap-2.5 text-xs text-danger">
              <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-ink">Gmail Authorization Expired or Revoked</p>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  {gmailAccount.pausedReason || 'Token has been expired or revoked by Google. Reconnect your account to resume thread sync.'}
                </p>
              </div>
            </div>
          )}

          {gmailAccounts.length > 0 && (
            <div className="divider pt-4 space-y-3">
              <div className="text-[10px] font-semibold text-ink-subtle uppercase tracking-wider px-0.5">
                Connected Mailboxes ({gmailAccounts.length})
              </div>
              {gmailAccounts.map((account) => (
                <div
                  key={account.emailAddress}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl bg-surface-2 border border-line"
                >
                  <div className="text-xs space-y-1 min-w-0">
                    <p className="text-ink font-medium truncate">
                      {account.displayName} ({account.emailAddress})
                    </p>
                    <p className="text-[11px] text-ink-subtle tabular-nums">
                      Last Synced: {account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleString() : 'Never'} • Daily Quota: {account.sendsToday}/{account.dailySendLimit} sends
                    </p>
                    {account.syncStatus === 'syncing' && (
                      <p className="text-[11px] text-accent flex items-center gap-1.5">
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        <span>Syncing mailbox…</span>
                      </p>
                    )}
                    {account.syncStatus === 'error' && (
                      <p className="text-[11px] text-danger flex items-center gap-1.5">
                        <AlertCircle className="w-3 h-3" />
                        <span>
                          Last sync failed{account.lastSyncError ? `: ${account.lastSyncError}` : ''}
                        </span>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => syncMutation.mutate(account.emailAddress)}
                      disabled={syncMutation.isPending || account.status === 'error' || account.isPaused}
                      className="ios-btn-secondary px-3.5 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50"
                      title={account.status === 'error' ? 'Reconnection required before sync' : 'Sync threads'}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                      <span>Sync Threads</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDisconnectTargetEmail(account.emailAddress);
                        setIsConfirmDisconnectOpen(true);
                      }}
                      disabled={disconnectMutation.isPending}
                      className="px-3.5 py-1.5 rounded-lg bg-danger/10 hover:bg-danger/20 text-danger text-xs font-medium border border-danger/25 transition-colors disabled:opacity-50 active:scale-95 flex items-center gap-1.5"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Disconnect</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Google Calendar & Google Meet Card */}
        <div className="ios-card p-6 rounded-xl bg-surface-2 md:col-span-2 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-xl bg-accent/10 border border-accent/30 flex items-center justify-center text-accent">
                <Calendar className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink tracking-tight">Google Calendar & Google Meet</h3>
                  <span className="badge badge-neutral">Decoupled Scheduling</span>
                </div>
                <p className="text-[11px] text-ink-subtle mt-0.5">
                  Official Google Calendar API with Google Meet video link generation & natural-language parsing
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleConnectCalendar}
              className="ios-btn-primary flex items-center justify-center gap-2 px-4 py-2 text-xs"
            >
              <Calendar className="w-4 h-4" />
              <span>Connect Google Calendar</span>
            </button>
          </div>

          {/* Connected Calendar Accounts */}
          {calendarAccounts.length > 0 ? (
            <div className="space-y-3">
              <div className="text-[10px] font-semibold text-ink-subtle uppercase tracking-wider px-0.5">
                Connected Calendars ({calendarAccounts.length})
              </div>
              {calendarAccounts.map((account) => (
                <div
                  key={account._id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-surface-3/50 border border-line"
                >
                  <div className="text-xs space-y-1 min-w-0">
                    <p className="text-ink font-semibold flex items-center gap-2">
                      <span>{account.displayName || account.emailAddress}</span>
                      <span className="badge badge-success text-[10px]">
                        <span className="status-dot" /> Connected ({account.provider})
                      </span>
                    </p>
                    <p className="text-[11px] text-ink-subtle tabular-nums">
                      {account.emailAddress} • Scopes: {account.grantedScopes?.join(', ') || 'https://www.googleapis.com/auth/calendar.events'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => disconnectCalendarMutation.mutate(account._id)}
                    disabled={disconnectCalendarMutation.isPending}
                    className="px-3 py-1.5 rounded-lg bg-danger/10 hover:bg-danger/20 text-danger text-xs font-medium border border-danger/25 transition-colors disabled:opacity-50 active:scale-95 flex items-center gap-1.5 shrink-0"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Disconnect</span>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-surface-3/40 border border-line flex items-center gap-3 text-xs text-ink-muted">
              <CalendarCheck className="w-5 h-5 text-accent shrink-0" />
              <div>
                <p className="font-medium text-ink">Ready for Discovery Call Scheduling</p>
                <p className="text-[11px] text-ink-subtle mt-0.5">
                  You can schedule meetings and generate Google Meet video conference links directly. Even without connecting a live Google account, the built-in development simulation engine will generate valid meeting URLs and invites.
                </p>
              </div>
            </div>
          )}

          {/* Natural Language Meeting Scheduler & Clarifier */}
          <div className="p-4 rounded-xl bg-surface-3/40 border border-line space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Video className="w-4 h-4 text-accent" />
                <h4 className="text-xs font-semibold text-ink">Instant Google Meet Scheduler & Ambiguity Assistant</h4>
              </div>
              <span className="text-[10px] text-ink-subtle">Natural language parser with ambiguity detection</span>
            </div>

            <div className="space-y-2">
              <label className="text-[11px] font-medium text-ink-muted flex items-center justify-between">
                <span>Enter Meeting Notes or Natural Language Prompt:</span>
                <span className="text-[10px] text-ink-subtle">e.g., &quot;Tomorrow at 3pm 45min call with rahul@example.com&quot;</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={meetingPrompt}
                  onChange={(e) => setMeetingPrompt(e.target.value)}
                  placeholder="e.g. Schedule a 30m discovery call tomorrow at 3 PM with harsh@technologies.in regarding web portal audit"
                  className="ios-input flex-1 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleParseMeeting();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={handleParseMeeting}
                  disabled={isParsingMeeting || !meetingPrompt.trim()}
                  className="ios-btn-primary px-3.5 py-1.5 text-xs flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${isParsingMeeting ? 'animate-spin' : ''}`} />
                  <span>{isParsingMeeting ? 'Analyzing…' : 'Parse & Clarify'}</span>
                </button>
              </div>
            </div>

            {/* Ambiguity Questions Box */}
            {parsedMeeting?.isAmbiguous && parsedMeeting.clarificationQuestions.length > 0 && (
              <div className="p-3.5 rounded-xl bg-warning/10 border border-warning/30 space-y-2">
                <div className="flex items-center gap-2 text-warning font-semibold text-xs">
                  <HelpCircle className="w-4 h-4 shrink-0" />
                  <span>Ambiguity Detected — Clarification Needed:</span>
                </div>
                <ul className="text-xs text-ink-muted space-y-1 list-disc list-inside pl-1">
                  {parsedMeeting.clarificationQuestions.map((q, i) => (
                    <li key={i} className="leading-snug">{q}</li>
                  ))}
                </ul>
                <p className="text-[11px] text-ink-subtle">
                  Please review and adjust the meeting details below before confirming the invitation.
                </p>
              </div>
            )}

            {/* Meeting Configuration Fields */}
            {(parsedMeeting || meetingDate) && (
              <div className="pt-2 border-t border-line space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  <div>
                    <label className="text-[11px] font-medium text-ink-muted block mb-1">Meeting Title / Topic</label>
                    <input
                      type="text"
                      value={meetingSummary}
                      onChange={(e) => setMeetingSummary(e.target.value)}
                      className="ios-input w-full text-xs"
                      placeholder="e.g. Strategic Discovery Call"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-ink-muted block mb-1">Date</label>
                    <input
                      type="date"
                      value={meetingDate}
                      onChange={(e) => setMeetingDate(e.target.value)}
                      className="ios-input w-full text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-ink-muted block mb-1">Start Time</label>
                    <input
                      type="time"
                      value={meetingTime}
                      onChange={(e) => setMeetingTime(e.target.value)}
                      className="ios-input w-full text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-ink-muted block mb-1">Duration (minutes)</label>
                    <input
                      type="number"
                      value={meetingDuration}
                      onChange={(e) => setMeetingDuration(Number(e.target.value) || 30)}
                      min={10}
                      max={240}
                      className="ios-input w-full text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-ink-muted block mb-1">Timezone</label>
                    <input
                      type="text"
                      value={meetingTimezone}
                      onChange={(e) => setMeetingTimezone(e.target.value)}
                      className="ios-input w-full text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-ink-muted block mb-1">Attendees (comma separated)</label>
                    <input
                      type="text"
                      value={meetingAttendees}
                      onChange={(e) => setMeetingAttendees(e.target.value)}
                      placeholder="client@example.com"
                      className="ios-input w-full text-xs"
                    />
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
                  <label className="flex items-center gap-2 text-xs text-ink cursor-pointer">
                    <input
                      type="checkbox"
                      checked={meetingAddMeet}
                      onChange={(e) => setMeetingAddMeet(e.target.checked)}
                      className="rounded text-accent focus:ring-accent"
                    />
                    <span className="flex items-center gap-1.5 font-medium">
                      <Video className="w-3.5 h-3.5 text-accent" />
                      Generate and attach Google Meet video link
                    </span>
                  </label>

                  <button
                    type="button"
                    onClick={handleCreateMeetingEvent}
                    disabled={isCreatingEvent || !meetingDate || !meetingTime}
                    className="ios-btn-primary px-4 py-2 text-xs flex items-center gap-2 disabled:opacity-50"
                  >
                    <CalendarCheck className={`w-4 h-4 ${isCreatingEvent ? 'animate-spin' : ''}`} />
                    <span>{isCreatingEvent ? 'Scheduling…' : 'Schedule Meeting & Create Meet'}</span>
                  </button>
                </div>
              </div>
            )}

            {/* Created Event Card with Meet Link */}
            {createdEvent && (
              <div className="p-4 rounded-xl bg-success/10 border border-success/30 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-success font-semibold text-xs">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Meeting Scheduled Successfully!</span>
                  </div>
                  <span className="badge badge-neutral text-[10px]">
                    Provider: {createdEvent.provider}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-[11px] text-ink-subtle">Summary:</p>
                    <p className="font-semibold text-ink">{createdEvent.summary}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-ink-subtle">Time:</p>
                    <p className="text-ink">
                      {new Date(createdEvent.startTime).toLocaleString()} ({createdEvent.timezone})
                    </p>
                  </div>
                  {createdEvent.attendees && createdEvent.attendees.length > 0 && (
                    <div className="sm:col-span-2">
                      <p className="text-[11px] text-ink-subtle">Attendees:</p>
                      <p className="text-ink">{createdEvent.attendees.join(', ')}</p>
                    </div>
                  )}
                </div>

                {createdEvent.meetLink && (
                  <div className="p-3 rounded-lg bg-surface-1 border border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Video className="w-4 h-4 text-accent shrink-0" />
                      <a
                        href={createdEvent.meetLink}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-mono text-accent hover:underline truncate"
                      >
                        {createdEvent.meetLink}
                      </a>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(createdEvent.meetLink!);
                          setCopiedLink(true);
                          setTimeout(() => setCopiedLink(false), 2000);
                        }}
                        className="ios-btn-secondary px-2.5 py-1 text-xs flex items-center gap-1.5"
                      >
                        {copiedLink ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedLink ? 'Copied' : 'Copy Link'}</span>
                      </button>
                      <a
                        href={createdEvent.meetLink}
                        target="_blank"
                        rel="noreferrer"
                        className="ios-btn-primary px-3 py-1 text-xs flex items-center gap-1.5"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Join Call</span>
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Google Identity & Auth Card */}
        <div className="ios-card rounded-xl p-5 space-y-4 bg-surface-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/30 flex items-center justify-center text-accent">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-ink tracking-tight">Google Sign-In</h3>
                <p className="text-[11px] text-ink-subtle">User authentication and RBAC session boundary</p>
              </div>
            </div>
            <span className={`badge ${user?.googleSub ? 'badge-success' : 'badge-warning'}`}>
              {user?.googleSub ? 'Google Verified' : 'Dev Sandbox Session'}
            </span>
          </div>
          <p className="text-xs text-ink-muted leading-relaxed">
            Identity is verified via OpenID Connect token signature with user subject key (<code
              className="text-ink font-mono bg-surface-3 px-1 py-0.5 rounded">sub</code>). Sessions are preserved in secure,
            HttpOnly rotated cookies.
          </p>
        </div>

        {/* AI Provider Card */}
        <div className="ios-card rounded-xl p-5 space-y-4 bg-surface-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/30 flex items-center justify-center text-accent">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-ink tracking-tight">AI Language Models</h3>
                <p className="text-[11px] text-ink-subtle">Email studio and opportunity pitch generation</p>
              </div>
            </div>
            <span className="badge badge-info">
              Optional
            </span>
          </div>
          <p className="text-xs text-ink-muted leading-relaxed">
            Connect Google Gemini or OpenAI via server-side environment variables. If unconfigured or
            offline, drafts are composed with a deterministic template fallback.
          </p>
        </div>
      </div>

      {disconnectTargetEmail && (
        <ConfirmationModal
          isOpen={isConfirmDisconnectOpen}
          onClose={() => {
            setIsConfirmDisconnectOpen(false);
            setDisconnectTargetEmail(null);
          }}
          onConfirm={() => disconnectMutation.mutate(disconnectTargetEmail)}
          title="Disconnect Gmail Integration"
          description={`Are you sure you want to disconnect ${disconnectTargetEmail}?`}
          details={[
            'Your Google OAuth grant will be revoked at Google servers (best effort).',
            'Stored access and refresh tokens will be securely deleted.',
            'Synced threads, message bodies, attachments and cached metadata for this mailbox will be deleted.',
            'Background synchronization and scheduled sending will halt.',
            'Your Swaniki session, contacts, and outreach campaigns will remain safe.',
          ]}
          confirmText="Disconnect Gmail"
          cancelText="Cancel"
          isDestructive={true}
          isLoading={disconnectMutation.isPending}
        />
      )}
    </div>
  );
}

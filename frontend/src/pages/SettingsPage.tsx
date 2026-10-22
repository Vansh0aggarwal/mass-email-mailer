import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  LogOut,
  Monitor,
  Moon,
  Shield,
  Sun,
  Trash2,
  Mail,
  Clock,
  Sparkles,
  Sliders,
  AlertCircle,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { ConfirmationModal } from '../components/common/ConfirmationModal';
import { api } from '../lib/api';
import type { Theme } from '../lib/theme';
import type { WorkspaceSettings, EmailAccount } from '../types';

const APPEARANCE_OPTIONS: { value: Theme; label: string; description: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', description: 'Bright surfaces for daytime use', icon: Sun },
  { value: 'dark', label: 'Dark', description: 'Low-light palette that is easy on the eyes', icon: Moon },
  { value: 'system', label: 'System', description: 'Automatically follow your device setting', icon: Monitor },
];

const TONE_OPTIONS = [
  { value: 'consultative', label: 'Consultative', desc: 'Insightful, advisory, problem-solving approach' },
  { value: 'professional', label: 'Professional', desc: 'Direct, clear, executive-ready structure' },
  { value: 'friendly', label: 'Friendly', desc: 'Warm, personable, conversational tone' },
  { value: 'concise', label: 'Concise', desc: 'Ultra-short, high-signal, respecting reader time' },
  { value: 'urgent', label: 'Urgent', desc: 'Time-sensitive performance and competitive benchmark focus' },
];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { logout } = useAuth();

  const [orgId, setOrgId] = useState(localStorage.getItem('radar_org_id') || 'org_dev_swaniki_001');
  const [userId, setUserId] = useState(localStorage.getItem('radar_user_id') || 'usr_dev_master_001');
  const [userRole, setUserRole] = useState(localStorage.getItem('radar_user_role') || 'owner');
  const [tenantSaved, setTenantSaved] = useState(false);

  const [isSignOutOpen, setIsSignOutOpen] = useState(false);
  const [isClearDataOpen, setIsClearDataOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Workspace Sender Settings Form State
  const [senderForm, setSenderForm] = useState<Partial<WorkspaceSettings>>({
    senderDisplayName: 'Vansh Aggarwal',
    businessName: 'Swaniki New Business Radar',
    businessDescription: 'B2B Sales Intelligence, Website Audit & Outreach Modernization',
    authorizedMailbox: '',
    defaultGreeting: 'Hi {{contact_first_name}},',
    missingNameFallback: 'Hello,',
    defaultSignOff: 'Best regards,',
    emailSignature: 'Vansh Aggarwal\nSwaniki New Business Radar\nhttps://swaniki.com',
    contactDetails: 'team@swaniki.com',
    defaultTimezone: 'Asia/Kolkata',
    sendingWindowStartHour: 9,
    sendingWindowEndHour: 18,
    dailySendCap: 100,
    batchSize: 25,
    paceMinutes: 15,
    defaultFollowUpIntervalDays: 3,
    preferredTone: 'consultative',
    preferredLength: 'medium',
    preferredLanguage: 'en',
    defaultServiceOffering: 'Website Modernization',
  });
  const [senderError, setSenderError] = useState('');
  const [senderSuccess, setSenderSuccess] = useState(false);

  // Queries
  const { data: serverSettings } = useQuery<WorkspaceSettings>({
    queryKey: ['workspace-sender-settings'],
    queryFn: () => api.get<WorkspaceSettings>('/settings/sender'),
  });

  const { data: mailboxes = [] } = useQuery<EmailAccount[]>({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<EmailAccount[]>('/mailboxes'),
  });

  useEffect(() => {
    if (serverSettings) {
      setSenderForm((prev) => ({
        ...prev,
        ...serverSettings,
      }));
    }
  }, [serverSettings]);

  const senderMutation = useMutation({
    mutationFn: (data: Partial<WorkspaceSettings>) => api.put<WorkspaceSettings>('/settings/sender', data),
    onSuccess: (updated) => {
      queryClient.setQueryData(['workspace-sender-settings'], updated);
      setSenderError('');
      setSenderSuccess(true);
      setTimeout(() => setSenderSuccess(false), 3000);
    },
    onError: (err: any) => {
      setSenderError(err?.message || 'Failed to update sender settings');
    },
  });

  const handleSenderSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSenderError('');
    senderMutation.mutate(senderForm);
  };

  const handleTenantSave = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('radar_org_id', orgId);
    localStorage.setItem('radar_user_id', userId);
    localStorage.setItem('radar_user_role', userRole);
    setTenantSaved(true);
    setTimeout(() => setTenantSaved(false), 2500);
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    setAuthError(null);
    try {
      await logout();
    } catch (err: any) {
      setAuthError(err?.message || 'Sign out failed. Please try again.');
      setIsSigningOut(false);
      setIsSignOutOpen(false);
    }
  };

  const handleClearData = async () => {
    setIsSigningOut(true);
    setAuthError(null);
    try {
      await logout({ clearMailData: true });
    } catch (err: any) {
      setAuthError(err?.message || 'Could not clear mail data. You are still signed in — please retry.');
      setIsSigningOut(false);
      setIsClearDataOpen(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-accent-fg">
            <Sliders className="w-4 h-4" />
          </span>
          <span>Application &amp; Workspace Settings</span>
        </h1>
        <p className="text-xs text-ink-muted mt-1">
          Configure default sender profiles, outreach rules, authorized connections, and tenant preferences.
        </p>
      </div>

      {/* WORKSPACE SENDER DEFAULTS */}
      <form onSubmit={handleSenderSubmit} className="ios-card rounded-xl p-6 sm:p-7 space-y-6">
        <div className="flex items-center justify-between gap-3 pb-4 border-b border-line">
          <div className="flex items-center gap-2.5">
            <Mail className="w-4 h-4 text-accent" />
            <div>
              <h2 className="text-sm font-semibold text-ink tracking-tight">Workspace Sender Defaults</h2>
              <p className="text-[11px] text-ink-subtle">
                Applies automatically to new campaigns and personalized draft generators.
              </p>
            </div>
          </div>
          {senderSuccess && (
            <span className="text-xs text-success font-semibold flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" /> Saved
            </span>
          )}
        </div>

        {senderError && (
          <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{senderError}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1 px-0.5">
              Sender Display Name <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              required
              value={senderForm.senderDisplayName || ''}
              onChange={(e) => setSenderForm((f) => ({ ...f, senderDisplayName: e.target.value }))}
              placeholder="e.g. Vansh Aggarwal"
              className="input px-3.5 py-2 text-xs"
            />
            <p className="text-[11px] text-ink-subtle mt-1 px-0.5">Never confused with recipient director name</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1 px-0.5">
              Authorized Sending Connection
            </label>
            <select
              value={senderForm.authorizedMailbox || ''}
              onChange={(e) => setSenderForm((f) => ({ ...f, authorizedMailbox: e.target.value }))}
              className="input px-3.5 py-2 text-xs cursor-pointer"
            >
              <option value="">— Select an authorized mailbox —</option>
              {mailboxes.map((m) => (
                <option key={m._id} value={m.emailAddress}>
                  {m.emailAddress} ({m.provider}) {m.status === 'connected' ? '✓' : `(${m.status})`}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-ink-subtle mt-1 px-0.5">Only authorized connections can be selected</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1 px-0.5">
              Business Name <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              required
              value={senderForm.businessName || ''}
              onChange={(e) => setSenderForm((f) => ({ ...f, businessName: e.target.value }))}
              placeholder="e.g. Swaniki New Business Radar"
              className="input px-3.5 py-2 text-xs"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1 px-0.5">
              Approved Business Description
            </label>
            <input
              type="text"
              value={senderForm.businessDescription || ''}
              onChange={(e) => setSenderForm((f) => ({ ...f, businessDescription: e.target.value }))}
              placeholder="e.g. B2B Sales Intelligence & Outreach Consultancy"
              className="input px-3.5 py-2 text-xs"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1 px-0.5">
              Default Greeting Template
            </label>
            <input
              type="text"
              value={senderForm.defaultGreeting || ''}
              onChange={(e) => setSenderForm((f) => ({ ...f, defaultGreeting: e.target.value }))}
              placeholder="Hi {{contact_first_name}},"
              className="input px-3.5 py-2 text-xs font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1 px-0.5">
              Missing-Name Fallback Greeting
            </label>
            <input
              type="text"
              value={senderForm.missingNameFallback || ''}
              onChange={(e) => setSenderForm((f) => ({ ...f, missingNameFallback: e.target.value }))}
              placeholder="Hello,"
              className="input px-3.5 py-2 text-xs"
            />
            <p className="text-[11px] text-ink-subtle mt-1 px-0.5">Used when name is empty or resembles a company entity</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1 px-0.5">
              Default Sign-Off
            </label>
            <input
              type="text"
              value={senderForm.defaultSignOff || ''}
              onChange={(e) => setSenderForm((f) => ({ ...f, defaultSignOff: e.target.value }))}
              placeholder="Best regards,"
              className="input px-3.5 py-2 text-xs"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1 px-0.5">
              Contact Details (Phone / Website)
            </label>
            <input
              type="text"
              value={senderForm.contactDetails || ''}
              onChange={(e) => setSenderForm((f) => ({ ...f, contactDetails: e.target.value }))}
              placeholder="team@swaniki.com | +91 98765 43210"
              className="input px-3.5 py-2 text-xs"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-ink-muted mb-1 px-0.5">
              Email Signature Block
            </label>
            <textarea
              rows={3}
              value={senderForm.emailSignature || ''}
              onChange={(e) => setSenderForm((f) => ({ ...f, emailSignature: e.target.value }))}
              placeholder="Vansh Aggarwal&#10;Founder, Swaniki New Business Radar&#10;https://swaniki.com"
              className="input px-3.5 py-2 text-xs font-mono"
            />
          </div>

          <div className="border-t border-line md:col-span-2 pt-4">
            <h3 className="text-xs font-semibold text-ink flex items-center gap-1.5 mb-3">
              <Clock className="w-3.5 h-3.5 text-accent" />
              <span>Sending Window, Pacing &amp; Guardrails</span>
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-ink-muted mb-1">Default Timezone</label>
                <input
                  type="text"
                  value={senderForm.defaultTimezone || ''}
                  onChange={(e) => setSenderForm((f) => ({ ...f, defaultTimezone: e.target.value }))}
                  placeholder="Asia/Kolkata"
                  className="input px-3 py-1.5 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-ink-muted mb-1">Sending Hours (Local)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={senderForm.sendingWindowStartHour ?? 9}
                    onChange={(e) => setSenderForm((f) => ({ ...f, sendingWindowStartHour: Number(e.target.value) }))}
                    className="input px-2 py-1.5 text-xs w-16 text-center tabular-nums"
                  />
                  <span className="text-xs text-ink-subtle">to</span>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={senderForm.sendingWindowEndHour ?? 18}
                    onChange={(e) => setSenderForm((f) => ({ ...f, sendingWindowEndHour: Number(e.target.value) }))}
                    className="input px-2 py-1.5 text-xs w-16 text-center tabular-nums"
                  />
                  <span className="text-[11px] text-ink-subtle">hrs</span>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-ink-muted mb-1">Daily Send Cap</label>
                <input
                  type="number"
                  min={1}
                  max={2000}
                  value={senderForm.dailySendCap ?? 100}
                  onChange={(e) => setSenderForm((f) => ({ ...f, dailySendCap: Number(e.target.value) }))}
                  className="input px-3 py-1.5 text-xs tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-ink-muted mb-1">Batch Size</label>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={senderForm.batchSize ?? 25}
                  onChange={(e) => setSenderForm((f) => ({ ...f, batchSize: Number(e.target.value) }))}
                  className="input px-3 py-1.5 text-xs tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-ink-muted mb-1">Batch Pacing (Minutes)</label>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={senderForm.paceMinutes ?? 15}
                  onChange={(e) => setSenderForm((f) => ({ ...f, paceMinutes: Number(e.target.value) }))}
                  className="input px-3 py-1.5 text-xs tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-ink-muted mb-1">Follow-up Interval (Days)</label>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={senderForm.defaultFollowUpIntervalDays ?? 3}
                  onChange={(e) => setSenderForm((f) => ({ ...f, defaultFollowUpIntervalDays: Number(e.target.value) }))}
                  className="input px-3 py-1.5 text-xs tabular-nums"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-line md:col-span-2 pt-4">
            <h3 className="text-xs font-semibold text-ink flex items-center gap-1.5 mb-3">
              <Sparkles className="w-3.5 h-3.5 text-accent" />
              <span>Preferred Copy Tone &amp; Offering</span>
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-ink-muted mb-1">Default Email Tone</label>
                <select
                  value={senderForm.preferredTone || 'consultative'}
                  onChange={(e) => setSenderForm((f) => ({ ...f, preferredTone: e.target.value as any }))}
                  className="input px-3 py-1.5 text-xs cursor-pointer"
                >
                  {TONE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label} — {t.desc}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-ink-muted mb-1">Default Service Offering</label>
                <input
                  type="text"
                  value={senderForm.defaultServiceOffering || ''}
                  onChange={(e) => setSenderForm((f) => ({ ...f, defaultServiceOffering: e.target.value }))}
                  placeholder="Website Modernization"
                  className="input px-3 py-1.5 text-xs"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="pt-4 border-t border-line flex items-center justify-between">
          <button
            type="submit"
            disabled={senderMutation.isPending}
            className="ios-btn-primary px-5 py-2 text-xs font-semibold rounded-xl flex items-center gap-2 disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{senderMutation.isPending ? 'Saving...' : 'Save Workspace Sender Defaults'}</span>
          </button>
        </div>
      </form>

      {/* APPEARANCE */}
      <section className="ios-card rounded-xl p-6 sm:p-7 space-y-5">
        <div className="flex items-center justify-between gap-3 pb-4 border-b border-line">
          <div className="flex items-center gap-2.5">
            <Sun className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-semibold text-ink tracking-tight">Appearance</h2>
          </div>
          <span className="text-[11px] text-ink-subtle">
            {theme === 'system' ? `System · ${resolvedTheme}` : theme}
          </span>
        </div>

        <p className="text-xs text-ink-muted">
          Choose how Swaniki looks. Your preference is saved to this browser and applies across every page.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {APPEARANCE_OPTIONS.map(({ value, label, description, icon: Icon }) => {
            const isActive = theme === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                aria-pressed={isActive}
                className={`relative text-left p-4 rounded-xl border transition-all active:scale-[0.98] ${
                  isActive
                    ? 'bg-accent/10 border-accent/40 shadow-card'
                    : 'bg-surface border-line hover:bg-surface-3'
                }`}
              >
                <div className="flex items-center justify-between">
                  <Icon className={`w-4 h-4 ${isActive ? 'text-accent' : 'text-ink-muted'}`} />
                  {isActive && <Check className="w-4 h-4 text-accent" />}
                </div>
                <div className="mt-3 text-xs font-semibold text-ink">{label}</div>
                <div className="mt-0.5 text-[11px] text-ink-subtle leading-relaxed">{description}</div>
              </button>
            );
          })}
        </div>
      </section>

      {/* TENANT CONTEXT & MOCK IDENTITY */}
      <form onSubmit={handleTenantSave} className="ios-card rounded-xl p-6 sm:p-7 space-y-6">
        <div className="flex items-center gap-2.5 pb-4 border-b border-line">
          <Shield className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-ink tracking-tight">Tenant Context &amp; Mock Identity</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">
              Active Organization ID
            </label>
            <input
              type="text"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              className="input px-3.5 py-2 text-xs"
            />
            <p className="text-[11px] text-ink-subtle mt-1 px-0.5">Sent as x-organization-id header to API</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">
              Mock User ID
            </label>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="input px-3.5 py-2 text-xs"
            />
            <p className="text-[11px] text-ink-subtle mt-1 px-0.5">Sent as x-user-id header for attribution</p>
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">
              Simulated User Role
            </label>
            <select
              value={userRole}
              onChange={(e) => setUserRole(e.target.value)}
              className="input px-3.5 py-2 text-xs cursor-pointer"
            >
              <option value="owner" className="bg-surface text-ink">Owner (Full administrative control of workspace)</option>
              <option value="admin" className="bg-surface text-ink">Admin (Configuration &amp; outreach control)</option>
              <option value="manager" className="bg-surface text-ink">Manager (Pipeline triage)</option>
              <option value="sales_rep" className="bg-surface text-ink">Sales Rep (Draft composition &amp; review)</option>
              <option value="viewer" className="bg-surface text-ink">Viewer (Read-only)</option>
            </select>
          </div>
        </div>

        <div className="pt-4 border-t border-line flex flex-wrap items-center justify-between gap-3">
          <button
            type="submit"
            className="ios-btn-primary px-5 py-2 text-xs font-semibold rounded-xl"
          >
            {tenantSaved ? 'Saved Tenant Preferences' : 'Save Settings'}
          </button>
          {tenantSaved && <span className="text-xs text-success font-semibold flex items-center gap-1.5">Updated successfully!</span>}
        </div>
      </form>

      {/* SESSION & DATA CLEANUP */}
      <section className="ios-card rounded-xl p-6 sm:p-7 space-y-5">
        <div className="flex items-center gap-2.5 pb-4 border-b border-line">
          <LogOut className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-ink tracking-tight">Session &amp; Mail Data</h2>
        </div>

        <p className="text-xs text-ink-muted">
          End your Swaniki session, or sign out and permanently remove mail synced from your connected Gmail
          mailboxes.
        </p>

        {authError && (
          <div className="p-3 rounded-xl bg-danger/10 border border-danger/25 text-[11px] text-danger font-medium leading-relaxed">
            {authError}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setIsSignOutOpen(true)}
            disabled={isSigningOut}
            className="ios-btn-secondary px-4 py-2 text-xs font-semibold rounded-xl flex items-center gap-2 disabled:opacity-50 active:scale-95 transition-all"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>

          <button
            type="button"
            onClick={() => setIsClearDataOpen(true)}
            disabled={isSigningOut}
            className="px-4 py-2 rounded-xl bg-danger/10 hover:bg-danger/20 text-danger border border-danger/25 text-xs font-semibold flex items-center gap-2 disabled:opacity-50 active:scale-95 transition-all"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Sign out &amp; clear mail data</span>
          </button>
        </div>
      </section>

      <ConfirmationModal
        isOpen={isSignOutOpen}
        onClose={() => setIsSignOutOpen(false)}
        onConfirm={handleSignOut}
        isLoading={isSigningOut}
        isDestructive={false}
        icon={LogOut}
        title="Sign Out of Swaniki"
        description="Are you sure you want to sign out of Swaniki New Business Radar?"
        details={[
          'Your active Swaniki session will be revoked and all auth cookies cleared.',
          'Protected workspace pages will require authentication to access.',
          'Your connected Gmail authorization and CRM data remain preserved.',
        ]}
        confirmText="Sign Out"
        cancelText="Cancel"
      />

      <ConfirmationModal
        isOpen={isClearDataOpen}
        onClose={() => setIsClearDataOpen(false)}
        onConfirm={handleClearData}
        isLoading={isSigningOut}
        isDestructive={true}
        icon={Trash2}
        title="Sign Out and Clear Mail Data"
        description="This signs you out and permanently deletes the mail synced from your connected Gmail mailboxes."
        details={[
          'All Gmail mailboxes you connected will be disconnected and their Google grants revoked (best effort).',
          'Synced threads, message bodies, attachments, tokens and sync state will be deleted.',
          'Your company accounts, contacts, campaigns, AI drafts and organization data remain intact.',
          'You will need to reconnect and re-authorize Gmail after signing back in.',
        ]}
        confirmText="Sign Out & Clear Data"
        cancelText="Cancel"
      />
    </div>
  );
}

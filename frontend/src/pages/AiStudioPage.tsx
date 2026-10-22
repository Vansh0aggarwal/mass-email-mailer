import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Sparkles,
  Check,
  RefreshCw,
  Send,
  CheckCircle2,
  AlertCircle,
  Mail,
  ShieldAlert,
  Info,
  Sliders,
  FileCheck2,
} from 'lucide-react';
import { EmailAccount } from '../types';

export function AiStudioPage() {
  const [companyName, setCompanyName] = useState('Apex Logistics Corp');
  const [recipientEmail, setRecipientEmail] = useState('elena@apexlogistics.example.com');
  const [recipientName, setRecipientName] = useState('Elena Rostova');
  const [recipientRole, setRecipientRole] = useState('VP of Digital Operations');
  const [service, setService] = useState('Speed Optimization');
  const [valueProposition, setValueProposition] = useState('Achieve sub-second mobile page loads and reduce checkout drop-off');
  const [tone, setTone] = useState<'consultative' | 'professional' | 'concise' | 'friendly' | 'urgent'>('consultative');
  const [senderName, setSenderName] = useState('Vansh Aggarwal');
  const [subject, setSubject] = useState('Strategic Speed Optimization benchmarks & digital architecture for Apex Logistics Corp');
  const [bodyText, setBodyText] = useState(
    `Hi Elena Rostova,\n\nI hope this note finds you well. I have been following Apex Logistics Corp's progress in your market, and wanted to share a few observations regarding your digital architecture and speed optimization.\n\nAs organizations scale, maintaining a frictionless digital experience becomes critical to protecting customer acquisition efficiency, brand positioning, and ongoing pipeline growth.\n\nBased on our analysis and recent benchmarks across peer organizations, three key focus areas stand out:\n• Mobile visitors frequently abandon high-intent workflows when initial page render exceeds 2.5 seconds, directly inflating customer acquisition costs.\n• Core Web Vitals scores serve as decisive ranking factors in search engines while driving 15% to 25% higher on-site conversion rates across commercial funnels.\n• Uncompressed media payloads and unoptimized client-side hydration scripts often introduce noticeable interaction latency during peak customer visits.\n\nStrategic Approach & Roadmap:\nOur engineering team implements code-splitting, modern asset optimization (WebP/AVIF), edge CDN caching, and database query tuning to achieve sub-second response times without disrupting your existing infrastructure. Specifically, our focus would be on helping Apex Logistics Corp achieve sub-second mobile page loads and reduce checkout drop-off.\n\nProjected Impact:\nReduction in visitor bounce rates by 20% to 35% and measurable improvement in organic search visibility.\n\nWould you or a member of your digital leadership team be open to a brief 10 to 15-minute introductory conversation next Tuesday or Thursday? Alternatively, I would be glad to send over a concise 1-page benchmark summary tailored to Apex Logistics Corp for your team's review.\n\nBest regards,\n\nVansh Aggarwal\nStrategic Solutions & Digital Architecture\nSwaniki New Business Radar`
  );
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [status, setStatus] = useState<'draft' | 'approved' | 'sent'>('draft');
  const [selectedMailbox, setSelectedMailbox] = useState<string>('outreach@swaniki.dev');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [draftMetadata, setDraftMetadata] = useState<{
    factsUsed?: string[];
    missingInfo?: string[];
    explanation?: string;
  }>({
    factsUsed: ['Company: Apex Logistics Corp', 'Target Service: Speed Optimization', 'Recipient role: VP of Digital Operations'],
    missingInfo: ['Digital health assessment rating is unrecorded'],
    explanation: 'Enterprise outreach draft composed around verified company facts. Engagement pillars: High-Throughput Mobile Performance & Core Web Vitals.',
  });

  // Fetch available mailboxes (Gmail + Mock)
  const { data: mailboxes = [] } = useQuery<EmailAccount[]>({
    queryKey: ['mailboxes'],
    queryFn: async () => {
      const res = await fetch('/api/v1/mailboxes', { credentials: 'include' });
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    },
  });

  // Generate Draft Mutation
  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v1/drafts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          companyName,
          recipientEmail,
          recipientName: recipientName.trim() || undefined,
          recipientRole: recipientRole.trim() || undefined,
          targetService: service,
          serviceValueProposition: valueProposition.trim() || undefined,
          tone,
          senderName: senderName.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Generation failed');
      }
      return res.json();
    },
    onSuccess: (resData) => {
      const draft = resData.data;
      setCurrentDraftId(draft._id);
      setSubject(draft.subject);
      setBodyText(draft.bodyText);
      setStatus('draft');
      setDraftMetadata({
        factsUsed: draft.factsUsed || [],
        missingInfo: draft.missingInformation || [],
        explanation: draft.recommendationExplanation || 'Grounded draft composed successfully.',
      });
      setToast({ type: 'success', message: 'Draft generated.' });
      setTimeout(() => setToast(null), 5000);
    },
    onError: (err: any) => {
      setToast({ type: 'error', message: err.message });
      setTimeout(() => setToast(null), 6000);
    },
  });

  // Approve Draft Mutation
  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!currentDraftId) {
        // First create/persist draft
        const genRes = await fetch('/api/v1/drafts/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            companyName,
            recipientEmail,
            recipientName: recipientName.trim() || undefined,
            recipientRole: recipientRole.trim() || undefined,
            targetService: service,
            serviceValueProposition: valueProposition.trim() || undefined,
            tone,
            senderName: senderName.trim() || undefined,
          }),
        });
        const genData = await genRes.json();
        const draftId = genData.data._id;
        setCurrentDraftId(draftId);

        // Update with whatever edits the user made in the textarea
        await fetch(`/api/v1/drafts/${draftId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ subject, bodyText }),
        });

        const appRes = await fetch(`/api/v1/drafts/${draftId}/approve`, {
          method: 'POST',
          credentials: 'include',
        });
        return appRes.json();
      } else {
        // Save user edits first
        await fetch(`/api/v1/drafts/${currentDraftId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ subject, bodyText }),
        });

        const appRes = await fetch(`/api/v1/drafts/${currentDraftId}/approve`, {
          method: 'POST',
          credentials: 'include',
        });
        return appRes.json();
      }
    },
    onSuccess: () => {
      setStatus('approved');
      setToast({ type: 'success', message: 'Draft approved. Ready to dispatch.' });
      setTimeout(() => setToast(null), 5000);
    },
    onError: (err: any) => {
      setToast({ type: 'error', message: err.message });
      setTimeout(() => setToast(null), 6000);
    },
  });

  // Send Draft via Pre-flight Pipeline
  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!currentDraftId) throw new Error('Please approve draft first');
      const mailbox = selectedMailbox || mailboxes[0]?.emailAddress || 'outreach@swaniki.dev';
      const idempotencyKey = `idemp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      const res = await fetch(`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          draftId: currentDraftId,
          idempotencyKey,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Send failed');
      }
      return res.json();
    },
    onSuccess: (data) => {
      setStatus('sent');
      const isGmail = mailboxes.find((m) => m.emailAddress === selectedMailbox)?.provider === 'gmail';
      setToast({
        type: 'success',
        message: isGmail
          ? `Outreach dispatched via Gmail API. (Provider ID: ${data.data?.providerMessageId})`
          : 'Outreach sent via mock sandbox provider.',
      });
      setTimeout(() => setToast(null), 6000);
    },
    onError: (err: any) => {
      setToast({ type: 'error', message: `Pipeline blocked send: ${err.message}` });
      setTimeout(() => setToast(null), 7000);
    },
  });

  const activeAccount = mailboxes.find((m) => m.emailAddress === selectedMailbox);
  const isGmail = activeAccount?.provider === 'gmail';

  const wordCount = bodyText.trim().split(/\s+/).filter(Boolean).length;
  const charCount = bodyText.length;

  return (
    <div className="space-y-6 max-w-7xl">
      {/* Page Title & Status Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-accent-fg">
              <Sparkles className="w-4 h-4" />
            </span>
            <span>AI Email Studio</span>
          </h1>
          <p className="text-xs text-ink-muted mt-1">
            Compose, review, and dispatch grounded outreach drafts with a human approval step.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {status === 'draft' && (
            <button
              type="button"
              onClick={() => approveMutation.mutate()}
              disabled={approveMutation.isPending}
              className="px-4 py-2 bg-success text-accent-fg font-semibold rounded-xl text-xs transition-all flex items-center gap-2 hover:opacity-90 disabled:opacity-50 active:scale-95"
            >
              <Check className="w-4 h-4" />
              <span>{approveMutation.isPending ? 'Saving & Approving...' : 'Approve Draft'}</span>
            </button>
          )}

          {status === 'approved' && (
            <div className="flex items-center gap-2.5">
              <span className="badge badge-success px-3 py-1.5">
                <Check className="w-3.5 h-3.5" /> Approved
              </span>
              <button
                type="button"
                onClick={() => sendMutation.mutate()}
                disabled={sendMutation.isPending}
                data-cursor-label="Send now"
                className="ios-btn-primary px-4 py-2 text-xs font-semibold flex items-center gap-2 disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{sendMutation.isPending ? 'Dispatching...' : 'Dispatch via Mailbox'}</span>
              </button>
            </div>
          )}

          {status === 'sent' && (
            <span className="badge badge-info px-3 py-1.5">
              <CheckCircle2 className="w-4 h-4" /> Dispatched
            </span>
          )}
        </div>
      </div>

      {toast && (
        <div
          className={`p-3.5 rounded-xl border flex items-center gap-2.5 text-xs ${
            toast.type === 'success'
              ? 'bg-success/10 border-success/25 text-success'
              : 'bg-danger/10 border-danger/25 text-danger'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-danger shrink-0" />
          )}
          <span className="font-medium">{toast.message}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Generation Controls & Parameters (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="ios-card p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink flex items-center gap-2">
                <Sliders className="w-3.5 h-3.5 text-accent" />
                <span>Outreach Controls</span>
              </h3>
              <span className="ios-pill">Grounded</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Company Name</label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="input px-3 py-2 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Recipient Name</label>
                <input
                  type="text"
                  placeholder="e.g. Elena Rostova"
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  className="input px-3 py-2 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Recipient Role / Title</label>
                <input
                  type="text"
                  placeholder="e.g. VP of Operations"
                  value={recipientRole}
                  onChange={(e) => setRecipientRole(e.target.value)}
                  className="input px-3 py-2 text-xs"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Recipient Email</label>
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  className="input px-3 py-2 text-xs"
                />
              </div>
            </div>

            <div className="space-y-3.5 pt-3 border-t border-line">
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Target Service Offering</label>
                <select
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                  className="input px-3 py-2 text-xs cursor-pointer"
                >
                  <option value="Speed Optimization" className="bg-surface text-ink">Speed Optimization (Core Web Vitals & Sub-Second Latency)</option>
                  <option value="Website Redesign" className="bg-surface text-ink">Website Redesign (Modern Enterprise UI & Conversion Flow)</option>
                  <option value="SEO Optimization" className="bg-surface text-ink">SEO Optimization (Technical Crawl & Semantic Architecture)</option>
                  <option value="Social Media Strategy" className="bg-surface text-ink">Social Media Strategy (B2B Authority & Thought Leadership)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Specific Value Focus / Proposition</label>
                <input
                  type="text"
                  placeholder="e.g. Sub-second mobile checkout and Core Web Vitals"
                  value={valueProposition}
                  onChange={(e) => setValueProposition(e.target.value)}
                  className="input px-3 py-2 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Tone of Voice</label>
                  <select
                    value={tone}
                    onChange={(e) => setTone(e.target.value as any)}
                    className="input px-3 py-2 text-xs cursor-pointer"
                  >
                    <option value="consultative" className="bg-surface text-ink">Consultative (Strategic Advisory)</option>
                    <option value="professional" className="bg-surface text-ink">Professional (Metric-Driven)</option>
                    <option value="concise" className="bg-surface text-ink">Concise (Executive Brief)</option>
                    <option value="friendly" className="bg-surface text-ink">Friendly (Collaborative)</option>
                    <option value="urgent" className="bg-surface text-ink">Urgent (Priority Audit)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Sender Name</label>
                  <input
                    type="text"
                    value={senderName}
                    onChange={(e) => setSenderName(e.target.value)}
                    className="input px-3 py-2 text-xs"
                  />
                </div>
              </div>
            </div>

            {/* Mailbox Selector */}
            <div className="pt-3 border-t border-line">
              <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Outbound Mailbox Provider</label>
              <select
                value={selectedMailbox}
                onChange={(e) => setSelectedMailbox(e.target.value)}
                className="input px-3 py-2 text-xs cursor-pointer"
              >
                {mailboxes.map((mb) => (
                  <option key={mb.emailAddress} value={mb.emailAddress} className="bg-surface text-ink">
                    {mb.emailAddress} ({mb.provider === 'gmail' ? 'Gmail API' : 'Sandbox Mock'})
                  </option>
                ))}
              </select>
              <div className="text-[10px] text-ink-subtle mt-1.5 flex items-center gap-1.5 px-0.5">
                <Mail className="w-3.5 h-3.5 text-accent" />
                <span>{isGmail ? 'Gmail API live dispatch (AES-256-GCM tokens)' : 'Sandbox mock provider (safe simulation)'}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="ios-btn-primary w-full py-2.5 text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {generateMutation.isPending ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" /> Composing draft...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" /> Generate Draft
                </>
              )}
            </button>
          </div>

          {/* Grounding Intelligence Panel */}
          <div className="ios-card p-4 text-xs space-y-3">
            <div className="flex items-center gap-2 font-semibold text-ink">
              <FileCheck2 className="w-4 h-4 text-success" />
              <span>Grounding & Fact Review</span>
            </div>
            <p className="text-[11px] text-ink-muted leading-relaxed">
              {draftMetadata.explanation}
            </p>

            <div className="space-y-1.5 pt-1">
              <span className="text-[10px] uppercase text-ink-subtle block">Verified facts used:</span>
              <div className="flex flex-wrap gap-1.5">
                {(draftMetadata.factsUsed || []).map((f, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-2.5 py-0.5 rounded-full bg-surface-3 text-ink-muted border border-line"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </div>

            {draftMetadata.missingInfo && draftMetadata.missingInfo.length > 0 && (
              <div className="space-y-1 pt-1">
                <span className="text-[10px] uppercase text-warning flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" /> Information not available:
                </span>
                <ul className="text-[10px] text-ink-subtle list-disc list-inside space-y-0.5">
                  {draftMetadata.missingInfo.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Interactive Professional Draft Editor (7 cols) */}
        <div className="lg:col-span-7 ios-card p-5 space-y-4 flex flex-col">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink">
                Draft Editor
              </h3>
              <p className="text-[11px] text-ink-muted mt-0.5">
                Review and edit before approval and dispatch
              </p>
            </div>
            <div className="flex items-center gap-2.5 text-[11px] text-ink-muted bg-surface-2 border border-line px-3 py-1 rounded-full tabular-nums">
              <span>{wordCount} words</span>
              <span>•</span>
              <span>{charCount} chars</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">Subject Line</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="input px-3 py-2 text-xs font-medium"
            />
          </div>

          <div className="flex-1 flex flex-col">
            <label className="block text-xs font-medium text-ink-muted mb-1.5 px-0.5">
              Email Body
            </label>
            <textarea
              rows={18}
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              className="input flex-1 p-4 text-xs text-ink leading-relaxed font-sans min-h-[380px]"
            />
          </div>

          <div className="rounded-xl p-3 bg-warning/10 border border-warning/30 text-[11px] text-warning flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-ink block">Human review required before sending.</span>
              <span className="text-ink-muted">
                Recipients on suppression lists or exceeding mailbox daily limits will be automatically halted.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

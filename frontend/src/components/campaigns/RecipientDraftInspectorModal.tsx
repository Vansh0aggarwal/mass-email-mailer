import { useState, useEffect } from 'react';
import {
  X,
  Sparkles,
  Check,
  Send,
  Mail,
  Clock,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Calendar,
  Save,
  Ban,
  ExternalLink,
  RotateCcw,
  Info,
  Globe,
} from 'lucide-react';
import { api } from '../../lib/api';
import { Campaign, CampaignRecipient } from '../../types';

interface RecipientDraftInspectorModalProps {
  campaign: Campaign;
  recipient: CampaignRecipient;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

function getRecipientCustomField(recipient: CampaignRecipient, keys: string[]): string | undefined {
  const custom = recipient.customFields;
  if (!custom) return undefined;
  const isMap = typeof (custom as any).get === 'function';
  for (const k of keys) {
    if (isMap) {
      const val = (custom as any).get(k);
      if (val !== undefined && val !== null && val !== '') return String(val).trim();
    } else {
      const val = (custom as Record<string, any>)[k];
      if (val !== undefined && val !== null && val !== '') return String(val).trim();
    }
  }
  return undefined;
}

function getAuditAnalysis(websiteStatus?: string, httpCode?: string, techSignal?: string) {
  const code = (httpCode || '').trim();
  const status = (websiteStatus || '').trim().toLowerCase();

  if (code === '408' || code === '504' || status.includes('timeout') || status.includes('timed out')) {
    return {
      statusType: 'warning' as const,
      headline: `Website status unverified (HTTP ${code || 'Timeout'})`,
      explanation:
        'The site timed out or the server could not be reached during the automated audit. Never claim the company lacks a website; state that the server timed out or could not be reached during audit.',
    };
  }
  if (code === '404' || status.includes('not found')) {
    return {
      statusType: 'danger' as const,
      headline: `Audit returned HTTP 404 Not Found`,
      explanation: 'The audit URL was not found on the web server. Verify whether a new domain or landing page is active.',
    };
  }
  if (code.startsWith('2') || status === 'live' || status === 'ok' || status === 'active') {
    return {
      statusType: 'success' as const,
      headline: `Verified live website (HTTP ${code || '200'})`,
      explanation: techSignal ? `Detected tech signal: ${techSignal}` : 'Site was accessible during audit.',
    };
  }
  if (websiteStatus || httpCode) {
    return {
      statusType: 'neutral' as const,
      headline: `Audit status: ${websiteStatus || 'HTTP ' + code}`,
      explanation: techSignal ? `Tech signal: ${techSignal}` : 'Recorded during domain inspection.',
    };
  }
  return {
    statusType: 'neutral' as const,
    headline: 'No automated site audit recorded',
    explanation: 'Audit data was not provided in the uploaded dataset.',
  };
}

export function RecipientDraftInspectorModal({
  campaign,
  recipient,
  isOpen,
  onClose,
  onUpdated,
}: RecipientDraftInspectorModalProps) {
  const steps = campaign.steps || [];
  const defaultStepIndex = steps.length > 0 ? steps[Math.min(recipient.completedSteps, steps.length - 1)].stepIndex : 0;
  const [selectedStepIndex, setSelectedStepIndex] = useState(defaultStepIndex);

  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showTestModal, setShowTestModal] = useState(false);
  const [testEmailAddress, setTestEmailAddress] = useState(campaign.mailboxId || '');
  const [showOriginal, setShowOriginal] = useState(false);

  const activeSlot = recipient.stepDrafts?.find((s) => s.stepIndex === selectedStepIndex);
  const activeDraft = activeSlot?.draft;

  // Sync state whenever selected step or recipient changes
  useEffect(() => {
    if (activeDraft) {
      setSubject(activeDraft.subject || '');
      setBodyText(activeDraft.bodyText || '');
    } else {
      setSubject('');
      setBodyText('');
    }
    setIsDirty(false);
    setStatusMsg(null);
  }, [selectedStepIndex, recipient, activeDraft?._id]);

  if (!isOpen) return null;

  const timezone = campaign.schedule?.timezone || 'UTC';

  const formatScheduleTime = (dateStr?: string | Date) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(d);
    } catch {
      return new Date(dateStr).toLocaleString();
    }
  };

  const handleClose = () => {
    if (isDirty) {
      if (!window.confirm('You have unsaved edits in this draft. Discard changes?')) return;
    }
    onClose();
  };

  const handleStepChange = (newIndex: number) => {
    if (isDirty) {
      if (!window.confirm('You have unsaved edits in this draft. Discard changes and switch step?')) return;
    }
    setSelectedStepIndex(newIndex);
  };

  const handleSave = async () => {
    setBusyAction('save');
    setStatusMsg(null);
    try {
      await api.patch(`/campaigns/${campaign._id}/recipients/${recipient._id}/steps/${selectedStepIndex}`, {
        subject,
        bodyText,
      });
      setIsDirty(false);
      setStatusMsg({ type: 'success', text: 'Draft updated and saved successfully.' });
      onUpdated();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to save draft.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleApprove = async () => {
    setBusyAction('approve');
    setStatusMsg(null);
    try {
      if (isDirty) {
        await api.patch(`/campaigns/${campaign._id}/recipients/${recipient._id}/steps/${selectedStepIndex}`, {
          subject,
          bodyText,
        });
      }
      await api.post(`/campaigns/${campaign._id}/recipients/${recipient._id}/steps/${selectedStepIndex}/approve`, {});
      setIsDirty(false);
      setStatusMsg({ type: 'success', text: 'Step draft approved and marked ready to dispatch.' });
      onUpdated();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to approve draft.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleGenerate = async () => {
    setBusyAction('generate');
    setStatusMsg(null);
    try {
      await api.post(`/campaigns/${campaign._id}/recipients/${recipient._id}/generate`, {});
      setStatusMsg({ type: 'success', text: 'Draft(s) generated successfully from CSV data.' });
      onUpdated();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to generate drafts.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRepair = async () => {
    if (isDirty) {
      if (
        !window.confirm(
          'You have unsaved edits in this draft. Repairing will replace unverified claims in the current draft. Proceed?'
        )
      ) {
        return;
      }
    }
    setBusyAction('repair');
    setStatusMsg(null);
    try {
      await api.post(
        `/campaigns/${campaign._id}/recipients/${recipient._id}/steps/${selectedStepIndex}/repair`,
        {}
      );
      setIsDirty(false);
      setStatusMsg({ type: 'success', text: 'Draft repaired: unverified claims rewritten into neutral verified copy.' });
      onUpdated();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to repair draft claims.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestoreOriginal = async () => {
    if (
      !window.confirm(
        'Restore this step draft back to the original CSV template? Any manual edits will be replaced.'
      )
    ) {
      return;
    }
    setBusyAction('restore');
    setStatusMsg(null);
    try {
      await api.post(
        `/campaigns/${campaign._id}/recipients/${recipient._id}/steps/${selectedStepIndex}/restore-original`,
        {}
      );
      setIsDirty(false);
      setStatusMsg({ type: 'success', text: 'Restored original CSV template successfully.' });
      onUpdated();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to restore original CSV template.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRegeneratePersonalized = async () => {
    if (isDirty) {
      if (
        !window.confirm(
          'You have unsaved edits in this draft. Generating a personalized version will replace your current edits with fresh token values. Proceed?'
        )
      ) {
        return;
      }
    }
    setBusyAction('regenerate_personalized');
    setStatusMsg(null);
    try {
      await api.post(
        `/campaigns/${campaign._id}/recipients/${recipient._id}/steps/${selectedStepIndex}/regenerate`,
        { mode: 'personalized' }
      );
      setIsDirty(false);
      setStatusMsg({ type: 'success', text: 'Generated personalized draft using company/contact data.' });
      onUpdated();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to generate personalized draft.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSendNow = async () => {
    if (!window.confirm(`Send Step ${selectedStepIndex + 1} email immediately to ${recipient.email}?`)) return;
    setBusyAction('send');
    setStatusMsg(null);
    try {
      await api.post(`/campaigns/${campaign._id}/recipients/${recipient._id}/steps/${selectedStepIndex}/send`, {});
      setStatusMsg({ type: 'success', text: `Email dispatched successfully to ${recipient.email} via connected Gmail.` });
      onUpdated();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to send email.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSendTest = async () => {
    setBusyAction('test');
    setStatusMsg(null);
    try {
      await api.post(`/campaigns/${campaign._id}/recipients/${recipient._id}/steps/${selectedStepIndex}/test`, {
        targetEmail: testEmailAddress,
      });
      setShowTestModal(false);
      setStatusMsg({ type: 'success', text: `Test preview email sent to ${testEmailAddress}.` });
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to send test preview.' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelFollowups = async () => {
    if (!window.confirm(`Cancel future follow-up steps for ${recipient.email}?`)) return;
    setBusyAction('cancel_followups');
    setStatusMsg(null);
    try {
      await api.post(`/campaigns/${campaign._id}/recipients/${recipient._id}/cancel-followups`, {});
      setStatusMsg({ type: 'success', text: 'Future follow-up steps cancelled.' });
      onUpdated();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'Failed to cancel follow-ups.' });
    } finally {
      setBusyAction(null);
    }
  };

  const getStepStatusBadge = (slot: typeof activeSlot, _stepIndex?: number) => {
    if (slot?.status === 'sent') return <span className="badge badge-success text-[10px] font-semibold uppercase">Sent</span>;
    if (slot?.status === 'approved') return <span className="badge badge-info text-[10px] font-semibold uppercase">Approved</span>;
    if (slot?.status === 'draft') return <span className="badge badge-warning text-[10px] font-semibold uppercase">Draft ready</span>;
    if (slot?.status === 'failed') return <span className="badge badge-danger text-[10px] font-semibold uppercase">Failed</span>;
    if (slot?.status === 'skipped') return <span className="badge badge-neutral text-[10px] font-semibold uppercase">Skipped</span>;
    if (slot?.draftId) return <span className="badge badge-warning text-[10px] font-semibold uppercase">Draft ready</span>;
    return <span className="badge badge-neutral opacity-60 text-[10px] font-semibold uppercase">Not generated</span>;
  };

  const getDraftSourceBadge = (draft?: typeof activeDraft) => {
    if (!draft) return null;
    if (draft.isManualEdit || draft.generationSource === 'manual_edit') {
      return <span className="badge badge-warning text-[10px] font-semibold uppercase">Manually edited</span>;
    }
    if (draft.generationSource === 'ai_grounded') {
      return <span className="badge badge-info text-[10px] font-semibold uppercase">AI generated</span>;
    }
    if (draft.generationSource === 'personalized_template') {
      return <span className="badge badge-success text-[10px] font-semibold uppercase">Personalized template</span>;
    }
    if (draft.generationSource === 'csv_template') {
      return <span className="badge badge-neutral text-[10px] font-semibold uppercase">Original CSV template</span>;
    }
    return <span className="badge badge-neutral text-[10px] font-semibold uppercase">CSV Draft</span>;
  };

  // Extract CSV evidence
  const proposedDeliverable = getRecipientCustomField(recipient, ['proposed_deliverable', 'Proposed Deliverable', 'deliverable']);
  const sector = getRecipientCustomField(recipient, ['sector', 'Sector', 'industry', 'Industry']);
  const websiteStatus = getRecipientCustomField(recipient, ['website_status', 'Website Status']);
  const httpCode = getRecipientCustomField(recipient, ['http_code', 'HTTP Code', 'Http Code']);
  const siteAuditType = getRecipientCustomField(recipient, ['site_audit_type', 'Site Audit Type']);
  const pageTitle = getRecipientCustomField(recipient, ['page_title', 'Page Title']);
  const primaryTechSignal = getRecipientCustomField(recipient, ['primary_tech_signal', 'Primary Tech Signal']);
  const domain = getRecipientCustomField(recipient, ['domain', 'Domain', 'website_url', 'Website URL']);

  const audit = getAuditAnalysis(websiteStatus, httpCode, primaryTechSignal);

  // Check if current step has CSV template copy
  const stepNumber = steps.findIndex((s) => s.stepIndex === selectedStepIndex) + 1;
  const csvStepSubject = getRecipientCustomField(recipient, [`step_${stepNumber}_subject`, `step_${selectedStepIndex}_subject`]);
  const csvStepBody = getRecipientCustomField(recipient, [`step_${stepNumber}_body`, `step_${selectedStepIndex}_body`]);
  const hasCsvTemplateForStep = Boolean(
    (csvStepSubject && csvStepSubject.trim()) || (csvStepBody && csvStepBody.trim()) || activeDraft?.originalSubject || activeDraft?.originalBodyText
  );

  // Sequence timeline info
  const step1Slot = recipient.stepDrafts?.find((s) => s.stepIndex === 0 || s.stepIndex === steps[0]?.stepIndex);
  const step1Sent = step1Slot?.status === 'sent';
  const step1SentAt = step1Slot?.sentAt;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="ios-card w-full max-w-4xl max-h-[92vh] flex flex-col rounded-2xl shadow-2xl border border-line overflow-hidden bg-surface">
        {/* Header */}
        <div className="p-5 border-b border-line flex items-start justify-between gap-4 bg-surface-2/60">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-ink">
                {recipient.companyName || 'Company Outreach'}
              </h2>
              <span className="badge badge-neutral text-[10px] uppercase font-semibold font-mono">
                Row #{recipient.rowNumber}
              </span>
              {recipient.replied && (
                <span className="badge badge-success text-[10px] uppercase font-semibold">Replied</span>
              )}
            </div>
            <p className="text-xs text-ink-muted mt-1 flex items-center gap-2 font-mono">
              <Mail className="w-3.5 h-3.5 text-ink-subtle" />
              <span className="text-ink font-semibold">{recipient.email}</span>
              {recipient.name && <span className="text-ink-muted font-sans">({recipient.name})</span>}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-2 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Selector Tabs */}
        <div className="flex border-b border-line bg-surface px-5 pt-3 gap-2 overflow-x-auto">
          {steps.map((st, i) => {
            const slot = recipient.stepDrafts?.find((s) => s.stepIndex === st.stepIndex);
            const isSelected = selectedStepIndex === st.stepIndex;
            return (
              <button
                key={st.stepIndex}
                onClick={() => handleStepChange(st.stepIndex)}
                className={`pb-3 px-4 text-xs font-semibold flex items-center gap-2 border-b-2 transition-all ${
                  isSelected
                    ? 'border-brand text-brand'
                    : 'border-transparent text-ink-muted hover:text-ink hover:border-line'
                }`}
              >
                <span>Step {i + 1}</span>
                {st.delayDays > 0 && <span className="text-[10px] opacity-75 font-normal">+{st.delayDays}d</span>}
                {getStepStatusBadge(slot, st.stepIndex)}
              </button>
            );
          })}
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {statusMsg && (
            <div
              className={`p-3.5 rounded-xl border text-xs flex items-center gap-2 ${
                statusMsg.type === 'success'
                  ? 'bg-success/10 border-success/20 text-success'
                  : 'bg-danger/10 border-danger/20 text-danger'
              }`}
            >
              {statusMsg.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              )}
              <span>{statusMsg.text}</span>
            </div>
          )}

          {/* Inbound Reply Banner */}
          {recipient.replied && (
            <div className="rounded-xl border border-success/30 bg-success/10 p-4 space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-success text-white shrink-0 mt-0.5 shadow-sm">
                    <Mail className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-success uppercase tracking-wider">
                        Inbound Reply Received
                      </span>
                      {recipient.repliedAt && (
                        <span className="text-[11px] text-ink-muted flex items-center gap-1 font-mono">
                          <Clock className="w-3 h-3 text-ink-subtle" />
                          {new Date(recipient.repliedAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {recipient.replyFromEmail && (
                      <p className="text-xs text-ink-muted mt-1 font-mono">
                        From: <strong className="text-ink font-medium">{recipient.replyFromEmail}</strong>
                      </p>
                    )}
                    {recipient.replySubject && (
                      <p className="text-xs font-semibold text-ink mt-1">
                        Subject: {recipient.replySubject}
                      </p>
                    )}
                  </div>
                </div>
                {recipient.replyThreadId && (
                  <a
                    href={`/email?email=${encodeURIComponent(campaign.mailboxId)}&threadId=${encodeURIComponent(
                      recipient.replyThreadId
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ios-btn-secondary px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 bg-surface hover:bg-surface-2 border border-line"
                  >
                    <span>View in Inbox</span>
                    <ExternalLink className="w-3.5 h-3.5 text-ink-muted" />
                  </a>
                )}
              </div>
              {recipient.replySnippet && (
                <div className="bg-surface/80 p-3 rounded-lg border border-line text-xs text-ink-muted italic leading-relaxed">
                  "{recipient.replySnippet}"
                </div>
              )}
              <p className="text-[11px] text-ink-subtle flex items-center gap-1.5 pt-1 border-t border-success/15">
                <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                <span>Outreach sequence concluded. Automated follow-up steps have been stopped.</span>
              </p>
            </div>
          )}

          {/* Target Topic: Why are we contacting this company? */}
          <div className="rounded-xl border border-line bg-surface-2/70 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-ink uppercase tracking-wider flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-brand" />
                Why are we contacting this company?
              </h3>
              {proposedDeliverable && (
                <span className="badge badge-info text-[11px] font-semibold">
                  Deliverable: {proposedDeliverable}
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              {/* Pitch Target */}
              <div className="p-3 rounded-lg bg-surface border border-line/60">
                <div className="text-[10px] font-semibold text-ink-muted uppercase">Primary Outreach Topic</div>
                <div className="text-sm font-semibold text-brand mt-1">
                  {proposedDeliverable || 'Custom Growth Outreach'}
                </div>
                <div className="text-[11px] text-ink-subtle mt-1">
                  Sector: <span className="font-medium text-ink-muted">{sector || 'Corporate Services'}</span>
                </div>
              </div>

              {/* Technical / Web Evidence */}
              <div className="p-3 rounded-lg bg-surface border border-line/60 md:col-span-2 space-y-2">
                <div className="flex items-center justify-between text-[10px] font-semibold text-ink-muted uppercase">
                  <span>Verified Website Audit Evidence</span>
                  <span className="font-mono text-ink-subtle flex items-center gap-1">
                    <Globe className="w-3 h-3" />
                    {domain || 'No domain recorded'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`badge ${
                      audit.statusType === 'success'
                        ? 'badge-success'
                        : audit.statusType === 'warning'
                        ? 'badge-warning'
                        : audit.statusType === 'danger'
                        ? 'badge-danger'
                        : 'badge-neutral'
                    } text-[10px] uppercase font-semibold`}
                  >
                    {audit.headline}
                  </span>
                  {siteAuditType && (
                    <span className="text-[11px] text-ink-muted font-mono">
                      Type: {siteAuditType}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  {audit.explanation}
                </p>
                {(pageTitle || primaryTechSignal) && (
                  <div className="pt-2 border-t border-line/40 text-[11px] flex flex-wrap gap-x-4 gap-y-1 text-ink-subtle">
                    {pageTitle && (
                      <span>
                        <strong className="text-ink">Page title:</strong> {pageTitle}
                      </span>
                    )}
                    {primaryTechSignal && (
                      <span>
                        <strong className="text-ink">Tech signal:</strong> {primaryTechSignal}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Missing Step CSV Template Warning */}
          {!hasCsvTemplateForStep && (
            <div className="p-3.5 rounded-xl border border-warning/30 bg-warning/10 text-warning text-xs flex items-center gap-2">
              <Info className="w-4 h-4 flex-shrink-0" />
              <span>
                <strong>No template provided in CSV</strong> for Step {stepNumber}. You can draft a custom follow-up message below or use campaign default templates.
              </span>
            </div>
          )}

          {/* Draft Preview & Editor */}
          {activeDraft ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink">
                    Step {stepNumber} Outreach Message
                  </span>
                  {activeSlot && getStepStatusBadge(activeSlot, selectedStepIndex)}
                  {getDraftSourceBadge(activeDraft)}
                  {isDirty && (
                    <span className="badge badge-warning text-[9px] uppercase font-semibold">Unsaved edits</span>
                  )}
                </div>
                {activeDraft.updatedAt && (
                  <span className="text-[11px] text-ink-subtle flex items-center gap-1 font-mono">
                    <Clock className="w-3 h-3" /> Last saved: {new Date(activeDraft.updatedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>

              {/* Company Name Mismatch Alert */}
              {activeDraft.companyNameMismatch && (
                <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-danger" aria-hidden="true" focusable="false" />
                  <div className="space-y-1">
                    <div className="font-semibold">Company Name Mismatch Detected (Sending Blocked)</div>
                    <p className="leading-relaxed">
                      This draft references &ldquo;<span className="font-semibold underline">{activeDraft.companyNameMismatch}</span>&rdquo;, which conflicts with the recipient company name &ldquo;<span className="font-semibold">{recipient.companyName}</span>&rdquo;. Edit the draft or regenerate to correct before approving or sending.
                    </p>
                  </div>
                </div>
              )}

              {/* Unsupported Claims Alert with One-Click Repair */}
              {activeDraft.unsupportedClaims && activeDraft.unsupportedClaims.length > 0 && (
                <div className="p-3.5 rounded-xl border border-warning/30 bg-warning/10 text-warning text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-warning" aria-hidden="true" focusable="false" />
                    <div className="space-y-1">
                      <div className="font-semibold">Unverified Claims Detected in Draft</div>
                      <ul className="list-disc list-inside space-y-0.5 text-[11px] opacity-90">
                        {activeDraft.unsupportedClaims.map((claim, idx) => (
                          <li key={idx}>{claim}</li>
                        ))}
                      </ul>
                      <p className="text-[11px] text-ink-muted">
                        Review copy or click &ldquo;Repair unverified claims&rdquo; to automatically rewrite into neutral verified wording.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={handleRepair}
                    disabled={!!busyAction || activeSlot?.status === 'sent'}
                    className="ios-btn-secondary px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 bg-surface hover:bg-surface-2 border border-warning/40 text-warning hover:text-warning"
                    title="Rewrite unsupported claims into neutral verified wording"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" focusable="false" />
                    <span>{busyAction === 'repair' ? 'Repairing…' : 'Repair unverified claims'}</span>
                  </button>
                </div>
              )}

              {/* Subject Field */}
              <div>
                <label className="block text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-1">
                  Subject Line
                </label>
                <input
                  type="text"
                  className="input px-3 py-2 text-xs w-full font-medium"
                  value={subject}
                  disabled={activeSlot?.status === 'sent'}
                  onChange={(e) => {
                    setSubject(e.target.value);
                    setIsDirty(true);
                  }}
                  placeholder="Subject line..."
                />
              </div>

              {/* Body Text Field */}
              <div>
                <label className="block text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-1">
                  Email Body
                </label>
                <textarea
                  rows={9}
                  className="input px-3 py-2 text-xs w-full font-sans leading-relaxed resize-y"
                  value={bodyText}
                  disabled={activeSlot?.status === 'sent'}
                  onChange={(e) => {
                    setBodyText(e.target.value);
                    setIsDirty(true);
                  }}
                  placeholder="Email body text..."
                />
              </div>

              {/* Original CSV Copy toggle */}
              {activeDraft.originalSubject || activeDraft.originalBodyText ? (
                <div className="border border-line/60 rounded-xl p-3 bg-surface-2 text-xs">
                  <button
                    onClick={() => setShowOriginal((v) => !v)}
                    className="text-[11px] font-semibold text-ink-muted hover:text-ink flex items-center gap-1.5"
                  >
                    <span>{showOriginal ? 'Hide' : 'View'} original imported CSV copy</span>
                  </button>
                  {showOriginal && (
                    <div className="mt-3 space-y-2 pt-2 border-t border-line/40 text-[11px] text-ink-muted">
                      <div>
                        <span className="font-semibold text-ink">Original Subject: </span>
                        {activeDraft.originalSubject || '—'}
                      </div>
                      <div>
                        <span className="font-semibold text-ink">Original Body: </span>
                        <pre className="whitespace-pre-wrap font-sans mt-1 p-2 rounded bg-surface border border-line/40">
                          {activeDraft.originalBodyText || '—'}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              {/* Error / Provider Message Info */}
              {activeSlot?.providerMessageId && (
                <div className="text-[11px] text-success font-mono bg-success/10 border border-success/20 p-2.5 rounded-xl">
                  Dispatched via Gmail API • Message ID: {activeSlot.providerMessageId}
                </div>
              )}
              {activeSlot?.error && (
                <div className="text-[11px] text-danger bg-danger/10 border border-danger/20 p-2.5 rounded-xl">
                  {activeSlot.error}
                </div>
              )}

              {/* Actions Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleSave}
                    disabled={!isDirty || !!busyAction || activeSlot?.status === 'sent'}
                    className="ios-btn-primary px-3.5 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
                  >
                    <Save className="w-3.5 h-3.5" aria-hidden="true" focusable="false" />
                    <span>{busyAction === 'save' ? 'Saving…' : 'Save draft'}</span>
                  </button>
                  <button
                    onClick={handleApprove}
                    disabled={!!busyAction || activeSlot?.status === 'sent' || activeSlot?.status === 'approved'}
                    className="ios-btn-secondary px-3.5 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
                  >
                    <Check className="w-3.5 h-3.5" aria-hidden="true" focusable="false" />
                    <span>{busyAction === 'approve' ? 'Approving…' : 'Approve draft'}</span>
                  </button>
                  {activeDraft.unsupportedClaims && activeDraft.unsupportedClaims.length > 0 && (
                    <button
                      onClick={handleRepair}
                      disabled={!!busyAction || activeSlot?.status === 'sent'}
                      className="ios-btn-secondary px-3.5 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 text-warning border-warning/40 hover:bg-warning/10"
                      title="Rewrite unverified claims into neutral verified wording"
                    >
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" focusable="false" />
                      <span>{busyAction === 'repair' ? 'Repairing…' : 'Repair unverified claims'}</span>
                    </button>
                  )}
                  <button
                    onClick={handleRegeneratePersonalized}
                    disabled={!!busyAction || activeSlot?.status === 'sent'}
                    className="ios-btn-secondary px-3.5 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40"
                    title="Generate personalized version using CSV columns"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" focusable="false" />
                    <span>{busyAction === 'regenerate_personalized' ? 'Personalizing…' : 'Personalize template'}</span>
                  </button>
                  {(activeDraft.originalSubject || activeDraft.originalBodyText) && (
                    <button
                      onClick={handleRestoreOriginal}
                      disabled={!!busyAction || activeSlot?.status === 'sent'}
                      className="ios-btn-secondary px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 text-ink-muted hover:text-ink"
                      title="Revert subject and body back to unmodified CSV text"
                    >
                      <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" focusable="false" />
                      <span>{busyAction === 'restore' ? 'Restoring…' : 'Restore original CSV'}</span>
                    </button>
                  )}
                  <button
                    onClick={() => setShowTestModal(true)}
                    disabled={!!busyAction}
                    className="ios-btn-secondary px-3.5 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" focusable="false" />
                    <span>Send test preview</span>
                  </button>
                </div>

                {activeSlot?.status === 'approved' && (
                  <button
                    onClick={handleSendNow}
                    disabled={!!busyAction}
                    className="bg-brand text-white px-4 py-1.5 text-xs font-semibold rounded-xl inline-flex items-center gap-1.5 shadow-sm hover:brightness-105 disabled:opacity-40"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {busyAction === 'send' ? 'Sending…' : 'Send email now'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* Missing Draft State */
            <div className="ios-card rounded-xl p-8 text-center border-dashed border-line space-y-3 bg-surface-2/40">
              <AlertTriangle className="w-8 h-8 text-warning mx-auto opacity-80" />
              <h3 className="text-sm font-semibold text-ink">Draft Not Generated Yet</h3>
              <p className="text-xs text-ink-muted max-w-md mx-auto leading-relaxed">
                Step {stepNumber} email has not been generated for this recipient.
                Click below to materialize the draft from your imported CSV row columns or AI prompt.
              </p>
              <button
                onClick={handleGenerate}
                disabled={!!busyAction}
                className="ios-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-2 mt-2"
              >
                <Sparkles className="w-4 h-4" />
                {busyAction === 'generate' ? 'Generating…' : 'Generate drafts now'}
              </button>
            </div>
          )}

          {/* Sequence Timeline & Automatic Follow-up Schedule (Section 4) */}
          <div className="pt-4 border-t border-line space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-ink uppercase tracking-wider flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-brand" />
                  Sequence Timeline &amp; Follow-up Schedule
                </h3>
                <p className="text-[11px] text-ink-subtle mt-0.5 font-mono">
                  All times shown in organization timezone: <span className="font-semibold text-ink-muted">{timezone}</span>
                </p>
              </div>
              <button
                onClick={handleCancelFollowups}
                disabled={!!busyAction || recipient.status === 'replied' || recipient.status === 'sent'}
                className="text-[11px] text-danger hover:bg-danger/10 px-2.5 py-1 rounded-lg border border-danger/30 font-semibold inline-flex items-center gap-1 disabled:opacity-40"
                title="Cancel all future follow-up steps for this recipient"
              >
                <Ban className="w-3 h-3" />
                Cancel follow-ups
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-surface-2 border-b border-line text-[11px] font-semibold text-ink-muted">
                    <th className="px-4 py-2.5">Step</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Scheduled / Sent Time</th>
                    <th className="px-4 py-2.5">Follow-up Rule &amp; Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/60 bg-surface">
                  {steps.map((st, i) => {
                    const slot = recipient.stepDrafts?.find((s) => s.stepIndex === st.stepIndex);
                    const isSent = slot?.status === 'sent';
                    const isSkipped = slot?.status === 'skipped';

                    let timeDisplay = '—';
                    let detailsDisplay = '';

                    if (i === 0) {
                      // Step 1
                      if (isSent) {
                        timeDisplay = formatScheduleTime(slot?.sentAt) || 'Sent';
                        detailsDisplay = 'Sent through connected Gmail';
                      } else {
                        timeDisplay = 'Immediate on send';
                        detailsDisplay = 'Initial outreach message';
                      }
                    } else if (i === 1) {
                      // Step 2
                      if (isSent) {
                        timeDisplay = formatScheduleTime(slot?.sentAt) || 'Sent';
                        detailsDisplay = `Sent (${st.delayDays}d after Step 1)`;
                      } else if (isSkipped) {
                        timeDisplay = 'Cancelled';
                        detailsDisplay = slot?.error || 'Follow-up cancelled';
                      } else if (slot?.scheduledAt) {
                        timeDisplay = formatScheduleTime(slot.scheduledAt) || 'Scheduled';
                        detailsDisplay = `Confirmed: ${st.delayDays} days after Step 1 send`;
                      } else if (step1Sent && step1SentAt) {
                        const est = new Date(new Date(step1SentAt).getTime() + (st.delayDays || 0) * 24 * 60 * 60 * 1000);
                        timeDisplay = `~${formatScheduleTime(est)} (Est.)`;
                        detailsDisplay = `Due ${st.delayDays} days after Step 1`;
                      } else {
                        timeDisplay = 'Not scheduled';
                        detailsDisplay = `Waiting for Step 1 send (+${st.delayDays}d delay)`;
                      }
                    } else {
                      // Step 3
                      const step2Slot = recipient.stepDrafts?.find((s) => s.stepIndex === steps[1]?.stepIndex);
                      const step2Sent = step2Slot?.status === 'sent';
                      const step2SentAt = step2Slot?.sentAt;

                      if (isSent) {
                        timeDisplay = formatScheduleTime(slot?.sentAt) || 'Sent';
                        detailsDisplay = `Sent (${st.delayDays}d after Step 2)`;
                      } else if (isSkipped) {
                        timeDisplay = 'Cancelled';
                        detailsDisplay = slot?.error || 'Follow-up cancelled';
                      } else if (slot?.scheduledAt) {
                        timeDisplay = formatScheduleTime(slot.scheduledAt) || 'Scheduled';
                        detailsDisplay = `Confirmed: ${st.delayDays} days after Step 2 send`;
                      } else if (step2Sent && step2SentAt) {
                        const est = new Date(new Date(step2SentAt).getTime() + (st.delayDays || 0) * 24 * 60 * 60 * 1000);
                        timeDisplay = `~${formatScheduleTime(est)} (Est.)`;
                        detailsDisplay = `Due ${st.delayDays} days after Step 2`;
                      } else if (step1Sent && step1SentAt) {
                        const step2Delay = steps[1]?.delayDays || 0;
                        const est = new Date(
                          new Date(step1SentAt).getTime() + (step2Delay + (st.delayDays || 0)) * 24 * 60 * 60 * 1000
                        );
                        timeDisplay = `~${formatScheduleTime(est)} (Est.)`;
                        detailsDisplay = `Calculated estimate: ${st.delayDays}d after Step 2`;
                      } else {
                        timeDisplay = 'Not scheduled';
                        detailsDisplay = `Waiting for previous steps (+${st.delayDays}d delay)`;
                      }
                    }

                    return (
                      <tr key={st.stepIndex} className="hover:bg-surface-2/40">
                        <td className="px-4 py-2.5 font-semibold text-ink">
                          Step {i + 1}
                        </td>
                        <td className="px-4 py-2.5">
                          {getStepStatusBadge(slot, st.stepIndex)}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[11px] text-ink">
                          {timeDisplay}
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-ink-muted">
                          {detailsDisplay}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Send Test Email Modal */}
        {showTestModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/60 backdrop-blur-sm">
            <div className="ios-card w-full max-w-md p-5 rounded-2xl border border-line bg-surface shadow-2xl space-y-4">
              <h3 className="text-sm font-semibold text-ink">Send Test Preview</h3>
              <p className="text-xs text-ink-muted">
                Deliver a rendered preview of Step {stepNumber} to your inbox with subject prefix [TEST PREVIEW].
              </p>
              <div>
                <label className="block text-[11px] font-semibold text-ink-muted uppercase mb-1">
                  Recipient Email
                </label>
                <input
                  type="email"
                  className="input px-3 py-2 text-xs w-full font-mono"
                  value={testEmailAddress}
                  onChange={(e) => setTestEmailAddress(e.target.value)}
                  placeholder="your.email@example.com"
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowTestModal(false)}
                  className="ios-btn-secondary px-3 py-1.5 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSendTest}
                  disabled={!testEmailAddress || !!busyAction}
                  className="ios-btn-primary px-3.5 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  {busyAction === 'test' ? 'Sending…' : 'Send preview'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

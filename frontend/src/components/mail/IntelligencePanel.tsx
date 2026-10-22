import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  Globe,
  Users,
  X,
  ExternalLink,
  Calendar,
  Sparkles,
  CheckCircle2,
  Copy,
  Check,
  RefreshCw,
  Lightbulb,
  ArrowRight,
  ShieldAlert,
  Clock,
  Send,
} from 'lucide-react';
import { api } from '../../lib/api';
import type { Company } from '../../types';
import type { MailThread } from '../../lib/mail';
import { formatFullDate } from '../../lib/mail';

interface CompanyDetail extends Company {
  contacts?: { _id: string; fullName?: string; email: string; role?: string }[];
  assessments?: { _id: string; assessmentDate: string }[];
}

interface CopilotResponse {
  summary: string;
  actionItems: string[];
  suggestedNextSteps: string[];
  sentiment: string;
  draftReply: {
    subject: string;
    bodyText: string;
    tone: string;
  };
  opportunityContext?: {
    companyName?: string;
    industry?: string;
    rating?: string;
    deliverable?: string;
    technicalSignal?: string;
    websiteCondition?: string;
  };
  warnings: string[];
}

interface IntelligencePanelProps {
  thread?: MailThread;
  onOpenCompany?: (companyId: string) => void;
  onClose: () => void;
  onInsertDraft?: (text: string) => void;
}

export function IntelligencePanel({
  thread,
  onOpenCompany,
  onClose,
  onInsertDraft,
}: IntelligencePanelProps) {
  const [activeTab, setActiveTab] = useState<'copilot' | 'crm' | 'activity'>('copilot');
  const [tone, setTone] = useState<'consultative' | 'direct' | 'friendly' | 'formal' | 'urgent'>('consultative');
  const [copied, setCopied] = useState(false);

  const companyId = thread?.companyId;

  const { data: company, isLoading: companyLoading } = useQuery<CompanyDetail>({
    queryKey: ['company', companyId],
    queryFn: () => api.get<CompanyDetail>(`/companies/${companyId}`),
    enabled: !!companyId,
  });

  const {
    data: copilotData,
    isLoading: copilotLoading,
    refetch: refetchCopilot,
  } = useQuery<CopilotResponse>({
    queryKey: ['copilot', thread?.mailboxEmail, thread?.threadId, tone],
    queryFn: () =>
      api.post<CopilotResponse>(
        `/mailboxes/${encodeURIComponent(thread?.mailboxEmail || '')}/threads/${encodeURIComponent(thread?.threadId || '')}/copilot`,
        { tone }
      ),
    enabled: !!thread?.threadId && !!thread?.mailboxEmail,
  });

  const handleCopyDraft = () => {
    if (copilotData?.draftReply?.bodyText) {
      navigator.clipboard.writeText(copilotData.draftReply.bodyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleUseDraft = () => {
    if (copilotData?.draftReply?.bodyText && onInsertDraft) {
      onInsertDraft(copilotData.draftReply.bodyText);
    } else {
      handleCopyDraft();
    }
  };

  const firstDate = thread?.messages?.[0]?.date;

  return (
    <aside className="flex flex-col h-full w-full bg-surface-2 border-l border-line text-xs select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-line bg-surface">
        <div className="flex items-center gap-1 font-semibold">
          <button
            onClick={() => setActiveTab('copilot')}
            className={`px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1.5 ${
              activeTab === 'copilot'
                ? 'bg-accent/10 text-accent font-bold'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Copilot
          </button>
          <button
            onClick={() => setActiveTab('crm')}
            className={`px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1.5 ${
              activeTab === 'crm'
                ? 'bg-accent/10 text-accent font-bold'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            CRM
          </button>
          <button
            onClick={() => setActiveTab('activity')}
            className={`px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1.5 ${
              activeTab === 'activity'
                ? 'bg-accent/10 text-accent font-bold'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            Activity
          </button>
        </div>

        <button
          onClick={onClose}
          className="p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-3 transition-colors"
          aria-label="Close context panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {!thread ? (
        <div className="p-6 text-center text-ink-subtle">Select a conversation to see context.</div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
          {/* TAB 1: COPILOT */}
          {activeTab === 'copilot' && (
            <div className="space-y-4">
              {copilotLoading ? (
                <div className="py-8 text-center text-ink-subtle flex flex-col items-center gap-2">
                  <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                  Generating grounded conversation summary...
                </div>
              ) : copilotData ? (
                <>
                  {/* Summary */}
                  <div className="rounded-xl border border-line bg-surface p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-accent uppercase tracking-wider flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        Executive Summary
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] uppercase font-semibold text-ink-muted">
                        {copilotData.sentiment}
                      </span>
                    </div>
                    <p className="text-ink-muted leading-relaxed text-[11px]">{copilotData.summary}</p>
                  </div>

                  {/* Action Items */}
                  {copilotData.actionItems.length > 0 && (
                    <div className="rounded-xl border border-line bg-surface p-3 space-y-2">
                      <span className="text-[10px] font-bold text-ink-subtle uppercase tracking-wider flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3 text-success" />
                        Action Items
                      </span>
                      <ul className="space-y-1.5 text-[11px] text-ink-muted">
                        {copilotData.actionItems.map((item, idx) => (
                          <li key={idx} className="flex items-start gap-1.5">
                            <span className="text-accent font-bold mt-0.5">•</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Suggested Next Steps */}
                  {copilotData.suggestedNextSteps.length > 0 && (
                    <div className="rounded-xl border border-line bg-surface p-3 space-y-2">
                      <span className="text-[10px] font-bold text-ink-subtle uppercase tracking-wider flex items-center gap-1">
                        <Lightbulb className="w-3 h-3 text-warning" />
                        Recommended Next Step
                      </span>
                      <ul className="space-y-1.5 text-[11px] text-ink-muted">
                        {copilotData.suggestedNextSteps.map((step, idx) => (
                          <li key={idx} className="flex items-start gap-1.5">
                            <ArrowRight className="w-3 h-3 text-warning shrink-0 mt-0.5" />
                            <span>{step}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Contextual Reply Drafter */}
                  <div className="rounded-xl border border-line bg-surface p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-ink-subtle uppercase tracking-wider flex items-center gap-1">
                        <Send className="w-3 h-3 text-accent" />
                        Contextual Reply Draft
                      </span>
                      <button
                        onClick={() => refetchCopilot()}
                        className="p-1 rounded text-ink-subtle hover:text-ink hover:bg-surface-2 transition-colors"
                        title="Regenerate"
                      >
                        <RefreshCw className="w-3 h-3" />
                      </button>
                    </div>

                    {/* Tone Selector */}
                    <div className="flex flex-wrap gap-1">
                      {(['consultative', 'direct', 'friendly', 'formal', 'urgent'] as const).map((t) => (
                        <button
                          key={t}
                          onClick={() => setTone(t)}
                          className={`px-2 py-0.5 rounded-md text-[10px] font-medium capitalize transition-colors ${
                            tone === t
                              ? 'bg-accent text-accent-fg'
                              : 'bg-surface-2 hover:bg-surface-3 text-ink-muted'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>

                    {/* Draft Body */}
                    <div className="rounded-lg bg-surface-2 p-2.5 text-[11px] text-ink whitespace-pre-wrap font-sans border border-line/60 max-h-48 overflow-y-auto leading-relaxed">
                      {copilotData.draftReply?.bodyText}
                    </div>

                    {/* Preflight Warnings */}
                    {copilotData.warnings.length > 0 && (
                      <div className="p-2 rounded-lg bg-warning/10 border border-warning/20 text-warning text-[10px] flex items-start gap-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{copilotData.warnings.join(' ')}</span>
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={handleCopyDraft}
                        className="flex-1 py-1.5 px-2 rounded-lg border border-line hover:bg-surface-3 text-[11px] font-medium text-ink flex items-center justify-center gap-1 transition-colors"
                      >
                        {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                        {copied ? 'Copied' : 'Copy Draft'}
                      </button>

                      {onInsertDraft && (
                        <button
                          onClick={handleUseDraft}
                          className="flex-1 py-1.5 px-2 rounded-lg bg-accent hover:bg-accent-strong text-accent-fg text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors"
                        >
                          Insert Reply
                        </button>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="p-4 text-center text-ink-subtle">
                  Click below to analyze this thread.
                  <button
                    onClick={() => refetchCopilot()}
                    className="mt-2 block mx-auto px-3 py-1 rounded-lg bg-accent text-accent-fg font-semibold"
                  >
                    Analyze Thread
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: COMPANY CRM */}
          {activeTab === 'crm' && (
            <div className="space-y-4">
              {companyLoading ? (
                <div className="py-8 text-center text-ink-subtle">Loading company details...</div>
              ) : company ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-line bg-surface p-3 space-y-2">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0">
                        <div className="font-semibold text-ink text-sm truncate">{company.name}</div>
                        {company.industry && <div className="text-ink-subtle text-[11px]">{company.industry}</div>}
                      </div>
                      {company.overallRating && (
                        <span className="px-2 py-0.5 rounded-full bg-accent/15 text-accent font-bold text-[10px]">
                          Rating {company.overallRating}
                        </span>
                      )}
                    </div>

                    {company.websiteUrl && (
                      <a
                        href={company.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 text-accent hover:underline text-[11px]"
                      >
                        <Globe className="w-3 h-3 shrink-0" />
                        <span className="truncate">{company.websiteUrl.replace(/^https?:\/\//, '')}</span>
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    )}

                    {onOpenCompany && (
                      <button
                        onClick={() => onOpenCompany(company._id)}
                        className="w-full mt-2 py-1 px-2 rounded-lg border border-line hover:bg-surface-2 text-[11px] text-ink-muted text-center transition-colors"
                      >
                        View Full Company Profile →
                      </button>
                    )}
                  </div>

                  {/* Opportunity Copilot Signals */}
                  {copilotData?.opportunityContext?.deliverable && (
                    <div className="rounded-xl border border-line bg-surface p-3 space-y-2">
                      <span className="text-[10px] font-bold text-accent uppercase tracking-wider flex items-center gap-1">
                        <Lightbulb className="w-3 h-3" />
                        Opportunity Copilot Signals
                      </span>
                      <div className="space-y-1.5 text-[11px]">
                        <div>
                          <span className="text-ink-subtle">Target Deliverable:</span>
                          <div className="font-medium text-ink">{copilotData.opportunityContext.deliverable}</div>
                        </div>
                        {copilotData.opportunityContext.technicalSignal && (
                          <div>
                            <span className="text-ink-subtle">Primary Signal:</span>
                            <div className="font-medium text-ink">{copilotData.opportunityContext.technicalSignal}</div>
                          </div>
                        )}
                        {copilotData.opportunityContext.websiteCondition && (
                          <div>
                            <span className="text-ink-subtle">Audit Condition:</span>
                            <div className="font-medium text-ink">{copilotData.opportunityContext.websiteCondition}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Contacts */}
                  {company.contacts && company.contacts.length > 0 && (
                    <div className="rounded-xl border border-line bg-surface p-3 space-y-2">
                      <span className="text-[10px] font-bold text-ink-subtle uppercase tracking-wider flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        Company Contacts ({company.contacts.length})
                      </span>
                      <div className="space-y-2">
                        {company.contacts.map((c) => (
                          <div key={c._id} className="p-2 rounded-lg bg-surface-2 text-[11px]">
                            <div className="font-medium text-ink">{c.fullName || c.email}</div>
                            <div className="text-ink-subtle text-[10px]">{c.email}</div>
                            {c.role && <div className="text-accent text-[10px] mt-0.5">{c.role}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-xl border border-line bg-surface p-4 text-center text-ink-subtle space-y-1">
                  <p>No company record linked directly.</p>
                  <p className="text-[10px]">Recipient company: {thread.companyName || 'Not specified'}</p>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: ACTIVITY */}
          {activeTab === 'activity' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-line bg-surface p-3 space-y-2">
                <span className="text-[10px] font-bold text-ink-subtle uppercase tracking-wider flex items-center gap-1">
                  <Calendar className="w-3 h-3 text-accent" />
                  Conversation Details
                </span>
                <div className="space-y-1.5 text-[11px] text-ink-muted">
                  <div className="flex justify-between">
                    <span>Total Messages:</span>
                    <span className="font-medium text-ink">{thread.messageCount}</span>
                  </div>
                  {firstDate && (
                    <div className="flex justify-between">
                      <span>Started:</span>
                      <span className="font-medium text-ink">{formatFullDate(firstDate)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span>Folder / Labels:</span>
                    <span className="font-medium text-ink">
                      {thread.labels?.filter((l) => !l.includes('CATEGORY')).join(', ') || 'INBOX'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Messages timeline */}
              <div className="space-y-2">
                <span className="text-[10px] font-bold text-ink-subtle uppercase tracking-wider px-1">
                  Message Timeline
                </span>
                {thread.messages?.map((m, idx) => (
                  <div key={m.id || idx} className="rounded-xl border border-line bg-surface p-2.5 text-[11px] space-y-1">
                    <div className="flex items-center justify-between text-ink-subtle text-[10px]">
                      <span className="font-semibold text-ink">{m.from.name || m.from.email}</span>
                      <span>{new Date(m.date).toLocaleDateString()}</span>
                    </div>
                    <p className="text-ink-muted line-clamp-2">{m.snippet || m.bodyText}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  AlignLeft,
  CheckCircle2,
  ChevronDown,
  Clock,
  FilePlus2,
  Gauge,
  Inbox,
  Lightbulb,
  Loader2,
  Mail,
  Minus,
  MousePointerClick,
  PenLine,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { mailKeys } from '../lib/mail';
import { useAuth } from '../context/AuthContext';
import { EmailAccount } from '../types';
import {
  BADGE_CLASS,
  EMAIL_TONES,
  EmailCard,
  EmailDesignDocument,
  EmailDesignPreset,
  EmailTone,
  SavedStudioTemplate,
  StudioDraft,
  StudioDraftPayload,
  StudioDraftStatus,
  StudioHistoryItem,
  StudioIssue,
  StudioSendResponse,
  attemptStatusMeta,
  blankEmailDesign,
  collectSendBlockingIssues,
  collectStructuralIssues,
  createContentCard,
  createCtaCard,
  createDividerCard,
  createInsightCard,
  createMetricsCard,
  designVariables,
  draftStatusMeta,
  emailDesignFromPreset,
  emailStudioApi,
  formatStudioTimestamp,
} from '../lib/email-studio';
import { DesignCardEditor } from '../components/email-studio/DesignCardEditor';
import { EmailPreviewPanel } from '../components/email-studio/EmailPreviewPanel';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function issuesOf(err: unknown): StudioIssue[] | null {
  if (!(err instanceof ApiError)) return null;
  // AppError puts { issues } inside details; Zod validation errors serialize as
  // a bare issues array on the error body.
  if (Array.isArray(err.details?.issues)) return err.details.issues as StudioIssue[];
  if (Array.isArray(err.details)) {
    return (err.details as Array<{ path?: string; message: string }>).map((issue) => ({
      cardIndex: -1,
      path: issue.path,
      message: issue.message,
    }));
  }
  return null;
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = issuesOf(err);
    if (issues?.length) {
      const details = issues
        .slice(0, 3)
        .map((issue) => `${issue.path || 'request'}: ${issue.message}`)
        .join(' · ');
      return `${err.message} — ${details}`;
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
}

function Section({
  icon: Icon,
  title,
  description,
  actions,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ios-card">
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[rgb(var(--surface-2))] text-ink-muted">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-subtle">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="space-y-3 p-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className || ''}`}>
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
        {hint ? <span className="ml-1 font-normal normal-case text-ink-subtle">— {hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const inputClass = 'input px-3 py-2 text-sm';

export function EmailDesignStudioPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ['email-studio-config'],
    queryFn: emailStudioApi.getConfig,
    staleTime: 5 * 60 * 1000,
  });
  const config = configQuery.data;

  const templatesQuery = useQuery({
    queryKey: ['email-studio-templates'],
    queryFn: emailStudioApi.listTemplates,
  });

  const mailboxesQuery = useQuery<EmailAccount[]>({
    queryKey: mailKeys.mailboxes,
    queryFn: () => api.get<EmailAccount[]>('/mailboxes'),
  });
  const mailboxes = mailboxesQuery.data ?? [];

  const historyQuery = useQuery({
    queryKey: ['email-studio-drafts'],
    queryFn: () => emailStudioApi.listDrafts(20),
  });
  const history = historyQuery.data ?? [];

  // --- Composer state -----------------------------------------------------
  const [recipientEmail, setRecipientEmail] = useState('vansh@ayyan.com');
  const [recipientName, setRecipientName] = useState('Vansh');
  const [companyName, setCompanyName] = useState('Vansh GLOBAL PRIVATE LIMITED');
  const [domainName, setDomainName] = useState('ayyan.com');
  const [recipientRole, setRecipientRole] = useState('Managing Director');
  const [conversation, setConversation] = useState('');
  const [objective, setObjective] = useState('Share tailor-made retail/D2C workflow and architectural prototype');
  const [targetService, setTargetService] = useState('Headless Shopify Storefront & Omnichannel Inventory PWA');
  const [tone, setTone] = useState<EmailTone>('consultative');
  const [senderName, setSenderName] = useState('Swaniki Studio Team');
  const [senderTitle, setSenderTitle] = useState('Founding Engineer');

  const [design, setDesign] = useState<EmailDesignDocument | null>(null);
  const [subject, setSubject] = useState('');
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('');
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);

  const [preview, setPreview] = useState<{ html: string; text: string; warnings: string[] } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [isPreviewing, setIsPreviewing] = useState(false);

  const [factsUsed, setFactsUsed] = useState<string[]>([]);
  const [missingInformation, setMissingInformation] = useState<string[]>([]);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiMeta, setAiMeta] = useState<{ provider: string; isFallback: boolean } | null>(null);

  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<StudioDraftStatus>('draft');
  const [serverBlockingIssues, setServerBlockingIssues] = useState<StudioIssue[]>([]);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<StudioSendResponse | null>(null);

  const [mailboxEmail, setMailboxEmail] = useState('');

  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');

  const [isPersonalizing, setIsPersonalizing] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [isDeletingTemplate, setIsDeletingTemplate] = useState<string | null>(null);
  const [loadingDraftId, setLoadingDraftId] = useState<string | null>(null);

  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const initializedRef = useRef(false);

  const effectiveSenderName = senderName.trim() || user?.fullName || '';
  const effectiveSenderTitle = senderTitle.trim();
  // Only saved templates have Mongo ObjectIds; presets are code-defined.
  const effectiveTemplateId =
    templateId && OBJECT_ID_RE.test(templateId) ? templateId : undefined;

  const structuralIssues = useMemo(
    () => (design ? collectStructuralIssues(design) : []),
    [design]
  );
  const localSendIssues = useMemo(
    () => (design ? collectSendBlockingIssues(design) : []),
    [design]
  );
  const sendIssues = useMemo(() => {
    const byMessage = new Map<string, StudioIssue>();
    [...localSendIssues, ...serverBlockingIssues].forEach((issue) => byMessage.set(issue.message, issue));
    return [...byMessage.values()];
  }, [localSendIssues, serverBlockingIssues]);

  const variables = useMemo(
    () =>
      designVariables({
        companyName,
        recipientName,
        domainName,
        senderName: effectiveSenderName,
        senderTitle: effectiveSenderTitle,
        service: targetService,
      }),
    [companyName, recipientName, domainName, effectiveSenderName, effectiveSenderTitle, targetService]
  );

  const payloadSignature = useMemo(
    () =>
      JSON.stringify({
        recipientEmail,
        recipientName,
        companyName,
        domainName,
        recipientRole,
        conversation,
        objective,
        targetService,
        tone,
        senderName,
        senderTitle,
        subject,
        templateId: effectiveTemplateId,
        design,
      }),
    [
      recipientEmail,
      recipientName,
      companyName,
      domainName,
      recipientRole,
      conversation,
      objective,
      targetService,
      tone,
      senderName,
      senderTitle,
      subject,
      effectiveTemplateId,
      design,
    ]
  );
  const isDirty = savedSignature !== null && payloadSignature !== savedSignature;

  const applyPreset = useCallback((preset: EmailDesignPreset) => {
    setDesign(emailDesignFromPreset(preset));
    setSubject(preset.defaultSubject);
    setTone(preset.tone);
    setSelectedTemplateKey(`preset:${preset.id}`);
    // Presets are code-defined, not saved documents, so they have no ObjectId.
    setTemplateId(undefined);
    setAiMeta(null);
    setFactsUsed([]);
    setMissingInformation([]);
    setAiWarnings([]);
    setSendResult(null);
    setPreview(null);
  }, []);

  // Load the first preset once, the first time the brand configuration arrives.
  useEffect(() => {
    if (initializedRef.current || !config) return;
    initializedRef.current = true;
    const preset = config.presets[0];
    if (preset) applyPreset(preset);
    else setDesign(blankEmailDesign(config.brand));
  }, [config, applyPreset]);

  useEffect(() => {
    if (!senderName && user?.fullName) setSenderName(user.fullName);
  }, [user, senderName]);

  useEffect(() => {
    if (mailboxEmail || !mailboxes.length) return;
    const preferred =
      mailboxes.find((box) => box.status === 'connected' && !box.isPaused) || mailboxes[0];
    setMailboxEmail(preferred.emailAddress);
  }, [mailboxes, mailboxEmail]);

  // Server-rendered preview: the exact HTML that will be stored and sent.
  useEffect(() => {
    if (!design) return;
    if (structuralIssues.length) {
      setPreview(null);
      setPreviewError('');
      setIsPreviewing(false);
      return;
    }

    let cancelled = false;
    setIsPreviewing(true);
    const timer = setTimeout(async () => {
      try {
        const result = await emailStudioApi.preview({
          design,
          variables,
          subject: subject.trim() || undefined,
        });
        if (cancelled) return;
        setPreview({ html: result.html, text: result.text, warnings: result.warnings });
        setPreviewError('');
      } catch (err) {
        if (cancelled) return;
        setPreviewError(messageOf(err));
      } finally {
        if (!cancelled) setIsPreviewing(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [design, variables, subject, structuralIssues]);

  const combinedWarnings = useMemo(() => {
    const all = [...(preview?.warnings || []), ...aiWarnings];
    return [...new Set(all)];
  }, [preview, aiWarnings]);

  const updateHeader = (patch: Partial<EmailDesignDocument['header']>) => {
    setDesign((prev) => (prev ? { ...prev, header: { ...prev.header, ...patch } } : prev));
  };

  const updateSignature = (patch: Partial<EmailDesignDocument['signature']>) => {
    setDesign((prev) => (prev ? { ...prev, signature: { ...prev.signature, ...patch } } : prev));
  };

  const updateFooter = (patch: Partial<NonNullable<EmailDesignDocument['footer']>>) => {
    setDesign((prev) =>
      prev ? { ...prev, footer: { ...(prev.footer || {}), ...patch } } : prev
    );
  };

  const updateCard = (index: number, next: EmailCard) => {
    setDesign((prev) =>
      prev
        ? { ...prev, cards: prev.cards.map((card, i) => (i === index ? next : card)) }
        : prev
    );
  };

  const moveCard = (index: number, direction: -1 | 1) => {
    setDesign((prev) => {
      if (!prev) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.cards.length) return prev;
      const cards = [...prev.cards];
      [cards[index], cards[target]] = [cards[target], cards[index]];
      return { ...prev, cards };
    });
  };

  const removeCard = (index: number) => {
    setDesign((prev) => {
      if (!prev || prev.cards.length <= 1) return prev;
      return { ...prev, cards: prev.cards.filter((_, i) => i !== index) };
    });
  };

  const addCard = (type: EmailCard['type']) => {
    if (!design || design.cards.length >= 12) return;
    const ctaUrl = config?.brand.ctaUrl || config?.brand.website || 'https://swaniki.dev';
    let card: EmailCard;
    switch (type) {
      case 'content':
        card = createContentCard();
        break;
      case 'metrics':
        card = createMetricsCard();
        break;
      case 'insight':
        card = createInsightCard();
        break;
      case 'cta':
        card = createCtaCard(ctaUrl);
        break;
      case 'divider':
        card = createDividerCard();
        break;
    }
    setDesign({ ...design, cards: [...design.cards, card] });
  };

  const handleTemplateChange = (value: string) => {
    setSelectedTemplateKey(value);
    if (!value) return;

    if (value.startsWith('preset:')) {
      const preset = config?.presets.find((item) => item.id === value.slice('preset:'.length));
      if (preset) applyPreset(preset);
      return;
    }

    if (value.startsWith('saved:')) {
      const saved = templatesQuery.data?.saved.find((item) => item.id === value.slice('saved:'.length));
      if (!saved) return;
      setDesign(JSON.parse(JSON.stringify(saved.design)) as EmailDesignDocument);
      setSubject(saved.subject);
      setTone(saved.tone);
      setTemplateId(saved.id);
      setAiMeta(null);
      setFactsUsed([]);
      setMissingInformation([]);
      setAiWarnings([]);
      setSendResult(null);
      setPreview(null);
    }
  };

  const personalize = async () => {
    if (!design) return;
    setError('');
    setNotice('');

    if (!EMAIL_RE.test(recipientEmail.trim())) {
      setError('Enter a valid recipient email before generating copy.');
      return;
    }
    if (structuralIssues.length) {
      setError('Complete the design before generating copy: ' + structuralIssues[0].message);
      return;
    }

    setIsPersonalizing(true);
    try {
      const result = await emailStudioApi.personalize({
        recipientEmail: recipientEmail.trim(),
        recipientName: recipientName.trim() || undefined,
        companyName: companyName.trim() || undefined,
        domainName: domainName.trim() || undefined,
        recipientRole: recipientRole.trim() || undefined,
        conversation: conversation.trim() || undefined,
        objective: objective.trim() || undefined,
        targetService: targetService.trim() || undefined,
        tone,
        senderName: effectiveSenderName || undefined,
        senderTitle: effectiveSenderTitle || undefined,
        design,
      });

      setDesign(result.design);
      setSubject(result.subject);
      setFactsUsed(result.factsUsed);
      setMissingInformation(result.missingInformation);
      setAiWarnings(result.warnings);
      setAiMeta({ provider: result.provider, isFallback: result.isFallback });
      setPreview({ html: result.html, text: result.text, warnings: result.warnings });
      setSendResult(null);
      setNotice(
        result.isFallback
          ? 'Deterministic, statistic-free copy was generated. Review every sentence before approving.'
          : 'Grounded copy generated. Every number it cited came from your pasted context or metrics.'
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setIsPersonalizing(false);
    }
  };

  const buildPayload = (): StudioDraftPayload | null => {
    if (!design) return null;
    return {
      recipientEmail: recipientEmail.trim().toLowerCase(),
      recipientName: recipientName.trim() || undefined,
      companyName: companyName.trim() || undefined,
      domainName: domainName.trim() || undefined,
      recipientRole: recipientRole.trim() || undefined,
      conversation: conversation.trim() || undefined,
      objective: objective.trim() || undefined,
      targetService: targetService.trim() || undefined,
      tone,
      senderName: effectiveSenderName || undefined,
      senderTitle: effectiveSenderTitle || undefined,
      design,
      subject: subject.trim(),
      templateId: effectiveTemplateId,
      generationSource: aiMeta ? 'ai_grounded' : 'manual_edit',
      factsUsed,
      missingInformation,
      warnings: aiWarnings,
    };
  };

  const saveDraft = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setError('');
    setNotice('');

    if (!EMAIL_RE.test(payload.recipientEmail)) {
      setError('Enter a valid recipient email.');
      return;
    }
    if (!payload.subject) {
      setError('Add a subject line.');
      return;
    }
    if (structuralIssues.length) {
      setError('Complete the design before saving: ' + structuralIssues[0].message);
      return;
    }

    setIsSavingDraft(true);
    try {
      const saved = draftId
        ? await emailStudioApi.updateDraft(draftId, payload)
        : await emailStudioApi.createDraft(payload);
      setDraftId(saved.id);
      setDraftStatus(saved.status);
      setServerBlockingIssues(saved.blockingIssues);
      setSavedSignature(payloadSignature);
      setSendResult(null);
      setNotice(
        saved.status === 'approved'
          ? 'Draft updated. Edits reopen approval — approve it again before sending.'
          : 'Draft saved. Review the exact preview, then approve it to unlock sending.'
      );
      queryClient.invalidateQueries({ queryKey: ['email-studio-drafts'] });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setIsSavingDraft(false);
    }
  };

  const approveDraft = async () => {
    if (!draftId) return;
    setError('');
    setNotice('');
    if (isDirty) {
      setError('Save your edits first. Approval applies to the saved version, not unsaved changes.');
      return;
    }
    setIsApproving(true);
    try {
      const approved = await emailStudioApi.approveDraft(draftId);
      setDraftStatus(approved.status);
      setServerBlockingIssues(approved.blockingIssues);
      setDraftId(approved.id);
      setNotice('Approved by you. Sending is a separate action and still requires a mailbox.');
      queryClient.invalidateQueries({ queryKey: ['email-studio-drafts'] });
    } catch (err) {
      const issues = issuesOf(err);
      if (issues) setServerBlockingIssues(issues);
      setError(messageOf(err));
    } finally {
      setIsApproving(false);
    }
  };

  const sendEmail = async () => {
    if (!draftId || !mailboxEmail) return;
    setError('');
    setNotice('');
    setIsSending(true);
    try {
      const result = await emailStudioApi.send({ draftId, mailboxEmail });
      setSendResult(result);
      setDraftStatus(result.draft.status);
      setServerBlockingIssues(result.draft.blockingIssues);
      setSavedSignature(payloadSignature);
      queryClient.invalidateQueries({ queryKey: ['email-studio-drafts'] });
      queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
    } catch (err) {
      const issues = issuesOf(err);
      if (issues) setServerBlockingIssues(issues);
      setError(messageOf(err));
    } finally {
      setIsSending(false);
    }
  };

  const saveTemplate = async () => {
    if (!design) return;
    setError('');
    setNotice('');
    if (!templateName.trim()) {
      setError('Give the template a name before saving it.');
      return;
    }
    if (!subject.trim()) {
      setError('Add a subject line before saving a template.');
      return;
    }
    if (structuralIssues.length) {
      setError('Complete the design before saving a template: ' + structuralIssues[0].message);
      return;
    }

    setIsSavingTemplate(true);
    try {
      await emailStudioApi.saveTemplate({
        name: templateName.trim(),
        description: templateDescription.trim() || undefined,
        tone,
        subject: subject.trim(),
        design,
      });
      setTemplateName('');
      setTemplateDescription('');
      setNotice('Template saved for this organization.');
      queryClient.invalidateQueries({ queryKey: ['email-studio-templates'] });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setIsSavingTemplate(false);
    }
  };

  const deleteTemplate = async (template: SavedStudioTemplate) => {
    if (!window.confirm(`Delete the saved template "${template.name}"?`)) return;
    setError('');
    setNotice('');
    setIsDeletingTemplate(template.id);
    try {
      await emailStudioApi.deleteTemplate(template.id);
      queryClient.invalidateQueries({ queryKey: ['email-studio-templates'] });
      setNotice(`Template "${template.name}" deleted.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setIsDeletingTemplate(null);
    }
  };

  const loadDraft = async (item: StudioHistoryItem) => {
    setError('');
    setNotice('');
    setLoadingDraftId(item.id);
    try {
      const draft: StudioDraft = await emailStudioApi.getDraft(item.id);
      setDesign(draft.design);
      setSubject(draft.subject);
      setRecipientEmail(draft.recipientEmail);
      setRecipientName(draft.recipientName || '');
      setCompanyName(draft.companyName || '');
      setDomainName((draft as any).domainName || '');
      setRecipientRole('');
      setConversation('');
      setObjective('');
      setTargetService('');
      setTone(draft.tone);
      setTemplateId(undefined);
      setSelectedTemplateKey('');
      setDraftId(draft.id);
      setDraftStatus(draft.status);
      setServerBlockingIssues(draft.blockingIssues);
      setFactsUsed(draft.factsUsed);
      setMissingInformation(draft.missingInformation);
      setAiWarnings(draft.warnings);
      setAiMeta(null);
      setSendResult(null);
      setPreview({
        html: draft.bodyHtml || '',
        text: draft.bodyText,
        warnings: [],
      });
      setSavedSignature(
        JSON.stringify({
          recipientEmail: draft.recipientEmail,
          recipientName: draft.recipientName || '',
          companyName: draft.companyName || '',
          recipientRole: '',
          conversation: '',
          objective: '',
          targetService: '',
          tone: draft.tone,
          senderName,
          senderTitle,
          subject: draft.subject,
          templateId: undefined,
          design: draft.design,
        })
      );
      setNotice('Draft loaded. Conversation fields were cleared; the saved content is unchanged.');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoadingDraftId(null);
    }
  };

  const resetStudio = () => {
    setRecipientEmail('vansh@ayyan.com');
    setRecipientName('Vansh');
    setCompanyName('Vansh GLOBAL PRIVATE LIMITED');
    setDomainName('ayyan.com');
    setRecipientRole('Managing Director');
    setConversation('');
    setObjective('Share tailor-made retail/D2C workflow and architectural prototype');
    setTargetService('Headless Shopify Storefront & Omnichannel Inventory PWA');
    setTone('consultative');
    setDraftId(null);
    setDraftStatus('draft');
    setServerBlockingIssues([]);
    setSavedSignature(null);
    setSendResult(null);
    setFactsUsed([]);
    setMissingInformation([]);
    setAiWarnings([]);
    setAiMeta(null);
    setPreview(null);
    setPreviewError('');
    setError('');
    setNotice('');
    setTemplateName('');
    setTemplateDescription('');
    if (config) {
      const preset = config.presets[0];
      if (preset) applyPreset(preset);
      else setDesign(blankEmailDesign(config.brand));
    }
  };

  const accepted = draftStatus === 'accepted' || sendResult?.result.status === 'accepted';
  const canApprove = Boolean(
    draftId &&
      !accepted &&
      !isDirty &&
      draftStatus !== 'approved' &&
      !isApproving &&
      sendIssues.length === 0
  );
  const canSend = Boolean(
    draftId &&
      mailboxEmail &&
      draftStatus === 'approved' &&
      !isDirty &&
      !accepted &&
      !isSending &&
      sendIssues.length === 0
  );

  const connectedMailboxes = mailboxes.filter((box) => box.status === 'connected' && !box.isPaused);
  const currentMailbox = mailboxes.find((box) => box.emailAddress === mailboxEmail);
  const statusMeta = draftStatusMeta(draftStatus);

  if (configQuery.isLoading && !design) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center gap-3 py-24 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-[rgb(var(--accent))]" />
        <p className="text-sm text-ink-muted">Loading the email design system…</p>
      </div>
    );
  }

  if (configQuery.isError && !config) {
    return (
      <div className="mx-auto w-full max-w-xl py-16">
        <div className="ios-card flex flex-col items-center gap-3 p-8 text-center">
          <XCircle className="h-7 w-7 text-[rgb(var(--danger))]" />
          <h1 className="text-lg font-semibold text-ink">The studio could not load</h1>
          <p className="text-sm text-ink-muted">{messageOf(configQuery.error)}</p>
          <button className="ios-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-sm" onClick={() => configQuery.refetch()}>
            <RefreshCw className="h-4 w-4" /> Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="ios-pill">
              <PenLine className="h-3 w-3" /> Enterprise design system
            </span>
            <span className="ios-pill">
              <ShieldCheck className="h-3 w-3" /> Human approval required
            </span>
            {draftId && (
              <span className={`badge ${BADGE_CLASS[statusMeta.tone]}`}>{statusMeta.label}</span>
            )}
            {isDirty && <span className="badge badge-warning">Unsaved edits</span>}
          </div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            Email design studio
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-muted">
            Compose a premium, table-based HTML email with a plain-text alternative. Copy is grounded
            in your conversation, metrics come only from you, and nothing sends without your approval.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="ios-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-sm" onClick={resetStudio}>
            <FilePlus2 className="h-4 w-4" /> New email
          </button>
          <button
            type="button"
            className="ios-btn-primary inline-flex items-center gap-2 px-3.5 py-2 text-sm"
            onClick={saveDraft}
            disabled={isSavingDraft || !design}
          >
            {isSavingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {draftId ? 'Save changes' : 'Save draft'}
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-[rgb(var(--danger)/0.35)] bg-[rgb(var(--danger)/0.08)] px-3.5 py-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--danger))]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-[rgb(var(--danger))]">Action needed</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{error}</p>
          </div>
          <button type="button" className="btn-ghost p-1" onClick={() => setError('')} aria-label="Dismiss error">
            <XCircle className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 rounded-xl border border-[rgb(var(--success)/0.35)] bg-[rgb(var(--success)/0.08)] px-3.5 py-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--success))]" />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-muted">{notice}</p>
          <button type="button" className="btn-ghost p-1" onClick={() => setNotice('')} aria-label="Dismiss notice">
            <XCircle className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(440px,600px)]">
        <div className="min-w-0 space-y-4">
          <Section
            icon={Mail}
            title="Recipient & context"
            description="Paste the real conversation. The copy generator answers the actual question and never invents benchmarks."
            actions={
              <button
                type="button"
                className="ios-btn-secondary inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-xs"
                onClick={personalize}
                disabled={isPersonalizing || !design || structuralIssues.length > 0}
              >
                {isPersonalizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Generate copy
              </button>
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Recipient email" hint="required">
                <input
                  className={inputClass}
                  type="email"
                  autoComplete="off"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="elena@company.com"
                />
              </Field>
              <Field label="Recipient name">
                <input
                  className={inputClass}
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  placeholder="Elena Rossi"
                  maxLength={120}
                />
              </Field>
              <Field label="Company">
                <input
                  className={inputClass}
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Acme Logistics"
                  maxLength={160}
                />
              </Field>
              <Field label="Company domain" hint="used in {{domain_name}}">
                <input
                  className={inputClass}
                  value={domainName}
                  onChange={(e) => setDomainName(e.target.value)}
                  placeholder="ayyan.com"
                  maxLength={160}
                />
              </Field>
              <Field label="Recipient role">
                <input
                  className={inputClass}
                  value={recipientRole}
                  onChange={(e) => setRecipientRole(e.target.value)}
                  placeholder="VP Digital Operations"
                  maxLength={160}
                />
              </Field>
              <Field label="Service discussed">
                <input
                  className={inputClass}
                  value={targetService}
                  onChange={(e) => setTargetService(e.target.value)}
                  placeholder="Digital performance"
                  maxLength={160}
                />
              </Field>
              <Field label="Objective">
                <input
                  className={inputClass}
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  placeholder="Book a technical review"
                  maxLength={600}
                />
              </Field>
              <Field label="Tone">
                <select
                  className={inputClass}
                  value={tone}
                  onChange={(e) => setTone(e.target.value as EmailTone)}
                >
                  {(config?.tones || EMAIL_TONES).map((option) => (
                    <option key={option} value={option}>
                      {option[0].toUpperCase() + option.slice(1)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Sender title">
                <input
                  className={inputClass}
                  value={senderTitle}
                  onChange={(e) => setSenderTitle(e.target.value)}
                  placeholder="Principal, Digital Performance"
                  maxLength={120}
                />
              </Field>
              <Field label="Sender name" className="sm:col-span-2">
                <input
                  className={inputClass}
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  placeholder={user?.fullName || 'Your name'}
                  maxLength={120}
                />
              </Field>
            </div>

            <Field label="Pasted conversation" hint="quoted data — never treated as instructions">
              <textarea
                className={`${inputClass} min-h-[132px] resize-y`}
                value={conversation}
                onChange={(e) => setConversation(e.target.value)}
                maxLength={12000}
                placeholder={'Paste the thread here…\n\nProspect: What benchmarks do you typically see for freight portals?'}
              />
            </Field>

            {aiMeta && (
              <div className="rounded-xl border border-line bg-[rgb(var(--surface-2))] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`badge ${aiMeta.isFallback ? 'badge-neutral' : 'badge-info'}`}>
                    {aiMeta.isFallback ? 'Deterministic engine' : 'Grounded AI'}
                  </span>
                  <span className="text-[11px] text-ink-subtle">Provider: {aiMeta.provider}</span>
                </div>
                {factsUsed.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">Facts used</p>
                    <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
                      {factsUsed.map((fact, idx) => (
                        <li key={idx}>• {fact}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {missingInformation.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-[rgb(var(--warning))]">
                      Missing information
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
                      {missingInformation.map((item, idx) => (
                        <li key={idx}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Section>

          <Section
            icon={AlignLeft}
            title="Template"
            description="Start from a preset or a template your team saved. Applying a template replaces the current layout."
          >
            <Field label="Start from">
              <select className={inputClass} value={selectedTemplateKey} onChange={(e) => handleTemplateChange(e.target.value)}>
                <option value="">Choose a template…</option>
                <optgroup label="Presets">
                  {(config?.presets || []).map((preset) => (
                    <option key={preset.id} value={`preset:${preset.id}`}>
                      {preset.name}
                    </option>
                  ))}
                </optgroup>
                {(templatesQuery.data?.saved || []).length > 0 && (
                  <optgroup label="Saved templates">
                    {(templatesQuery.data?.saved || []).map((saved) => (
                      <option key={saved.id} value={`saved:${saved.id}`}>
                        {saved.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Field>

            {config?.presets.find((item) => `preset:${item.id}` === selectedTemplateKey) && (
              <p className="text-[11px] leading-relaxed text-ink-subtle">
                {config.presets.find((item) => `preset:${item.id}` === selectedTemplateKey)?.description}
              </p>
            )}

            {(templatesQuery.data?.saved || []).length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">Saved templates</p>
                {(templatesQuery.data?.saved || []).map((saved) => (
                  <div key={saved.id} className="flex items-center gap-2 rounded-lg border border-line bg-[rgb(var(--surface-2))] px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-ink">{saved.name}</p>
                      <p className="truncate text-[11px] text-ink-subtle">
                        {saved.subject} · updated {formatStudioTimestamp(saved.updatedAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn-ghost p-1.5 text-[rgb(var(--danger))] hover:text-[rgb(var(--danger))]"
                      onClick={() => deleteTemplate(saved)}
                      disabled={isDeletingTemplate === saved.id}
                      aria-label={`Delete ${saved.name}`}
                    >
                      {isDeletingTemplate === saved.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-line bg-[rgb(var(--surface-2))] p-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">Save current design as template</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <input
                  className={inputClass}
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="Template name"
                  maxLength={120}
                />
                <input
                  className={inputClass}
                  value={templateDescription}
                  onChange={(e) => setTemplateDescription(e.target.value)}
                  placeholder="Short description (optional)"
                  maxLength={400}
                />
              </div>
              <button
                type="button"
                className="ios-btn-secondary mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
                onClick={saveTemplate}
                disabled={isSavingTemplate || !templateName.trim() || !design}
              >
                {isSavingTemplate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save template
              </button>
            </div>
          </Section>

          {design && (
            <>
              <Section
                icon={PenLine}
                title="Subject & header"
                description="The header is the charcoal identity block at the top of the email."
              >
                <Field label="Subject line" hint="required, max 220">
                  <input
                    className={inputClass}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    maxLength={220}
                    placeholder="A short note for {{company_name}}"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Header label" hint="uppercase eyebrow">
                    <input
                      className={inputClass}
                      value={design.header.label}
                      onChange={(e) => updateHeader({ label: e.target.value })}
                      maxLength={48}
                    />
                  </Field>
                  <Field label="Reference" hint="optional">
                    <input
                      className={inputClass}
                      value={design.header.reference || ''}
                      onChange={(e) => updateHeader({ reference: e.target.value })}
                      maxLength={80}
                    />
                  </Field>
                </div>
                <Field label="Header title">
                  <input
                    className={inputClass}
                    value={design.header.title}
                    onChange={(e) => updateHeader({ title: e.target.value })}
                    maxLength={160}
                  />
                </Field>
                <Field label="Header subtitle" hint="optional">
                  <input
                    className={inputClass}
                    value={design.header.subtitle || ''}
                    onChange={(e) => updateHeader({ subtitle: e.target.value })}
                    maxLength={320}
                  />
                </Field>
                <Field label="Preheader" hint="inbox preview text, optional">
                  <input
                    className={inputClass}
                    value={design.preheader || ''}
                    onChange={(e) => setDesign((prev) => (prev ? { ...prev, preheader: e.target.value } : prev))}
                    maxLength={200}
                  />
                </Field>
              </Section>

              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-ink">Content cards</h2>
                    <p className="text-[11px] text-ink-subtle">
                      Cards render in order. Metrics and CTA cards are checked again at approval and send time.
                    </p>
                  </div>
                  <span className="ios-pill">{design.cards.length} / 12</span>
                </div>

                {design.cards.map((card, index) => (
                  <DesignCardEditor
                    key={`${card.type}-${index}`}
                    card={card}
                    index={index}
                    total={design.cards.length}
                    onChange={(next) => updateCard(index, next)}
                    onMove={(direction) => moveCard(index, direction)}
                    onRemove={() => removeCard(index)}
                  />
                ))}

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[11px] text-ink-subtle">Add card:</span>
                  {([
                    ['content', AlignLeft, 'Content'],
                    ['metrics', Gauge, 'Metrics'],
                    ['insight', Lightbulb, 'Insight'],
                    ['cta', MousePointerClick, 'CTA'],
                    ['divider', Minus, 'Divider'],
                  ] as const).map(([type, Icon, label]) => (
                    <button
                      key={type}
                      type="button"
                      className="ios-btn-secondary inline-flex items-center gap-1 px-2 py-1.5 text-[11px]"
                      onClick={() => addCard(type)}
                      disabled={design.cards.length >= 12}
                    >
                      <Icon className="h-3.5 w-3.5" /> {label}
                    </button>
                  ))}
                </div>
              </section>

              <details className="ios-card group">
                <summary className="flex cursor-pointer list-none items-center gap-2 border-b border-line px-4 py-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[rgb(var(--surface-2))] text-ink-muted">
                    <ShieldCheck className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-ink">Signature & footer</h2>
                    <p className="text-[11px] text-ink-subtle">Executive sign-off, postal address and unsubscribe link.</p>
                  </div>
                  <ChevronDown className="h-4 w-4 text-ink-subtle transition group-open:rotate-180" />
                </summary>
                <div className="space-y-3 p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Signature name" hint="required">
                      <input
                        className={inputClass}
                        value={design.signature.name}
                        onChange={(e) => updateSignature({ name: e.target.value })}
                        maxLength={120}
                      />
                    </Field>
                    <Field label="Title">
                      <input
                        className={inputClass}
                        value={design.signature.title || ''}
                        onChange={(e) => updateSignature({ title: e.target.value })}
                        maxLength={120}
                      />
                    </Field>
                    <Field label="Company">
                      <input
                        className={inputClass}
                        value={design.signature.company || ''}
                        onChange={(e) => updateSignature({ company: e.target.value })}
                        maxLength={120}
                      />
                    </Field>
                    <Field label="Contact email">
                      <input
                        className={inputClass}
                        type="email"
                        value={design.signature.email || ''}
                        onChange={(e) => updateSignature({ email: e.target.value })}
                      />
                    </Field>
                    <Field label="Phone">
                      <input
                        className={inputClass}
                        value={design.signature.phone || ''}
                        onChange={(e) => updateSignature({ phone: e.target.value })}
                        maxLength={40}
                      />
                    </Field>
                    <Field label="Website">
                      <input
                        className={inputClass}
                        value={design.signature.website || ''}
                        onChange={(e) => updateSignature({ website: e.target.value })}
                        placeholder="https://swaniki.dev"
                      />
                    </Field>
                  </div>
                  <Field label="Signature note" hint="optional">
                    <input
                      className={inputClass}
                      value={design.signature.note || ''}
                      onChange={(e) => updateSignature({ note: e.target.value })}
                      maxLength={300}
                    />
                  </Field>

                  <div className="border-t border-line pt-3">
                    <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Footer</p>
                    <div className="space-y-3">
                      <Field label="Reason for contact" hint="optional">
                        <input
                          className={inputClass}
                          value={design.footer?.reason || ''}
                          onChange={(e) => updateFooter({ reason: e.target.value })}
                          maxLength={400}
                        />
                      </Field>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Postal address" hint="optional">
                          <input
                            className={inputClass}
                            value={design.footer?.postalAddress || ''}
                            onChange={(e) => updateFooter({ postalAddress: e.target.value })}
                            maxLength={300}
                          />
                        </Field>
                        <Field label="Unsubscribe URL" hint="optional, http(s)">
                          <input
                            className={inputClass}
                            value={design.footer?.unsubscribeUrl || ''}
                            onChange={(e) => updateFooter({ unsubscribeUrl: e.target.value })}
                            placeholder="https://swaniki.dev/unsubscribe"
                          />
                        </Field>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-line bg-[rgb(var(--surface-2))] px-3 py-2 text-[11px] leading-relaxed text-ink-subtle">
                    Placeholders available in copy: <code>{'{{company_name}}'}</code>,{' '}
                    <code>{'{{recipient_name}}'}</code>, <code>{'{{sender_name}}'}</code>,{' '}
                    <code>{'{{sender_title}}'}</code>, <code>{'{{service}}'}</code>.
                  </div>
                </div>
              </details>
            </>
          )}
        </div>

        <div className="min-w-0 space-y-4 self-start 2xl:sticky 2xl:top-2 2xl:max-h-[calc(100dvh-6rem)] 2xl:overflow-y-auto 2xl:pr-1">
          <EmailPreviewPanel
            html={preview?.html || null}
            text={preview?.text || ''}
            warnings={combinedWarnings}
            subject={subject}
            isRendering={isPreviewing}
            error={previewError}
            issues={structuralIssues}
          />

          <Section
            icon={Send}
            title="Review & send"
            description="Approval is recorded server-side. Editing a saved draft reopens approval."
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge ${BADGE_CLASS[statusMeta.tone]}`}>{statusMeta.label}</span>
              {isDirty && <span className="badge badge-warning">Save edits before approving</span>}
              {isDirty && <span className="text-[11px] text-ink-subtle">Unsaved changes are not part of the approved version.</span>}
            </div>

            {sendIssues.length > 0 && (
              <div className="rounded-xl border border-[rgb(var(--warning)/0.35)] bg-[rgb(var(--warning)/0.08)] px-3 py-2.5">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[rgb(var(--warning))]">
                  <AlertTriangle className="h-3.5 w-3.5" /> Blocks approval & send
                </p>
                <ul className="mt-1 space-y-1 text-[11px] leading-relaxed text-ink-muted">
                  {sendIssues.map((issue, idx) => (
                    <li key={idx}>• {issue.cardIndex >= 0 ? `Card ${issue.cardIndex + 1}: ` : ''}{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}

            <Field label="Send from mailbox">
              <select
                className={inputClass}
                value={mailboxEmail}
                onChange={(e) => setMailboxEmail(e.target.value)}
                disabled={mailboxes.length === 0}
              >
                {mailboxes.length === 0 && <option value="">No mailboxes connected</option>}
                {mailboxes.map((box) => {
                  const unavailable = box.status !== 'connected' || box.isPaused;
                  return (
                    <option key={box._id} value={box.emailAddress} disabled={unavailable}>
                      {box.emailAddress} · {box.provider}
                      {unavailable ? ' (unavailable)' : ''}
                    </option>
                  );
                })}
              </select>
              {connectedMailboxes.length === 0 && (
                <span className="mt-1 block text-[11px] text-ink-subtle">
                  No connected mailbox is ready. <Link to="/integrations" className="underline">Connect Gmail</Link> or
                  configure SMTP on the server.
                </span>
              )}
              {currentMailbox && (
                <span className="mt-1 block text-[11px] text-ink-subtle">
                  Provider: {currentMailbox.provider} · sent today {currentMailbox.sendsToday} / {currentMailbox.dailySendLimit}
                </span>
              )}
            </Field>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="ios-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs"
                onClick={approveDraft}
                disabled={!canApprove}
              >
                {isApproving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                {draftStatus === 'approved' ? 'Approved' : 'Approve saved draft'}
              </button>
              <button
                type="button"
                className="ios-btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs"
                onClick={sendEmail}
                disabled={!canSend}
              >
                {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {sendResult && sendResult.result.status !== 'accepted' ? 'Retry send' : 'Send approved email'}
              </button>
            </div>

            {!draftId && (
              <p className="text-[11px] leading-relaxed text-ink-subtle">
                Save the draft first. The approval button activates once the saved design has a CTA and every
                metric has a verified value and a source.
              </p>
            )}

            {sendResult && (
              <div
                className={`rounded-xl border px-3 py-2.5 ${
                  sendResult.result.status === 'accepted'
                    ? 'border-[rgb(var(--success)/0.35)] bg-[rgb(var(--success)/0.08)]'
                    : sendResult.result.status === 'deferred'
                      ? 'border-[rgb(var(--warning)/0.35)] bg-[rgb(var(--warning)/0.08)]'
                      : 'border-[rgb(var(--danger)/0.35)] bg-[rgb(var(--danger)/0.08)]'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`badge ${BADGE_CLASS[attemptStatusMeta(sendResult.result.status).tone]}`}>
                    {attemptStatusMeta(sendResult.result.status).label}
                  </span>
                  <span className="text-[11px] text-ink-subtle">
                    via {sendResult.mailbox.emailAddress} ({sendResult.mailbox.provider})
                  </span>
                </div>
                {sendResult.result.providerMessageId && (
                  <p className="mt-1 break-all text-[11px] text-ink-muted">
                    Provider message id: <code>{sendResult.result.providerMessageId}</code>
                  </p>
                )}
                {sendResult.result.errorMessage && (
                  <p className="mt-1 text-[11px] leading-relaxed text-[rgb(var(--danger))]">
                    {sendResult.result.errorMessage}
                  </p>
                )}
                {sendResult.result.deliveryUncertain && (
                  <p className="mt-1 text-[11px] leading-relaxed text-[rgb(var(--warning))]">
                    The provider outcome is uncertain. Do not retry until the send attempt has been
                    reconciled, or the recipient may receive a duplicate.
                  </p>
                )}
                {sendResult.result.deferredUntil && (
                  <p className="mt-1 text-[11px] text-ink-muted">
                    Deferred until {formatStudioTimestamp(sendResult.result.deferredUntil)}.
                  </p>
                )}
              </div>
            )}

            {accepted && (
              <p className="flex items-center gap-1.5 text-[11px] text-[rgb(var(--success))]">
                <CheckCircle2 className="h-3.5 w-3.5" /> The provider accepted this message.
              </p>
            )}
          </Section>
        </div>
      </div>

      <Section
        icon={Clock}
        title="Studio history"
        description="Every studio draft and its latest provider attempt. Delivery errors are shown verbatim."
        actions={
          <button
            type="button"
            className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs"
            onClick={() => historyQuery.refetch()}
            disabled={historyQuery.isFetching}
          >
            {historyQuery.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        }
      >
        {historyQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading drafts…
          </div>
        ) : history.length === 0 ? (
          <div className="empty-state gap-2 py-8">
            <Inbox className="h-6 w-6" />
            <p className="text-sm font-medium text-ink">No studio drafts yet</p>
            <p className="text-xs">Save a draft above to see its approval and delivery status here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Email</th>
                  <th className="py-2 pr-3 font-medium">Last attempt</th>
                  <th className="py-2 pr-3 font-medium">Updated</th>
                  <th className="py-2 pr-0 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => {
                  const itemStatus = draftStatusMeta(item.status);
                  const attempt = item.lastAttempt;
                  const attemptMeta = attemptStatusMeta(attempt?.status);
                  return (
                    <tr key={item.id} className="border-b border-line/70 align-top last:border-0">
                      <td className="py-2.5 pr-3">
                        <span className={`badge ${BADGE_CLASS[itemStatus.tone]}`}>{itemStatus.label}</span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <p className="line-clamp-1 font-medium text-ink">{item.subject}</p>
                        <p className="text-[11px] text-ink-subtle">
                          {item.recipientName ? `${item.recipientName} · ` : ''}
                          {item.recipientEmail}
                          {item.companyName ? ` · ${item.companyName}` : ''}
                        </p>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`badge ${BADGE_CLASS[attemptMeta.tone]}`}>{attemptMeta.label}</span>
                        {attempt?.errorMessage && (
                          <p className="mt-1 max-w-[260px] text-[11px] leading-snug text-[rgb(var(--danger))]">
                            {attempt.errorMessage}
                          </p>
                        )}
                        {attempt?.deliveryUncertain && (
                          <p className="mt-1 text-[11px] text-[rgb(var(--warning))]">Delivery uncertain</p>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-[11px] text-ink-subtle">
                        {formatStudioTimestamp(item.updatedAt || item.createdAt)}
                      </td>
                      <td className="py-2.5 pr-0 text-right">
                        <button
                          type="button"
                          className="btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs"
                          onClick={() => loadDraft(item)}
                          disabled={loadingDraftId === item.id}
                        >
                          {loadingDraftId === item.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <PenLine className="h-3.5 w-3.5" />
                          )}
                          Open
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {config && config.guarantees.length > 0 && (
        <div className="flex flex-wrap items-start gap-2 rounded-xl border border-line bg-[rgb(var(--surface-2))] px-3.5 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--accent))]" />
          <ul className="min-w-0 flex-1 space-y-0.5 text-[11px] leading-relaxed text-ink-muted">
            {config.guarantees.map((guarantee, idx) => (
              <li key={idx}>• {guarantee}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

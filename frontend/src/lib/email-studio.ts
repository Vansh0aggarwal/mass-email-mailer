import { api } from './api';

export type EmailTone = 'consultative' | 'professional' | 'concise' | 'friendly' | 'urgent';

export const EMAIL_TONES: EmailTone[] = ['consultative', 'professional', 'concise', 'friendly', 'urgent'];

export interface EmailMetric {
  label: string;
  /** Operator-supplied measurement before the change. */
  before?: string;
  after?: string;
  value?: string;
  unit?: string;
  improvement?: string;
  note?: string;
}

export interface EmailBullet {
  title?: string;
  text: string;
}

export interface EmailContentCard {
  type: 'content';
  title?: string;
  greeting?: string;
  paragraphs: string[];
  bullets?: EmailBullet[];
  callout?: string;
}

/**
 * Metrics are operator data, never generated. `source` is mandatory so a
 * recipient can always trace where a number came from.
 */
export interface EmailMetricsCard {
  type: 'metrics';
  title?: string;
  subtitle?: string;
  metrics: EmailMetric[];
  source: string;
}

export interface EmailInsightCard {
  type: 'insight';
  title?: string;
  body: string;
  source?: string;
}

export interface EmailCtaCard {
  type: 'cta';
  eyebrow?: string;
  headline: string;
  body?: string;
  buttonLabel: string;
  buttonUrl: string;
  footnote?: string;
}

export interface EmailDividerCard {
  type: 'divider';
}

export type EmailCard =
  | EmailContentCard
  | EmailMetricsCard
  | EmailInsightCard
  | EmailCtaCard
  | EmailDividerCard;

export interface EmailSignature {
  name: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  website?: string;
  note?: string;
}

export interface EmailDesignDocument {
  version: 1;
  palette?: { accent?: string };
  header: {
    label: string;
    title: string;
    subtitle?: string;
    reference?: string;
  };
  preheader?: string;
  cards: EmailCard[];
  signature: EmailSignature;
  footer?: {
    reason?: string;
    postalAddress?: string;
    unsubscribeUrl?: string;
  };
}

export interface EmailBrandConfig {
  name: string;
  tagline: string;
  website: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  ctaUrl: string;
  unsubscribeUrl: string;
  accent: string;
}

export interface EmailDesignPreset {
  id: string;
  name: string;
  description: string;
  tone: EmailTone;
  defaultSubject: string;
  design: EmailDesignDocument;
}

export interface EmailStudioConfig {
  brand: EmailBrandConfig;
  presets: EmailDesignPreset[];
  tones: EmailTone[];
  guarantees: string[];
}

export interface SavedStudioTemplate {
  id: string;
  name: string;
  description?: string;
  tone: EmailTone;
  subject: string;
  design: EmailDesignDocument;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioTemplatesResponse {
  presets: EmailDesignPreset[];
  saved: SavedStudioTemplate[];
}

export interface StudioPreview {
  subject?: string;
  html: string;
  text: string;
  warnings: string[];
  design: EmailDesignDocument;
}

export interface StudioPersonalizeResult extends Omit<StudioPreview, 'subject'> {
  subject: string;
  provider: string;
  isFallback: boolean;
  factsUsed: string[];
  missingInformation: string[];
}

export type StudioDraftStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'queued'
  | 'sending'
  | 'accepted'
  | 'failed'
  | 'unknown_outcome'
  | 'archived';

export interface StudioIssue {
  /** -1 for design-wide or request-field issues. */
  cardIndex: number;
  /** Field path for schema validation errors; absent on design issues. */
  path?: string;
  message: string;
}

export interface StudioDraft {
  id: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  design: EmailDesignDocument;
  recipientEmail: string;
  recipientName?: string;
  companyName?: string;
  tone: EmailTone;
  status: StudioDraftStatus;
  factsUsed: string[];
  missingInformation: string[];
  warnings: string[];
  providerMessageId?: string;
  providerThreadId?: string;
  sentAt?: string;
  createdAt?: string;
  updatedAt?: string;
  blockingIssues: StudioIssue[];
  canSend: boolean;
}

export interface StudioDraftVariables {
  recipientEmail: string;
  recipientName?: string;
  companyName?: string;
  recipientRole?: string;
  conversation?: string;
  objective?: string;
  targetService?: string;
  tone: EmailTone;
  senderName?: string;
  senderTitle?: string;
}

export interface StudioDraftPayload extends StudioDraftVariables {
  design: EmailDesignDocument;
  subject: string;
  templateId?: string;
  generationSource?: 'ai_grounded' | 'manual_edit';
  factsUsed?: string[];
  missingInformation?: string[];
  warnings?: string[];
}

export interface StudioHistoryAttempt {
  status: string;
  errorMessage?: string;
  attempts: number;
  providerMessageId?: string;
  deliveryUncertain?: boolean;
  deferredUntil?: string;
  completedAt?: string;
}

export interface StudioHistoryItem {
  id: string;
  subject: string;
  recipientEmail: string;
  recipientName?: string;
  companyName?: string;
  status: StudioDraftStatus;
  tone: EmailTone;
  sentAt?: string;
  providerMessageId?: string;
  providerThreadId?: string;
  warnings: string[];
  createdAt?: string;
  updatedAt?: string;
  lastAttempt: StudioHistoryAttempt | null;
}

export interface StudioSendResult {
  status: string;
  providerMessageId?: string;
  providerThreadId?: string;
  errorMessage?: string;
  idempotencyKey: string;
  deliveryUncertain?: boolean;
  deferredUntil?: string;
}

export interface StudioSendResponse {
  result: StudioSendResult;
  draft: StudioDraft;
  mailbox: { emailAddress: string; provider: string };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Resolves the {{variables}} the renderer understands. */
export function designVariables(input: {
  companyName?: string;
  recipientName?: string;
  senderName?: string;
  senderTitle?: string;
  service?: string;
}): Record<string, string | undefined> {
  return {
    companyName: input.companyName?.trim() || undefined,
    recipientName: input.recipientName?.trim() || undefined,
    senderName: input.senderName?.trim() || undefined,
    senderTitle: input.senderTitle?.trim() || undefined,
    service: input.service?.trim() || undefined,
  };
}

export function emailDesignFromPreset(preset: EmailDesignPreset): EmailDesignDocument {
  return clone(preset.design);
}

export function blankEmailDesign(brand: EmailBrandConfig): EmailDesignDocument {
  const ctaUrl = brand.ctaUrl || brand.website || 'https://swaniki.dev';
  return {
    version: 1,
    header: {
      label: 'CORRESPONDENCE',
      title: 'A short note for {{company_name}}',
      subtitle: 'Shared directly with {{recipient_name}}.',
      reference: 'PRIVATE CORRESPONDENCE',
    },
    preheader: 'A brief, personal note for {{company_name}}.',
    cards: [
      {
        type: 'content',
        greeting: 'Hi {{recipient_name}},',
        paragraphs: [
          'I am reaching out because {{company_name}} has built a strong reputation in your market, and I wanted to share a perspective on where digital experience tends to become a constraint on growth.',
          'If it is useful, I would be glad to send a short summary or set up a brief conversation about your priorities.',
        ],
      },
      {
        type: 'cta',
        eyebrow: 'NEXT STEP',
        headline: 'Would a short conversation be useful?',
        body: 'I can walk through what we would prioritise first.',
        buttonLabel: 'Arrange a brief call',
        buttonUrl: ctaUrl,
      },
    ],
    signature: {
      name: '{{sender_name}}',
      title: '{{sender_title}}',
      company: brand.name,
      email: brand.contactEmail || undefined,
      website: brand.website || undefined,
    },
    footer: {
      reason:
        'You are receiving this one-to-one business correspondence because our team identified a relevant contact at {{company_name}}.',
      postalAddress: brand.address || undefined,
      unsubscribeUrl: brand.unsubscribeUrl || undefined,
    },
  };
}

export function createContentCard(): EmailContentCard {
  return { type: 'content', paragraphs: [''] };
}

export function createMetricsCard(): EmailMetricsCard {
  return {
    type: 'metrics',
    title: 'Measured results',
    metrics: [{ label: '' }],
    source: '',
  };
}

export function createInsightCard(): EmailInsightCard {
  return { type: 'insight', title: 'A note on benchmarks', body: '' };
}

export function createCtaCard(ctaUrl: string): EmailCtaCard {
  return {
    type: 'cta',
    eyebrow: 'NEXT STEP',
    headline: 'Would a short conversation be useful?',
    buttonLabel: 'Arrange a brief call',
    buttonUrl: ctaUrl || 'https://swaniki.dev',
  };
}

export function createDividerCard(): EmailDividerCard {
  return { type: 'divider' };
}

/** A metric is complete only once the operator supplied a real measurement. */
export function metricHasValue(metric: EmailMetric): boolean {
  return Boolean(
    metric.before?.trim() ||
      metric.after?.trim() ||
      metric.value?.trim() ||
      metric.improvement?.trim()
  );
}

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/**
 * Structural problems that prevent the renderer from producing a preview.
 * These are stronger than send-blocking issues: preview cannot run at all.
 */
export function collectStructuralIssues(design: EmailDesignDocument): StudioIssue[] {
  const issues: StudioIssue[] = [];

  if (!design.header?.label?.trim()) {
    issues.push({ cardIndex: -1, message: 'Add a header label (for example CORRESPONDENCE).' });
  }
  if (!design.header?.title?.trim()) {
    issues.push({ cardIndex: -1, message: 'Add a header title.' });
  }
  if (!design.signature?.name?.trim()) {
    issues.push({ cardIndex: -1, message: 'A signature name is required.' });
  }
  if (design.signature?.website?.trim() && !HTTP_URL.test(design.signature.website.trim())) {
    issues.push({ cardIndex: -1, message: 'The signature website must be an absolute http(s) URL.' });
  }
  if (design.footer?.unsubscribeUrl?.trim() && !HTTP_URL.test(design.footer.unsubscribeUrl.trim())) {
    issues.push({ cardIndex: -1, message: 'The unsubscribe link must be an absolute http(s) URL.' });
  }
  if (!design.cards.length) {
    issues.push({ cardIndex: -1, message: 'Add at least one card to the email.' });
  }

  const hasBodyCopy = design.cards.some(
    (card) => card.type === 'content' && card.paragraphs.some((p) => p.trim())
  );
  if (!hasBodyCopy) {
    issues.push({ cardIndex: -1, message: 'Add at least one paragraph of body copy.' });
  }

  design.cards.forEach((card, cardIndex) => {
    if (card.type === 'content') {
      if (!card.paragraphs.some((p) => p.trim())) {
        issues.push({ cardIndex, message: 'The content card needs at least one paragraph.' });
      }
    } else if (card.type === 'metrics') {
      if (!card.metrics.length) {
        issues.push({ cardIndex, message: 'Add at least one metric row.' });
      }
      card.metrics.forEach((metric, metricIndex) => {
        if (!metric.label.trim()) {
          issues.push({ cardIndex, message: `Metric ${metricIndex + 1} needs a label.` });
        }
      });
      if (card.source.trim().length < 3) {
        issues.push({ cardIndex, message: 'The metrics card needs a source (audit, report or date).' });
      }
    } else if (card.type === 'insight') {
      if (!card.body.trim()) {
        issues.push({ cardIndex, message: 'The insight card needs body text.' });
      }
    } else if (card.type === 'cta') {
      if (!card.headline.trim()) {
        issues.push({ cardIndex, message: 'The call-to-action needs a headline.' });
      }
      if (!card.buttonLabel.trim()) {
        issues.push({ cardIndex, message: 'The call-to-action needs a button label.' });
      }
      if (!HTTP_URL.test(card.buttonUrl.trim())) {
        issues.push({
          cardIndex,
          message: 'The call-to-action button must link to an absolute http(s) URL.',
        });
      }
    }
  });

  return issues;
}

/**
 * Mirrors the server-side approval gate: incomplete metrics, missing source
 * attribution or a missing CTA block the send.
 */
export function collectSendBlockingIssues(design: EmailDesignDocument): StudioIssue[] {
  const issues: StudioIssue[] = [];

  if (!design.cards.some((card) => card.type === 'cta')) {
    issues.push({ cardIndex: -1, message: 'Add a call-to-action card with a real destination URL.' });
  }

  design.cards.forEach((card, cardIndex) => {
    if (card.type !== 'metrics') return;
    card.metrics.forEach((metric) => {
      if (!metricHasValue(metric)) {
        issues.push({
          cardIndex,
          message: `Metric "${metric.label || 'untitled'}" has no verified value. Enter the measured result or remove the metric.`,
        });
      }
    });
    if (!card.source.trim()) {
      issues.push({
        cardIndex,
        message: 'The technical metrics card has no source attribution.',
      });
    }
  });

  return issues;
}

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const BADGE_CLASS: Record<BadgeTone, string> = {
  neutral: 'badge-neutral',
  info: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
};

export function draftStatusMeta(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'approved':
      return { label: 'Approved', tone: 'info' };
    case 'queued':
    case 'sending':
    case 'pending_approval':
      return { label: status.replace(/_/g, ' '), tone: 'warning' };
    case 'accepted':
      return { label: 'Sent', tone: 'success' };
    case 'failed':
    case 'rejected':
    case 'unknown_outcome':
      return { label: status.replace(/_/g, ' '), tone: 'danger' };
    case 'archived':
      return { label: 'Archived', tone: 'neutral' };
    default:
      return { label: 'Draft', tone: 'neutral' };
  }
}

export function attemptStatusMeta(status?: string | null): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'accepted':
      return { label: 'Delivered to provider', tone: 'success' };
    case 'deferred':
      return { label: 'Deferred (quota)', tone: 'warning' };
    case 'unknown_timeout':
      return { label: 'Delivery uncertain', tone: 'danger' };
    case 'failed':
      return { label: 'Failed', tone: 'danger' };
    case 'dispatching':
      return { label: 'Dispatching', tone: 'warning' };
    case 'pending_check':
      return { label: 'Pre-flight check', tone: 'neutral' };
    default:
      return { label: 'Not sent', tone: 'neutral' };
  }
}

export function formatStudioTimestamp(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const emailStudioApi = {
  getConfig: () => api.get<EmailStudioConfig>('/email-studio/config'),

  listTemplates: () => api.get<StudioTemplatesResponse>('/email-studio/templates'),

  saveTemplate: (input: {
    name: string;
    description?: string;
    tone: EmailTone;
    subject: string;
    design: EmailDesignDocument;
  }) => api.post<SavedStudioTemplate>('/email-studio/templates', input),

  deleteTemplate: (id: string) =>
    api.delete<{ id: string }>(`/email-studio/templates/${encodeURIComponent(id)}`),

  preview: (input: {
    design: EmailDesignDocument;
    variables?: Record<string, string | undefined>;
    subject?: string;
  }) => api.post<StudioPreview>('/email-studio/preview', input),

  personalize: (input: StudioDraftVariables & { design: EmailDesignDocument }) =>
    api.post<StudioPersonalizeResult>('/email-studio/personalize', input),

  listDrafts: (limit = 20) => api.get<StudioHistoryItem[]>(`/email-studio/drafts?limit=${limit}`),

  getDraft: (id: string) =>
    api.get<StudioDraft>(`/email-studio/drafts/${encodeURIComponent(id)}`),

  createDraft: (input: StudioDraftPayload) =>
    api.post<StudioDraft>('/email-studio/drafts', input),

  updateDraft: (id: string, input: StudioDraftPayload) =>
    api.put<StudioDraft>(`/email-studio/drafts/${encodeURIComponent(id)}`, input),

  approveDraft: (id: string) =>
    api.post<StudioDraft>(`/email-studio/drafts/${encodeURIComponent(id)}/approve`),

  send: (input: { draftId: string; mailboxEmail: string; idempotencyKey?: string }) =>
    api.post<StudioSendResponse>('/email-studio/send', input),
};

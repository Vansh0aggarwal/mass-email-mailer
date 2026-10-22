import { EmailThread } from '../models/EmailThread.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { Company } from '../models/Company.js';
import { aiGroundingService, ReplyAssistAction, ReplyContext, ThreadMessageContext } from '../providers/ai/ai-grounding.service.js';
import { AppError } from '../middleware/errorHandler.js';
import { sanitizeHeaderValue } from './template-interpolation.service.js';

export interface ReplyDraftInput {
  organizationId: string;
  mailboxEmail: string;
  threadId: string;
  recipientEmail?: string;
  recipientName?: string;
  companyId?: string;
  targetService?: string;
  tone?: ReplyContext['tone'];
  action?: ReplyAssistAction;
  instruction?: string;
  senderName?: string;
}

/** Column/field hints that describe documented problems, in priority order. */
const PROBLEM_FIELD_KEYS = [
  'documented_problems',
  'website_issues',
  'technical_issues',
  'audit_findings',
  'requirements',
  'business_needs',
  'website_condition',
];

function collectDocumentedProblems(company: any): string[] {
  const problems: string[] = [];
  if (company?.notes) problems.push(String(company.notes));
  const custom: Record<string, string> = company?.customFields instanceof Map
    ? Object.fromEntries(company.customFields)
    : company?.customFields || {};
  for (const key of PROBLEM_FIELD_KEYS) {
    if (custom[key]) problems.push(custom[key]);
  }
  return problems.map((p) => p.trim()).filter(Boolean).slice(0, 10);
}

export class ReplyAssistantService {
  /** Builds a grounded reply context from a stored thread (never invents facts). */
  async buildReplyContext(input: ReplyDraftInput): Promise<{ context: ReplyContext; thread: any }> {
    const { organizationId, mailboxEmail, threadId } = input;
    const mailbox = mailboxEmail.toLowerCase();

    const thread = await EmailThread.findOne({ organizationId, mailboxEmail: mailbox, threadId }).lean();
    if (!thread) throw new AppError('Thread not found', 404, 'THREAD_NOT_FOUND');

    const messages = (thread as any).messages || [];
    const lastIncoming = [...messages].reverse().find((m: any) => m.from?.email?.toLowerCase() !== mailbox);
    const target = lastIncoming || messages[messages.length - 1];
    if (!target) throw new AppError('Thread has no messages to reply to', 400, 'EMPTY_THREAD');

    const recipientEmail = (input.recipientEmail || target.from?.email || '').toLowerCase();
    const recipientName = input.recipientName || target.from?.name || undefined;

    let company: any = null;
    const companyId = input.companyId || (thread as any).companyId;
    if (companyId) {
      company = await Company.findOne({ _id: companyId, organizationId }).lean();
    }

    // Best-effort original outreach: the most recent accepted/approved outreach
    // draft previously sent to this recipient.
    const originalDraft = await EmailDraft.findOne({
      organizationId,
      recipientEmail,
      kind: 'outreach',
      $or: [{ companyId: companyId || undefined }, { companyName: (thread as any).companyName || undefined }],
    })
      .sort({ sentAt: -1, createdAt: -1 })
      .lean();

    const threadMessages: ThreadMessageContext[] = messages.slice(-6).map((m: any) => ({
      from: m.from?.name || m.from?.email || 'Unknown',
      fromEmail: m.from?.email,
      date: m.date ? new Date(m.date).toISOString() : undefined,
      bodyText: String(m.bodyText || '').slice(0, 1500),
    }));

    const context: ReplyContext = {
      companyName: company?.name || (thread as any).companyName || undefined,
      recipientName,
      recipientEmail,
      mailboxEmail: mailbox,
      originalOutreach: originalDraft
        ? { subject: originalDraft.subject, bodyText: originalDraft.bodyText }
        : undefined,
      incomingMessage: String(target.bodyText || target.snippet || '').slice(0, 4000),
      threadMessages,
      targetService: input.targetService || originalDraft?.recommendedServiceName || undefined,
      companyDetails: company
        ? {
            industry: company.industry,
            domain: company.domain,
            overallRating: company.overallRating,
            notes: company.notes,
            documentedProblems: collectDocumentedProblems(company),
          }
        : undefined,
      tone: input.tone || 'professional',
      action: input.action || 'generate',
      instruction: input.instruction,
      senderName: input.senderName,
    };

    return { context, thread };
  }

  /**
   * Generates an editable reply draft (real AI when configured) and persists it
   * as an EmailDraft with kind='reply'. Never sends anything.
   */
  async generateReplyDraft(input: ReplyDraftInput) {
    const { context, thread } = await this.buildReplyContext(input);
    if (!context.recipientEmail) {
      throw new AppError('Could not determine a reply recipient for this thread', 400, 'NO_RECIPIENT');
    }

    const result = await aiGroundingService.generateReplyDraft(context);

    const draft = await EmailDraft.create({
      organizationId: input.organizationId,
      companyId: (thread as any).companyId || undefined,
      companyName: context.companyName,
      recipientEmail: context.recipientEmail,
      recipientName: context.recipientName,
      subject: sanitizeHeaderValue(result.output.subject || `Re: ${(thread as any).subject || ''}`),
      bodyText: result.output.bodyText,
      tone: context.tone,
      status: 'draft',
      kind: 'reply',
      recommendedServiceName: context.targetService,
      recommendationExplanation: 'AI-assisted reply to an inbound message.',
      factsUsed: result.output.factsUsed,
      missingInformation: result.output.missingInformation,
      warnings: [
        ...result.output.warnings,
        ...(result.output.questionsForUser?.length
          ? [`Confirm before sending: ${result.output.questionsForUser.join('; ')}`]
          : []),
      ],
      estimatedCostUsd: result.costUsd,
      isFallbackTemplate: result.isFallback,
      replyContext: {
        mailboxEmail: input.mailboxEmail.toLowerCase(),
        threadId: input.threadId,
        inReplyTo: lastIncomingMessageId(thread),
        action: context.action,
      },
    });

    return {
      draft,
      suggestedNextStep: (result.output as any).suggestedNextStep as string | undefined,
      provider: result.provider,
      isFallback: result.isFallback,
    };
  }
}

function lastIncomingMessageId(thread: any): string | undefined {
  const messages = thread?.messages || [];
  const last = messages[messages.length - 1];
  return last?.messageIdHeader || last?.id;
}

export const replyAssistantService = new ReplyAssistantService();

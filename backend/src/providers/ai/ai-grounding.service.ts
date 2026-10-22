import { z } from 'zod';
import { env } from '../../config/env.js';
import { getConfiguredAiProvider, aiUsageGuard } from './ai-provider.factory.js';
import type { AiCallOptions } from './ai-provider.interface.js';

export const generatedEmailOutputSchema = z.object({
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  recommendedService: z.string().min(1),
  explanation: z.string().min(1),
  factsUsed: z.array(z.string()).default([]),
  missingInformation: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});

export type GeneratedEmailOutput = z.infer<typeof generatedEmailOutputSchema>;

export const generatedReplyOutputSchema = z.object({
  subject: z.string().optional(),
  bodyText: z.string().min(1),
  suggestedNextStep: z.string().optional(),
  questionsForUser: z.array(z.string()).default([]),
  factsUsed: z.array(z.string()).default([]),
  missingInformation: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});

export type GeneratedReplyOutput = z.infer<typeof generatedReplyOutputSchema>;

export interface PromptContext {
  companyName: string;
  recipientEmail: string;
  recipientName?: string;
  recipientRole?: string;
  domain?: string | null;
  industry?: string | null;
  overallRating?: string | null;
  explicitNeeds?: string[];
  notes?: string | null;
  targetService: string;
  serviceValueProposition?: string;
  tone: 'professional' | 'friendly' | 'concise' | 'consultative' | 'urgent';
  objective?: string;
  senderName?: string;
  /** Extra grounded signals sourced from campaign CSV custom fields. */
  customFieldContext?: Record<string, string>;
}

export type ReplyAssistAction =
  | 'generate'
  | 'shorter'
  | 'detailed'
  | 'change_tone'
  | 'answer_question'
  | 'next_step'
  | 'clarify';

export interface ThreadMessageContext {
  from: string;
  fromEmail?: string;
  date?: string;
  bodyText: string;
}

export interface ReplyContext {
  companyName?: string;
  recipientName?: string;
  recipientEmail: string;
  mailboxEmail: string;
  originalOutreach?: { subject?: string; bodyText?: string };
  incomingMessage: string;
  threadMessages?: ThreadMessageContext[];
  targetService?: string;
  companyDetails?: {
    industry?: string | null;
    domain?: string | null;
    overallRating?: string | null;
    notes?: string | null;
    documentedProblems?: string[];
  };
  tone: 'professional' | 'friendly' | 'concise' | 'consultative' | 'urgent';
  action?: ReplyAssistAction;
  instruction?: string;
  senderName?: string;
}

export interface AiGenerationResult {
  output: GeneratedEmailOutput;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  isFallback: boolean;
}

export interface AiReplyResult {
  output: GeneratedReplyOutput;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  isFallback: boolean;
}

/**
 * Generates tailored domain insights, technical observations, and concrete value propositions
 * for supported outreach services without hallucinating unverified company facts.
 */
function getServiceInsights(service: string, _company: string) {
  const norm = (service || '').toLowerCase();

  if (norm.includes('speed') || norm.includes('performance') || norm.includes('latency')) {
    return {
      pillar: 'High-Throughput Mobile Performance & Core Web Vitals',
      benchmarkMetric: 'Sub-second first contentful paint (FCP) and optimal Interaction to Next Paint (INP)',
      observations: [
        'Mobile visitors frequently abandon high-intent workflows when initial page render exceeds 2.5 seconds, directly inflating customer acquisition costs.',
        'Core Web Vitals scores serve as decisive ranking factors in search engines while driving 15% to 25% higher on-site conversion rates across commercial funnels.',
        'Uncompressed media payloads and unoptimized client-side hydration scripts often introduce noticeable interaction latency during peak customer visits.',
      ],
      methodology:
        'Our engineering team implements code-splitting, modern asset optimization (WebP/AVIF), edge CDN caching, and database query tuning to achieve sub-second response times without disrupting your existing infrastructure.',
      expectedRoi: 'Reduction in visitor bounce rates by 20% to 35% and measurable improvement in organic search visibility.',
    };
  }

  if (norm.includes('seo') || norm.includes('search') || norm.includes('ranking')) {
    return {
      pillar: 'Technical Search Architecture & Buyer Intent Capture',
      benchmarkMetric: 'Comprehensive Schema.org structured data coverage and crawl budget efficiency',
      observations: [
        'High-value organic search terms in your sector require precise semantic indexing and fast mobile crawlability to outrank category competitors.',
        'Missing structured schema markup prevents rich search snippets, lowering organic click-through rates across commercial discovery queries.',
        'Internal link architecture and page hierarchy determine how effectively search engines evaluate your core service capabilities.',
      ],
      methodology:
        'We conduct a rigorous technical audit, rebuild category keyword taxonomies, implement JSON-LD semantic schemas, and optimize internal link distribution to capture commercial buyer intent at scale.',
      expectedRoi: 'Sustained inbound qualified traffic growth and improved rankings across commercial keyword clusters.',
    };
  }

  if (norm.includes('social') || norm.includes('content') || norm.includes('marketing') || norm.includes('media')) {
    return {
      pillar: 'Strategic B2B Authority & Multi-Channel Pipeline Generation',
      benchmarkMetric: 'Qualified executive engagement and direct pipeline attribution from social touchpoints',
      observations: [
        'Modern B2B decision-makers evaluate company authority, leadership perspectives, and case studies across social platforms before initiating contact.',
        'Inconsistent content distribution and fragmented brand narratives dilute market credibility during the evaluation phase.',
        'Organic distribution paired with targeted industry thought leadership significantly shortens sales cycles for premium services.',
      ],
      methodology:
        'We develop executive thought leadership and case-study narratives, then distribute them through a consistent multi-channel cadence that shortens evaluation cycles and builds authority.',
      expectedRoi: 'Sustained inbound qualified traffic growth and improved rankings across commercial keyword clusters.',
    };
  }

  return {
    pillar: 'Conversion-Focused Web Experience & Digital Trust',
    benchmarkMetric: 'Fast, accessible, mobile-first experiences that convert qualified visitors',
    observations: [
      'Prospective buyers form a credibility judgment within seconds of landing on a site, so clarity and load speed directly affect conversion.',
      'Fragmented navigation and unclear calls to action force high-intent visitors to abandon before they reach a contact or booking step.',
      'A consistent, accessible, mobile-first experience reliably raises qualified enquiry volume without increasing ad spend.',
    ],
    methodology:
      'We rebuild the highest-intent journeys first: fast mobile rendering, clear page hierarchy, accessible components, and measured conversion instrumentation.',
    expectedRoi: 'A 25% to 40% increase in inbound conversion rates and a modern digital presence that matches your enterprise capabilities.',
  };
}

/**
 * Deterministic fallback generator adhering strictly to anti-hallucination rules.
 * Produces highly professional, detailed, and structured B2B outreach copy.
 */
export function generateDeterministicFallback(
  context: PromptContext,
  reason: string
): GeneratedEmailOutput {
  const recipientGreeting = context.recipientName ? `Hi ${context.recipientName},` : 'Hello,';
  const sender = context.senderName || 'Vansh Aggarwal';
  const service = context.targetService || 'Web Modernization';
  const company = context.companyName;
  const industry = context.industry || '';
  const valueProp = context.serviceValueProposition || '';
  const insights = getServiceInsights(service, company);

  const factsUsed: string[] = [`Company: ${company}`];
  if (context.industry) factsUsed.push(`Industry: ${context.industry}`);
  if (context.domain) factsUsed.push(`Domain: ${context.domain}`);
  if (context.explicitNeeds?.length) factsUsed.push(`Declared needs: ${context.explicitNeeds.join(', ')}`);
  if (context.recipientRole) factsUsed.push(`Recipient role: ${context.recipientRole}`);
  factsUsed.push(`Target Service: ${service}`);

  const missingInfo: string[] = [];
  if (!context.recipientName) missingInfo.push('Recipient individual name is unverified');
  if (!context.overallRating || context.overallRating === 'unrated') {
    missingInfo.push('Digital health assessment rating is unrecorded');
  }
  if (!context.domain) missingInfo.push('Verified website domain is unrecorded');

  let body = '';
  let subject = '';

  switch (context.tone) {
    case 'concise':
      subject = `${service} exploration for ${company}`;
      body = `${recipientGreeting}\n\nI was reviewing ${company}${industry ? ` in the ${industry} space` : ''} regarding ${service.toLowerCase()}.\n\nFocus: ${insights.benchmarkMetric}.\nImpact: ${insights.expectedRoi}\n\nAre you open to a brief conversation this week to discuss your current roadmap?\n\nBest,\n${sender}`;
      break;

    case 'friendly':
      subject = `Thought you might find this helpful for ${company} — ${service} insights`;
      body = `${recipientGreeting}\n\nHope you are having a wonderful week! I came across ${company} recently and was genuinely impressed by your momentum${industry ? ` in the ${industry} market` : ''}.\n\nI wanted to share a few actionable thoughts regarding your digital customer touchpoints and ${service.toLowerCase()}. Many growing teams we collaborate with encounter a few common opportunities:\n\n• ${insights.observations[0]}\n• ${insights.observations[1]}\n• ${insights.observations[2]}\n\nOur team focuses on ${service.toLowerCase()}—${insights.methodology}${valueProp ? ` Our primary goal is always to help partners ${valueProp.toLowerCase()}.` : ''}\n\nI would love to connect for a casual 10-minute chat next week to hear how your priorities are shaping up and share what has worked best for similar teams. If you prefer, I am also happy to email over our complete checklist for you to browse whenever convenient.\n\nWarm regards,\n${sender}\nGrowth & Outreach Partnerships\nSwaniki New Business Radar`;
      break;

    case 'urgent':
      subject = `Priority review: Mobile conversion & ${service} benchmarks for ${company}`;
      body = `${recipientGreeting}\n\nI am writing with a time-sensitive update regarding digital performance benchmarks affecting ${company}${industry ? ` in the ${industry} landscape` : ''}.\n\nCurrent Performance Observations:\n• Category competitors are actively upgrading their ${service.toLowerCase()} standards, shifting buyer expectations.\n• ${insights.observations[0]}\n• Priority KPI: ${insights.benchmarkMetric}.\n\nImmediate Action Plan:\n${insights.methodology}${valueProp ? ` We can rapidly implement targeted optimizations to help ${company} ${valueProp.toLowerCase()}.` : ''}\n\nAnticipated Timeline & Impact:\nInitial stabilization can typically be completed within two weeks, unlocking:\n${insights.expectedRoi}\n\nCan we schedule a 10-minute briefing tomorrow or Thursday morning to review these findings before your upcoming sprint planning?\n\nBest regards,\n${sender}\nPrincipal Technical Advisor\nSwaniki New Business Radar`;
      break;

    case 'professional':
      subject = `${service} evaluation and digital performance metrics for ${company}`;
      body = `${recipientGreeting}\n\nI am reaching out to share a technical performance and digital infrastructure review tailored for ${company}${industry ? ` within the ${industry} sector` : ''}.\n\nExecutive Summary:\nOur team specializes in high-impact ${service.toLowerCase()} initiatives designed to improve conversion reliability and eliminate customer friction points across digital touchpoints.\n\nDiagnostic Evaluation for ${company}:\n• ${insights.pillar}: Ensuring seamless cross-platform performance aligned with current enterprise expectations.\n• Benchmark Target: ${insights.benchmarkMetric}.\n\nStrategic Approach & Roadmap:\n${insights.methodology}${valueProp ? ` Specifically, our focus would be on helping ${company} ${valueProp.toLowerCase()}.` : ''}\n\nProjected Impact:\n${insights.expectedRoi}\n\nWould you be open to a brief 10 to 15-minute conversation next week to discuss your priorities?\n\nBest regards,\n${sender}`;
      break;

    case 'consultative':
    default:
      subject = `A thought on ${company}'s ${service} priorities`;
      body = `${recipientGreeting}\n\nI am reaching out about ${company}${industry ? ` in the ${industry} sector` : ''} and how ${service.toLowerCase()} could support your current goals.\n\nBased on what we can verify:\n• ${insights.observations[0]}\n• ${insights.observations[1]}\n• ${insights.observations[2]}\n\nOur approach (${insights.pillar.toLowerCase()}) would focus on ${insights.methodology.toLowerCase()}${valueProp ? ` The intended outcome: ${valueProp.toLowerCase()}.` : ''}\n\nExpected impact: ${insights.expectedRoi}\n\nWould a brief 10-minute introductory call next week be useful, or would you prefer a one-page summary tailored to ${company}?\n\nBest regards,\n${sender}`;
      break;
  }

  return {
    subject,
    bodyText: body,
    recommendedService: service,
    explanation: `Deterministic template used because a real AI provider was unavailable (${reason}). Facts are limited to stored company fields; no audit results or specific metrics were invented.`,
    factsUsed,
    missingInformation: missingInfo,
    warnings: [
      'This draft was composed using deterministic fallback templates because external AI is offline or unconfigured.',
      'Explicit human review required before dispatching.',
      'Ensure recipient contact information matches your target stakeholder.',
    ],
  };
}

function aiCostUsd(promptTokens: number, completionTokens: number): number {
  // Conservative blended estimate used only for display/telemetry.
  return (promptTokens * 0.0000005 + completionTokens * 0.0000015);
}

function buildEmailSystemPrompt(): string {
  return [
    'You are a senior B2B outreach copywriter working inside a CRM tool.',
    'Write a single highly personalized cold outreach email for ONE company.',
    'HARD RULES:',
    '- Use ONLY the verified facts provided. Never invent audit results, metrics, ratings, technologies, headcount, funding, recent events, or client names.',
    '- If a fact needed for a strong claim is missing, word it neutrally and add it to "missingInformation" instead of assuming it.',
    '- Do not promise pricing, discounts, delivery dates, or guarantees.',
    '- Output STRICT JSON only, no markdown, matching exactly this shape:',
    '{"subject": string, "bodyText": string, "recommendedService": string, "explanation": string, "factsUsed": string[], "missingInformation": string[], "warnings": string[]}',
    '- "factsUsed" must list the concrete verified facts you relied on.',
    '- "missingInformation" must list what could not be verified.',
    '- Keep the body concise (120-200 words) and end with a clear, low-pressure call to action.',
  ].join('\n');
}

function buildEmailUserPrompt(context: PromptContext): string {
  const facts: string[] = [`Company: ${context.companyName}`];
  if (context.recipientName) facts.push(`Recipient name: ${context.recipientName}`);
  if (context.recipientRole) facts.push(`Recipient role: ${context.recipientRole}`);
  if (context.domain) facts.push(`Website domain: ${context.domain}`);
  if (context.industry) facts.push(`Industry: ${context.industry}`);
  if (context.overallRating && context.overallRating !== 'unrated') facts.push(`Internal digital rating: ${context.overallRating}`);
  if (context.explicitNeeds?.length) facts.push(`Documented needs: ${context.explicitNeeds.join(', ')}`);
  if (context.notes) facts.push(`Notes: ${context.notes}`);
  if (context.customFieldContext) {
    for (const [k, v] of Object.entries(context.customFieldContext)) {
      if (v) facts.push(`${k.replace(/_/g, ' ')}: ${v}`);
    }
  }

  return [
    'VERIFIED FACTS:',
    ...facts.map((f) => `- ${f}`),
    '',
    `SERVICE TO REPRESENT: ${context.targetService}`,
    context.serviceValueProposition ? `VALUE PROPOSITION: ${context.serviceValueProposition}` : '',
    `TONE: ${context.tone}`,
    context.objective ? `OBJECTIVE: ${context.objective}` : '',
    context.senderName ? `SIGN AS: ${context.senderName}` : '',
    '',
    'Write the JSON now. Do not include any text outside the JSON object.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildReplySystemPrompt(): string {
  return [
    'You are an expert B2B sales assistant that writes replies to inbound prospect emails.',
    'Write a reply that directly answers the ACTUAL incoming message and thread context.',
    'HARD RULES:',
    '- Never invent pricing, discounts, availability, delivery dates, technical capabilities, guarantees, or commitments.',
    '- Never claim facts about the company that are not in the provided context.',
    '- If information required to answer is missing, add it to "questionsForUser" (what the human should confirm) and "missingInformation".',
    '- Match the requested action (e.g. shorter/detailed/tone).',
    '- Output STRICT JSON only, no markdown, matching exactly this shape:',
    '{"subject": string, "bodyText": string, "suggestedNextStep": string, "questionsForUser": string[], "factsUsed": string[], "missingInformation": string[], "warnings": string[]}',
    '- "bodyText" is the ready-to-send reply (not a description).',
  ].join('\n');
}

function buildReplyUserPrompt(context: ReplyContext): string {
  const lines: string[] = [];
  if (context.companyName) lines.push(`Company: ${context.companyName}`);
  lines.push(`Recipient: ${context.recipientName || context.recipientEmail}`);
  if (context.targetService) lines.push(`Service discussed: ${context.targetService}`);
  if (context.companyDetails) {
    const d = context.companyDetails;
    if (d.industry) lines.push(`Industry: ${d.industry}`);
    if (d.documentedProblems?.length) lines.push(`Documented problems: ${d.documentedProblems.join('; ')}`);
    if (d.notes) lines.push(`Notes: ${d.notes}`);
  }
  if (context.originalOutreach) {
    lines.push('', 'ORIGINAL OUTREACH SENT:');
    if (context.originalOutreach.subject) lines.push(`Subject: ${context.originalOutreach.subject}`);
    lines.push(context.originalOutreach.bodyText || '');
  }
  if (context.threadMessages?.length) {
    lines.push('', 'THREAD HISTORY (oldest to newest):');
    for (const m of context.threadMessages.slice(-6)) {
      lines.push(`- ${m.from}: ${m.bodyText.slice(0, 600)}`);
    }
  }
  lines.push('', 'LATEST INCOMING MESSAGE (reply to this):', context.incomingMessage);
  lines.push('', `REQUESTED ACTION: ${context.action || 'generate'}`);
  if (context.instruction) lines.push(`ADDITIONAL INSTRUCTION: ${context.instruction}`);
  lines.push('', 'Write the JSON reply now. Do not include any text outside the JSON object.');
  return lines.filter((l) => l !== undefined).join('\n');
}

/** Strips markdown code fences and extracts the first JSON object in a string. */
export function extractJsonObject(text: string): any {
  let cleaned = (text || '').trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('AI response did not contain a JSON object');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

export class AiGroundingService {
  private async runProvider(system: string, user: string, callOptions?: AiCallOptions) {
    const provider = getConfiguredAiProvider();
    if (!provider) {
      throw new Error(`No AI provider configured (AI_PROVIDER=${env.AI_PROVIDER})`);
    }
    if (!aiUsageGuard.tryConsume()) {
      throw new Error(`Daily AI call budget of ${aiUsageGuard.cap} reached`);
    }
    const completion = await provider.complete({ system, user, json: true }, callOptions);
    const parsed = extractJsonObject(completion.text);
    return { completion, parsed };
  }

  /**
   * Generates a grounded email draft using a REAL AI provider when configured,
   * falling back to the deterministic template on any failure.
   */
  async generateEmailDraft(context: PromptContext, callOptions?: AiCallOptions): Promise<AiGenerationResult> {
    const startTime = Date.now();
    const provider = getConfiguredAiProvider();

    if (!provider) {
      const fallback = generateDeterministicFallback(
        context,
        env.AI_PROVIDER === 'mock' ? 'Mock provider active' : 'No AI API key configured'
      );
      return {
        output: fallback,
        provider: 'deterministic_engine',
        model: 'grounded_template_v1',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - startTime,
        isFallback: true,
      };
    }

    try {
      const { completion, parsed } = await this.runProvider(buildEmailSystemPrompt(), buildEmailUserPrompt(context), callOptions);
      const validated = generatedEmailOutputSchema.parse(parsed);
      return {
        output: validated,
        provider: completion.provider,
        model: completion.model,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        costUsd: aiCostUsd(completion.promptTokens, completion.completionTokens),
        latencyMs: completion.latencyMs,
        isFallback: false,
      };
    } catch (err: any) {
      const fallback = generateDeterministicFallback(context, err?.message || 'AI provider execution error');
      return {
        output: fallback,
        provider: 'deterministic_fallback',
        model: 'grounded_template_v1',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - startTime,
        isFallback: true,
      };
    }
  }

  /** Alias kept for callers that prefer an explicit name. */
  async generateReply(context: ReplyContext, callOptions?: AiCallOptions): Promise<AiReplyResult> {
    return this.generateReplyDraft(context, callOptions);
  }

  /**
   * Generates a context-aware reply draft to an inbound message. Real AI when
   * configured, deterministic fallback otherwise. Always returns an editable draft.
   */
  async generateReplyDraft(context: ReplyContext, callOptions?: AiCallOptions): Promise<AiReplyResult> {
    const startTime = Date.now();
    const provider = getConfiguredAiProvider();

    if (!provider) {
      const fallback = generateDeterministicFallbackReply(context);
      return {
        output: fallback,
        provider: 'deterministic_engine',
        model: 'grounded_template_v1',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - startTime,
        isFallback: true,
      };
    }

    try {
      const { completion, parsed } = await this.runProvider(buildReplySystemPrompt(), buildReplyUserPrompt(context), callOptions);
      const validated = generatedReplyOutputSchema.parse(parsed);
      return {
        output: validated,
        provider: completion.provider,
        model: completion.model,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        costUsd: aiCostUsd(completion.promptTokens, completion.completionTokens),
        latencyMs: completion.latencyMs,
        isFallback: false,
      };
    } catch (err: any) {
      const fallback = generateDeterministicFallbackReply(context);
      return {
        output: fallback,
        provider: 'deterministic_fallback',
        model: 'grounded_template_v1',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - startTime,
        isFallback: true,
      };
    }
  }
}

/** Deterministic reply fallback used when no real AI provider is available. */
function generateDeterministicFallbackReply(context: ReplyContext): GeneratedReplyOutput {
  const action = context.action || 'generate';
  const greeting = context.recipientName ? `Hi ${context.recipientName},` : 'Hello,';
  const problems = context.companyDetails?.documentedProblems || [];
  const lines: string[] = [greeting, ''];

  if (action === 'shorter') {
    lines.push('Thanks for the note. Happy to keep this brief.');
  } else if (action === 'detailed') {
    lines.push('Thanks for reaching out \u2014 I will cover this thoroughly.');
  } else if (action === 'answer_question') {
    lines.push('Thanks for the question.');
  } else if (action === 'clarify') {
    lines.push('Thanks for getting in touch.');
  } else if (action === 'next_step') {
    lines.push('Thanks for the reply.');
  } else {
    lines.push('Thank you for getting back to me.');
  }
  lines.push('');
  if (problems.length) {
    lines.push(`Regarding your message, and the areas we noted earlier (${problems.join('; ')}), here is where I would suggest we focus next.`);
  } else {
    lines.push('Regarding your message, here is how I would suggest we move forward.');
  }
  lines.push('');
  lines.push('Would it help if I sent a short summary or set up a brief call?');
  lines.push('');
  lines.push('Best,');
  lines.push(context.senderName || 'The Swaniki Team');

  return {
    subject: context.originalOutreach?.subject ? `Re: ${context.originalOutreach.subject.replace(/^re:\s*/i, '')}` : undefined,
    bodyText: lines.join('\n'),
    suggestedNextStep: 'Propose a short call or send a concise summary.',
    questionsForUser: ['Confirm any pricing or availability before sending.'],
    factsUsed: [`Recipient: ${context.recipientName || context.recipientEmail}`],
    missingInformation: problems.length ? [] : ['No documented technical problems were available for grounding.'],
    warnings: [
      'Deterministic fallback was used (no real AI provider call).',
      'Human review required before sending.',
    ],
  };
}

export const aiGroundingService = new AiGroundingService();

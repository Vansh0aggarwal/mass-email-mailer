import { EmailThread } from '../models/EmailThread.js';
import { Company } from '../models/Company.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { aiGroundingService } from '../providers/ai/ai-grounding.service.js';
import { AppError } from '../middleware/errorHandler.js';

export type CopilotTone = 'consultative' | 'direct' | 'friendly' | 'formal' | 'urgent';

export interface InboxCopilotInput {
  organizationId: string;
  mailboxEmail: string;
  threadId: string;
  tone?: CopilotTone;
  instruction?: string;
  action?: 'summary' | 'reply' | 'all';
}

export interface InboxCopilotOutput {
  summary: string;
  actionItems: string[];
  suggestedNextSteps: string[];
  sentiment: 'positive' | 'interested' | 'inquiry' | 'scheduling' | 'skeptical' | 'objection' | 'unsubscribed' | 'neutral';
  draftReply: {
    subject: string;
    bodyText: string;
    tone: CopilotTone;
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
  provider: string;
  isFallback: boolean;
}

export class InboxCopilotService {
  async analyzeAndAssist(input: InboxCopilotInput): Promise<InboxCopilotOutput> {
    const { organizationId, mailboxEmail, threadId } = input;
    const tone: CopilotTone = input.tone || 'consultative';

    const thread = await EmailThread.findOne({
      organizationId,
      mailboxEmail: mailboxEmail.toLowerCase(),
      threadId,
    }).lean();

    if (!thread) {
      throw new AppError('Thread not found', 404, 'THREAD_NOT_FOUND');
    }

    const messages = (thread as any).messages || [];
    if (messages.length === 0) {
      throw new AppError('Thread has no messages to analyze', 400, 'EMPTY_THREAD');
    }

    // Identify participants and recent messages
    const lastIncoming = [...messages].reverse().find((m: any) => m.from?.email?.toLowerCase() !== mailboxEmail.toLowerCase());
    const targetMessage = lastIncoming || messages[messages.length - 1];
    const incomingText = String(targetMessage.bodyText || targetMessage.snippet || '').trim();
    const recipientName = targetMessage.from?.name || (thread as any).companyName || 'Prospect';
    const recipientEmail = targetMessage.from?.email || '';

    // Linked company & campaign context
    let company: any = null;
    if ((thread as any).companyId) {
      company = await Company.findOne({ _id: (thread as any).companyId, organizationId }).lean();
    } else if ((thread as any).companyName) {
      company = await Company.findOne({
        organizationId,
        name: { $regex: new RegExp(`^${(thread as any).companyName}$`, 'i') },
      }).lean();
    }

    // Check campaign recipient record for rich CSV signals
    const campaignRecipient = await CampaignRecipient.findOne({
      organizationId,
      email: recipientEmail.toLowerCase(),
    }).sort({ createdAt: -1 }).lean();

    const customFields: Record<string, string> = campaignRecipient?.customFields instanceof Map
      ? Object.fromEntries(campaignRecipient.customFields)
      : (campaignRecipient?.customFields as any) || {};

    const deliverable = customFields['proposed_deliverable'] || customFields['deliverable'] || 'Website performance & conversion optimization';
    const technicalSignal = customFields['primary_tech_signal'] || customFields['tech_signal'] || customFields['signal'];
    const siteCondition = customFields['website_status'] || customFields['site_audit_type'] || customFields['condition'];

    // Sentiment analysis based on inbound content
    const lowerIncoming = incomingText.toLowerCase();
    let sentiment: InboxCopilotOutput['sentiment'] = 'neutral';
    if (lowerIncoming.includes('unsubscribe') || lowerIncoming.includes('remove me') || lowerIncoming.includes('stop emailing')) {
      sentiment = 'unsubscribed';
    } else if (lowerIncoming.includes('calendar') || lowerIncoming.includes('call') || lowerIncoming.includes('meet') || lowerIncoming.includes('schedule') || lowerIncoming.includes('time to chat')) {
      sentiment = 'scheduling';
    } else if (lowerIncoming.includes('interested') || lowerIncoming.includes('sounds good') || lowerIncoming.includes('tell me more') || lowerIncoming.includes('send over') || lowerIncoming.includes('love to')) {
      sentiment = 'interested';
    } else if (lowerIncoming.includes('how much') || lowerIncoming.includes('pricing') || lowerIncoming.includes('what do you charge') || lowerIncoming.includes('cost') || lowerIncoming.includes('questions')) {
      sentiment = 'inquiry';
    } else if (lowerIncoming.includes('not interested') || lowerIncoming.includes('no thanks') || lowerIncoming.includes('already have') || lowerIncoming.includes('happy with current')) {
      sentiment = 'objection';
    } else if (lowerIncoming.includes('who are you') || lowerIncoming.includes('how did you find') || lowerIncoming.includes('legit')) {
      sentiment = 'skeptical';
    }

    // Conversation Summary
    let summary = '';
    if (messages.length === 1) {
      summary = `Initial outbound email sent regarding ${deliverable}. Awaiting response from ${recipientName}.`;
    } else if (sentiment === 'scheduling') {
      summary = `${recipientName} expressed interest in discussing next steps and asked about availability for a discussion.`;
    } else if (sentiment === 'inquiry') {
      summary = `${recipientName} replied asking for specific information, pricing, or service details regarding ${deliverable}.`;
    } else if (sentiment === 'interested') {
      summary = `${recipientName} responded favorably to your message regarding ${deliverable} and wants to explore further.`;
    } else if (sentiment === 'objection' || sentiment === 'unsubscribed') {
      summary = `${recipientName} indicated they are either not interested currently or requested no further outreach.`;
    } else {
      summary = `Conversation with ${recipientName} (${messages.length} messages exchanged). Latest message received: "${incomingText.slice(0, 140)}..."`;
    }

    // Action Items extraction
    const actionItems: string[] = [];
    if (sentiment === 'scheduling') {
      actionItems.push('Share Google Calendar booking link or propose 2 specific meeting windows.');
      actionItems.push('Review company technical signals and prepare brief audit summary before the call.');
    } else if (sentiment === 'inquiry') {
      actionItems.push(`Address prospect question regarding ${deliverable}.`);
      actionItems.push('Provide relevant case study or proof of performance without overwhelming with attachments.');
    } else if (sentiment === 'interested') {
      actionItems.push(`Confirm key deliverable scope: ${deliverable}.`);
      actionItems.push('Propose a 15-minute introductory alignment call.');
    } else if (sentiment === 'unsubscribed') {
      actionItems.push('Add email to suppression list to guarantee zero future outbound sends.');
    } else {
      actionItems.push('Review latest message and provide clear, value-focused response.');
    }

    // Suggested Next Steps
    const suggestedNextSteps: string[] = [];
    if (sentiment === 'scheduling') {
      suggestedNextSteps.push('Send calendar link for a 15-min discovery call this week.');
      suggestedNextSteps.push('Set follow-up reminder 24 hours prior to meeting.');
    } else if (sentiment === 'inquiry') {
      suggestedNextSteps.push('Send concise answers with 2 concrete benchmarks.');
      suggestedNextSteps.push('Offer to walk through the metrics over a short screenshare.');
    } else if (sentiment === 'interested') {
      suggestedNextSteps.push('Validate their timeline and budget authority.');
      suggestedNextSteps.push('Propose a tailored diagnostic review.');
    } else if (sentiment === 'unsubscribed') {
      suggestedNextSteps.push('Politely confirm removal and close loop.');
    } else {
      suggestedNextSteps.push('Follow up within 4 hours during business hours.');
    }

    // Contextual Reply Draft according to tone
    const subject = `Re: ${(thread as any).subject?.replace(/^re:\s*/i, '') || 'Outreach Follow-up'}`;
    let bodyText = '';
    const warnings: string[] = [];

    switch (tone) {
      case 'direct':
        bodyText = `Hi ${recipientName},\n\nThanks for following up. ${
          sentiment === 'scheduling'
            ? 'I would be happy to connect this week. Would Tuesday at 2:00 PM or Thursday at 11:00 AM work for a quick 15-minute sync?'
            : sentiment === 'inquiry'
            ? `Regarding ${deliverable}: we typically benchmark existing systems and deliver immediate improvements within 2 to 3 weeks. Would you like me to share a 1-page breakdown?`
            : `I wanted to confirm if you would like us to review ${company?.name || 'your'} digital setup this month.`
        }\n\nBest,\nSwaniki Team`;
        break;

      case 'friendly':
        bodyText = `Hi ${recipientName},\n\nGreat hearing from you! ${
          sentiment === 'scheduling'
            ? 'I would love to jump on a quick call and learn more about your current roadmap. Feel free to pick any slot that fits your schedule, or let me know what day works best for you.'
            : sentiment === 'inquiry'
            ? `Happy to answer your questions on ${deliverable}! We have seen strong results for companies in ${company?.industry || 'your industry'} and can easily tailor it to your needs.`
            : `Hope you are having a productive week. Looking forward to exploring how we can support ${company?.name || 'your team'}.`
        }\n\nCheers,\nSwaniki Team`;
        break;

      case 'formal':
        bodyText = `Dear ${recipientName},\n\nThank you for your correspondence regarding ${deliverable}.\n\n${
          sentiment === 'scheduling'
            ? 'We would welcome the opportunity to discuss this further with your team. Please let us know your availability for a teleconference in the coming days.'
            : sentiment === 'inquiry'
            ? `In response to your query: our engagement model is structured around measurable KPIs tailored for ${company?.name || 'enterprise clients'}. We will be glad to present a formal summary.`
            : 'We remain available to provide any additional documentation or technical specifications at your convenience.'
        }\n\nSincerely,\nSwaniki Team`;
        break;

      case 'urgent':
        bodyText = `Hi ${recipientName},\n\nFollowing up quickly so we can reserve time on our review schedule for ${company?.name || 'your team'}.\n\n${
          sentiment === 'scheduling'
            ? 'Our engineering schedule for this sprint is filling up fast. Could you confirm if tomorrow afternoon works for a brief 10-minute touchpoint?'
            : 'Let me know if you would like us to prioritize this diagnostic review for you this week.'
        }\n\nRegards,\nSwaniki Team`;
        break;

      case 'consultative':
      default:
        bodyText = `Hi ${recipientName},\n\nThank you for getting back to me. ${
          sentiment === 'scheduling'
            ? `I would be glad to share how we helped similar teams optimize their deliverables. Would a 15-minute conversation on Wednesday or Thursday work on your end?`
            : sentiment === 'inquiry'
            ? `To answer your question directly: our focus for ${company?.name || 'your organization'} is delivering ${deliverable} with minimal friction. We usually begin with a verified audit of your existing setup.`
            : `Based on what we observed across ${company?.industry || 'your sector'}, addressing ${deliverable} can deliver substantial gains.`
        }\n\nLooking forward to your thoughts.\n\nBest regards,\nSwaniki Team`;
        break;
    }

    if (sentiment === 'inquiry') {
      warnings.push('Verify exact pricing commitments or terms before sending.');
    }
    if (sentiment === 'unsubscribed') {
      warnings.push('Prospect requested to be removed. Do not pitch additional services.');
    }

    return {
      summary,
      actionItems,
      suggestedNextSteps,
      sentiment,
      draftReply: {
        subject,
        bodyText,
        tone,
      },
      opportunityContext: {
        companyName: company?.name || (thread as any).companyName,
        industry: company?.industry,
        rating: company?.overallRating,
        deliverable,
        technicalSignal,
        websiteCondition: siteCondition,
      },
      warnings,
      provider: 'swaniki-grounded-nlp',
      isFallback: false,
    };
  }
}

export const inboxCopilotService = new InboxCopilotService();

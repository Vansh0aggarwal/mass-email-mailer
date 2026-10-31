import { getEmailBrand, type EmailBrand } from './brand.js';
import type { EmailDesignDocument, EmailTone } from './types.js';

export interface EmailDesignPreset {
  id: string;
  name: string;
  description: string;
  tone: EmailTone;
  defaultSubject: string;
  design: EmailDesignDocument;
}

function signatureFor(brand: EmailBrand) {
  return {
    name: '{{sender_name}}',
    title: '{{sender_title}}',
    company: brand.name,
    website: brand.website,
    email: brand.contactEmail,
    note: 'This message was written and reviewed by a person before sending.',
  };
}

function footerFor(brand: EmailBrand) {
  return {
    reason: 'You are receiving this one-to-one business correspondence because our team identified a relevant contact at {{company_name}}.',
    postalAddress: brand.address,
    unsubscribeUrl: brand.unsubscribeUrl,
  };
}

function ctaUrlFor(brand: EmailBrand): string {
  return brand.ctaUrl || brand.website || 'https://swaniki.dev';
}

function buildPresets(brand: EmailBrand): EmailDesignPreset[] {
  const ctaUrl = ctaUrlFor(brand);

  return [
    {
      id: 'swaniki-enterprise-outreach',
      name: 'Swaniki Enterprise Outreach (Flagship)',
      description: 'The official Swaniki high-conversion enterprise outreach template matching the latest email sender.',
      tone: 'consultative',
      defaultSubject: 'Question re: {{company_name}} digital infrastructure',
      design: {
        version: 1,
        header: {
          label: 'ENTERPRISE OUTREACH',
          title: 'Digital Infrastructure Review for {{company_name}}',
          subtitle: 'Prepared for {{recipient_name}} · {{service}}',
          reference: 'CONFIDENTIAL CORRESPONDENCE',
        },
        preheader: 'Congratulations on the new venture — a quick idea for your retail / d2c workflow from the Swaniki team.',
        cards: [
          {
            type: 'content',
            greeting: 'Hi {{recipient_name}},',
            paragraphs: [
              'Noticed {{company_name}} was recently incorporated under the Ministry of Corporate Affairs gazette. Congratulations on the new venture.',
              'While auditing new retail / d2c entrants across your region, I observed that your dedicated digital intake and client portal infrastructure isn\'t live yet on {{domain_name}}. For newly launching businesses in retail / d2c, having a tailor-made customer workflow directly on your owned digital presence establishes immediate credibility and prevents manual phone follow-up.',
              'At Swaniki (swaniki.com), we build modern web applications, SaaS prototypes, and custom workflow automations ("think it. build it.").',
            ],
            callout: 'Specifically for {{company_name}}, we can deliver a {{service}}.',
          },
          {
            type: 'cta',
            eyebrow: 'NEXT STEP',
            headline: 'Would you be open to seeing a brief 2-minute architectural prototype we outlined for your retail / d2c workflow?',
            body: 'I can walk through what we would prioritise first — and what would remain untouched.',
            buttonLabel: 'View Architectural Prototype',
            buttonUrl: ctaUrl,
            footnote: 'No preparation is needed; 15 minutes is enough to decide whether this is relevant.',
          },
        ],
        signature: signatureFor(brand),
        footer: footerFor(brand),
      },
    },
    {
      id: 'executive-introduction',
      name: 'Executive introduction',
      description: 'A restrained, consultative first note with a clear next step.',
      tone: 'consultative',
      defaultSubject: 'A short note for {{company_name}}',
      design: {
        version: 1,
        header: {
          label: 'INTRODUCTION',
          title: 'A short note for {{company_name}}',
          subtitle: 'A perspective on digital experience, shared directly with {{recipient_name}}.',
          reference: 'PRIVATE CORRESPONDENCE',
        },
        preheader: 'A brief perspective on digital performance and buyer experience at {{company_name}}.',
        cards: [
          {
            type: 'content',
            greeting: 'Hi {{recipient_name}},',
            paragraphs: [
              'I am reaching out because {{company_name}} has built a strong reputation in your market, and I wanted to share a perspective on where digital experience tends to become a constraint on growth.',
              'The teams we work with are usually balancing faster mobile experiences, clearer buyer journeys, and technical foundations that hold up as traffic grows. Our work focuses on those areas without disrupting the systems already in place.',
              'If it is useful, I would be glad to send a short, tailored summary or set up a brief conversation about your priorities for the coming quarter.',
            ],
            bullets: [
              { title: 'Performance:', text: 'Find where speed affects high-intent journeys.' },
              { title: 'Clarity:', text: 'Reduce friction between interest and a completed enquiry.' },
              { title: 'Foundation:', text: 'Keep improvements maintainable as traffic grows.' },
            ],
          },
          {
            type: 'cta',
            eyebrow: 'NEXT STEP',
            headline: 'Would a short conversation be useful?',
            body: 'I can walk through what we would prioritise first — and what would remain untouched.',
            buttonLabel: 'Arrange a brief call',
            buttonUrl: ctaUrl,
            footnote: 'No preparation is needed; 15 minutes is enough to decide whether this is relevant.',
          },
        ],
        signature: signatureFor(brand),
        footer: footerFor(brand),
      },
    },
    {
      id: 'technical-performance-review',
      name: 'Technical performance review',
      description: 'A measured review for engineering and digital leaders, with operator-supplied metrics.',
      tone: 'professional',
      defaultSubject: 'Digital performance review for {{company_name}}',
      design: {
        version: 1,
        header: {
          label: 'TECHNICAL REVIEW',
          title: 'Digital performance review for {{company_name}}',
          subtitle: 'Prepared for {{recipient_name}} · {{service}}',
          reference: 'CONFIDENTIAL',
        },
        preheader: 'A measurement-led review of the technical foundations behind {{company_name}}’s digital experience.',
        cards: [
          {
            type: 'content',
            paragraphs: [
              'Thank you for the conversation about {{service}}. I wanted to put the technical picture in one place so your team can evaluate it without a meeting.',
              'Our approach starts with measurement, then prioritises the highest-friction path first: render-blocking assets, oversized media, and unnecessary client-side work. Every change is benchmarked against the same conditions before and after, using your own analytics wherever possible.',
            ],
            bullets: [
              { title: 'Measure:', text: 'Establish the current field and lab baseline on the journeys that matter.' },
              { title: 'Prioritise:', text: 'Fix the few issues that carry the largest user impact.' },
              { title: 'Verify:', text: 'Re-measure after each change rather than relying on assumptions.' },
            ],
            callout: 'The metrics below are completed only with values verified by your team or a report you provide. We do not estimate results in advance.',
          },
          {
            type: 'insight',
            title: 'A note on benchmarks',
            body: 'Published benchmarks are useful as orientation, not as a promise. We prefer to show your own before-and-after measurements, captured under the same device and network conditions, so the comparison is defensible.',
          },
          {
            type: 'cta',
            eyebrow: 'REVIEW',
            headline: 'Would you like the full technical walkthrough?',
            body: 'We can review the evidence page by page and agree which items are worth acting on first.',
            buttonLabel: 'Review the findings',
            buttonUrl: ctaUrl,
          },
        ],
        signature: signatureFor(brand),
        footer: footerFor(brand),
      },
    },
    {
      id: 'conversation-follow-up',
      name: 'Conversation follow-up',
      description: 'A context-aware follow-up that answers the actual question raised in the thread.',
      tone: 'consultative',
      defaultSubject: 'Following up on our conversation',
      design: {
        version: 1,
        header: {
          label: 'FOLLOW-UP',
          title: 'Following up on our conversation',
          subtitle: 'For {{recipient_name}} at {{company_name}}',
          reference: 'THREAD REPLY',
        },
        preheader: 'A direct follow-up to your question about {{service}}.',
        cards: [
          {
            type: 'content',
            greeting: 'Hi {{recipient_name}},',
            paragraphs: [
              'Thank you for the conversation about {{service}}. I wanted to follow up with a direct answer to the point you raised, rather than sending a general overview.',
              'I have kept this note focused on your question. Where a number or result is relevant, I will only include figures your team has verified or that come from a report we can share in full.',
            ],
            bullets: [
              { title: 'Your question:', text: 'Address the specific point raised in the thread.' },
              { title: 'Our approach:', text: 'Explain the method and the trade-offs in plain language.' },
              { title: 'Evidence:', text: 'Share only measurements we can substantiate.' },
            ],
          },
          {
            type: 'cta',
            eyebrow: 'CONTINUE',
            headline: 'Shall I send the short summary?',
            body: 'I can put the answer and the supporting evidence into a one-page note for your team.',
            buttonLabel: 'Send the summary',
            buttonUrl: ctaUrl,
          },
        ],
        signature: signatureFor(brand),
        footer: footerFor(brand),
      },
    },
  ];
}

export function getEmailDesignPresets(): EmailDesignPreset[] {
  return buildPresets(getEmailBrand());
}

export function getEmailDesignPreset(id: string): EmailDesignPreset | undefined {
  return getEmailDesignPresets().find((preset) => preset.id === id);
}

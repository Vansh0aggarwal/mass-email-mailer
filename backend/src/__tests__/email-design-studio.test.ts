import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailThread } from '../models/EmailThread.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { EmailStudioTemplate } from '../models/EmailStudioTemplate.js';
import { mockEmailProvider } from '../providers/email/mock-email.provider.js';
import { gmailProvider } from '../providers/email/gmail.provider.js';
import { renderEmailDesign, renderEmailText, escapeHtml } from '../email-design/render.js';
import { getEmailBrand } from '../email-design/brand.js';
import { emailDesignDocumentSchema, collectSendBlockingIssues } from '../email-design/types.js';

const brand = getEmailBrand();

function baseDesign(overrides: Record<string, any> = {}) {
  return {
    version: 1,
    header: {
      label: 'TECHNICAL REVIEW',
      title: 'A measured note for {{company_name}}',
      subtitle: 'Prepared for {{recipient_name}}',
    },
    preheader: 'A short technical note.',
    cards: [
      {
        type: 'content',
        greeting: 'Hi {{recipient_name}},',
        paragraphs: ['I wanted to share a perspective on {{service}} without making assumptions.'],
        bullets: [{ title: 'Measure:', text: 'Start from your own analytics.' }],
      },
      {
        type: 'cta',
        eyebrow: 'NEXT STEP',
        headline: 'Would a short review be useful?',
        buttonLabel: 'Arrange a call',
        buttonUrl: 'https://swaniki.dev/contact',
      },
    ],
    signature: {
      name: '{{sender_name}}',
      title: '{{sender_title}}',
      company: brand.name,
      website: brand.website,
      email: brand.contactEmail,
    },
    footer: { reason: 'One-to-one business correspondence.' },
    ...overrides,
  };
}

const renderOptions = {
  brand,
  variables: { companyName: 'Acme Logistics', recipientName: 'Elena', service: 'Speed Optimization', senderName: 'Vansh Aggarwal', senderTitle: 'Strategic Solutions' },
};

describe('Email design renderer', () => {
  it('escapes every operator-supplied string in the HTML body', () => {
    const parsed = emailDesignDocumentSchema.parse(
      baseDesign({
        header: {
          label: 'NOTE',
          title: '<script>alert("x")</script> & "quotes"',
        },
        cards: [
          {
            type: 'content',
            paragraphs: ['<img src=x onerror="alert(1)"> and <b>markup</b>'],
          },
          { type: 'cta', headline: 'Reply <now>', buttonLabel: 'Open', buttonUrl: 'https://example.com/path?a=1&b=2' },
        ],
      })
    );

    const { html, text } = renderEmailDesign(parsed, renderOptions);

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<now>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quotes&quot;');
    expect(html).toContain('https://example.com/path?a=1&amp;b=2');
    expect(html).toContain('<table role="presentation"');
    expect(html).not.toContain('multipart/alternative'); // HTML document, not a MIME wrapper
    expect(text).toContain('Vansh Aggarwal');
    expect(text).toContain('https://example.com/path?a=1&b=2');
  });

  it('resolves placeholders and renders a dark-mode/outlook safe table layout', () => {
    const parsed = emailDesignDocumentSchema.parse(baseDesign());
    const { html, text, warnings } = renderEmailDesign(parsed, renderOptions);

    expect(html).toContain('A measured note for Acme Logistics');
    expect(html).toContain('Hi Elena,');
    expect(html).not.toContain('{{company_name}}');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).not.toContain('multipart');
    expect(html).toContain('role="presentation"');
    expect(html).toContain('@media only screen and (max-width:600px)');
    expect(text).toContain('Hi Elena,');
    expect(text).toContain('Arrange a call: https://swaniki.dev/contact');
    // No unsubscribe URL configured in this fixture.
    expect(warnings.some((warning) => warning.message.includes('unsubscribe'))).toBe(true);
  });

  it('rejects unsafe URLs and unsourced metrics at the schema boundary', () => {
    const unsafeCta = baseDesign({
      cards: [{ type: 'cta', headline: 'Open', buttonLabel: 'Open', buttonUrl: 'javascript:alert(1)' }],
    });
    expect(emailDesignDocumentSchema.safeParse(unsafeCta).success).toBe(false);

    const unsourcedMetrics = baseDesign({
      cards: [
        {
          type: 'metrics',
          title: 'Measured',
          source: '',
          metrics: [{ label: 'LCP', before: '4.2s', after: '1.8s' }],
        },
      ],
    });
    expect(emailDesignDocumentSchema.safeParse(unsourcedMetrics).success).toBe(false);
  });

  it('blocks a send when a metric has no operator-supplied value', () => {
    const parsed = emailDesignDocumentSchema.parse(
      baseDesign({
        cards: [
          {
            type: 'metrics',
            title: 'Measured',
            source: 'Site audit, Oct 2026',
            metrics: [
              { label: 'LCP', note: 'Mobile p75' },
              { label: 'CLS', after: '0.04' },
            ],
          },
          { type: 'cta', headline: 'Open', buttonLabel: 'Open', buttonUrl: 'https://example.com' },
        ],
      })
    );
    const issues = collectSendBlockingIssues(parsed);
    expect(issues.some((issue) => issue.message.includes('LCP'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('CLS'))).toBe(false);
  });

  it('escapes HTML helper output correctly', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('emits a multipart/alternative MIME message when HTML is supplied', () => {
    const raw = (gmailProvider as any).buildRfc2822Message('outreach@swaniki.dev', {
      to: 'elena@acme.example',
      subject: 'Designed email',
      body: 'Plain text body',
      html: '<html><body><p>Designed body</p></body></html>',
    });

    expect(raw).toContain('Content-Type: multipart/alternative; boundary="swaniki_alt_');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
    expect(raw).not.toContain('<html><body><p>Designed body</p></body></html>');

    const boundary = raw.match(/boundary="([^"]+)"/)![1];
    const textPart = raw.split('Content-Type: text/plain; charset=UTF-8')[1].split(`--${boundary}`)[0];
    const encoded = textPart.split('\r\n\r\n')[1].replace(/\s+/g, '');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toContain('Plain text body');
  });
});

describe('Email Design Studio API', () => {
  let app: any;
  const org = `org_studio_${Date.now().toString(36)}`;
  const otherOrg = `${org}_other`;
  const mailbox = 'studio@swaniki.dev';
  let presetDesign: any;

  async function seed() {
    await EmailAccount.deleteMany({ organizationId: { $in: [org, otherOrg] } });
    await EmailDraft.deleteMany({ organizationId: { $in: [org, otherOrg] } });
    await EmailThread.deleteMany({ organizationId: { $in: [org, otherOrg] } });
    await EmailSendAttempt.deleteMany({ organizationId: { $in: [org, otherOrg] } });
    await EmailStudioTemplate.deleteMany({ organizationId: { $in: [org, otherOrg] } });

    await EmailAccount.create({
      organizationId: org,
      emailAddress: mailbox,
      displayName: 'Studio Sandbox',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 50,
    });
  }

  function draftPayload(overrides: Record<string, any> = {}) {
    return {
      recipientEmail: 'elena@acme.example',
      recipientName: 'Elena Rostova',
      companyName: 'Acme Logistics',
      recipientRole: 'VP of Digital Operations',
      targetService: 'Speed Optimization',
      tone: 'consultative',
      senderName: 'Vansh Aggarwal',
      senderTitle: 'Strategic Solutions',
      subject: 'A short note for Acme Logistics',
      design: presetDesign,
      ...overrides,
    };
  }

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();
    await seed();
    const config = await request(app)
      .get('/api/v1/email-studio/config')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test');
    expect(config.status).toBe(200);
    presetDesign = config.body.data.presets[0].design;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await seed();
    await disconnectDatabase();
  });

  it('serves config, presets and a rendering preview', async () => {
    const preview = await request(app)
      .post('/api/v1/email-studio/preview')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test')
      .send({
        design: presetDesign,
        variables: {
          companyName: 'Acme Logistics',
          recipientName: 'Elena',
          senderName: 'Vansh Aggarwal',
          senderTitle: 'Strategic Solutions',
          service: 'Speed Optimization',
        },
      });

    expect(preview.status).toBe(200);
    expect(preview.body.data.html).toContain('<table role="presentation"');
    expect(preview.body.data.html).toContain('A short note for Acme Logistics');
    expect(preview.body.data.text).toContain('Hi Elena,');
    expect(Array.isArray(preview.body.data.warnings)).toBe(true);
  });

  it('generates deterministic copy that contains no invented statistics', async () => {
    const res = await request(app)
      .post('/api/v1/email-studio/personalize')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test')
      .send({
        recipientEmail: 'elena@acme.example',
        recipientName: 'Elena',
        companyName: 'Acme Logistics',
        targetService: 'Speed Optimization',
        tone: 'consultative',
        senderName: 'Vansh Aggarwal',
        conversation:
          'Hi Vansh, thanks for the note. What benchmarks do you typically see in freight portals? We care about mobile checkout and our current LCP is 4.2s.',
        design: presetDesign,
      });

    expect(res.status).toBe(201);
    const body = res.body.data;
    expect(body.isFallback).toBe(true);
    expect(body.subject).toContain('Speed Optimization');
    expect(Array.isArray(body.factsUsed)).toBe(true);
    expect(body.factsUsed.join(' ')).toContain('Acme Logistics');
    // The fallback must not introduce a performance claim.
    const copy = [body.subject, ...body.design.cards.flatMap((card: any) => card.paragraphs || [])].join(' ');
    expect(copy).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(copy).not.toContain('15%');
    expect(body.warnings.join(' ')).toMatch(/Deterministic copy/i);
    expect(body.html).toContain('<table role="presentation"');
  });

  it('persists a draft, blocks unapproved sending, then accepts an approved send', async () => {
    const spy = vi.spyOn(mockEmailProvider, 'sendMessage');

    const created = await request(app)
      .post('/api/v1/email-studio/drafts')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test')
      .send(draftPayload());
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('draft');
    expect(created.body.data.bodyHtml).toContain('<table role="presentation"');
    const draftId = created.body.data.id;

    const blocked = await request(app)
      .post('/api/v1/email-studio/send')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test')
      .send({ draftId, mailboxEmail: mailbox });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('UNAPPROVED_DRAFT');
    expect(spy).not.toHaveBeenCalled();

    const approved = await request(app)
      .post(`/api/v1/email-studio/drafts/${draftId}/approve`)
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test');
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');

    const sent = await request(app)
      .post('/api/v1/email-studio/send')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test')
      .send({ draftId, mailboxEmail: mailbox, idempotencyKey: `studio_test_${Date.now()}` });

    expect(sent.status).toBe(200);
    expect(sent.body.data.result.status).toBe('accepted');
    expect(sent.body.data.result.providerMessageId).toMatch(/^sim_msg_/);
    expect(sent.body.data.draft.status).toBe('accepted');

    expect(spy).toHaveBeenCalledTimes(1);
    const [, options] = spy.mock.calls[0];
    expect(options.text || options.body).toContain('A short note for Acme Logistics');
    expect(options.html).toContain('<table role="presentation"');

    const attempt = await EmailSendAttempt.findOne({ organizationId: org, draftId });
    expect(attempt?.status).toBe('accepted');

    const thread = await EmailThread.findOne({
      organizationId: org,
      mailboxEmail: mailbox,
      threadId: sent.body.data.result.providerThreadId,
    });
    expect(thread).toBeTruthy();
    const outbound = thread!.messages.find((message) => message.id === sent.body.data.result.providerMessageId);
    expect(outbound?.bodyHtml).toContain('<table role="presentation"');
  });

  it('blocks approval when a metrics card has no verified values', async () => {
    const designWithMetrics = {
      ...JSON.parse(JSON.stringify(presetDesign)),
      cards: [
        {
          type: 'metrics',
          title: 'Measured performance',
          source: 'Site audit, October 2026',
          metrics: [{ label: 'Largest Contentful Paint', note: 'Mobile p75' }],
        },
        {
          type: 'cta',
          headline: 'Review the findings',
          buttonLabel: 'Open the review',
          buttonUrl: 'https://swaniki.dev/contact',
        },
      ],
    };

    const created = await request(app)
      .post('/api/v1/email-studio/drafts')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test')
      .send(draftPayload({ subject: 'Metrics draft', design: designWithMetrics }));
    expect(created.status).toBe(201);
    expect(created.body.data.blockingIssues.length).toBeGreaterThan(0);

    const approved = await request(app)
      .post(`/api/v1/email-studio/drafts/${created.body.data.id}/approve`)
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test');

    expect(approved.status).toBe(400);
    expect(approved.body.error.code).toBe('DESIGN_NOT_SENDABLE');
    expect(approved.body.error.details.issues.length).toBeGreaterThan(0);
  });

  it('keeps drafts and templates isolated per organization', async () => {
    const created = await request(app)
      .post('/api/v1/email-studio/drafts')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test')
      .send(draftPayload({ subject: 'Isolated draft' }));
    expect(created.status).toBe(201);

    const crossTenant = await request(app)
      .post(`/api/v1/email-studio/drafts/${created.body.data.id}/approve`)
      .set('x-organization-id', otherOrg)
      .set('x-user-id', 'user_other');
    expect(crossTenant.status).toBe(404);

    const template = await request(app)
      .post('/api/v1/email-studio/templates')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test')
      .send({
        name: `Reusable ${Date.now()}`,
        description: 'Saved design',
        tone: 'consultative',
        subject: 'Reusable subject',
        design: presetDesign,
      });
    expect(template.status).toBe(201);

    const crossTenantTemplates = await request(app)
      .get('/api/v1/email-studio/templates')
      .set('x-organization-id', otherOrg)
      .set('x-user-id', 'user_other');
    expect(crossTenantTemplates.status).toBe(200);
    expect(crossTenantTemplates.body.data.saved).toHaveLength(0);
  });

  it('lists studio drafts with the latest send attempt', async () => {
    const res = await request(app)
      .get('/api/v1/email-studio/drafts')
      .set('x-organization-id', org)
      .set('x-user-id', 'user_studio_test');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const sent = res.body.data.find((draft: any) => draft.status === 'accepted');
    expect(sent).toBeTruthy();
    expect(sent.lastAttempt.status).toBe('accepted');
    expect(sent.subject).toBe('A short note for Acme Logistics');
  });
});

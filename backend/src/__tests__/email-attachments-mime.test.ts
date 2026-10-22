import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailThread } from '../models/EmailThread.js';
import {
  decodeBase64Url,
  stripHtmlToText,
  extractBodiesFromPayload,
  extractAttachmentsFromPayload,
  filenameFromDisposition,
  gmailProvider,
} from '../providers/email/gmail.provider.js';

const b64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

/** A realistic Gmail payload: multipart/alternative body + inline logo + PDF. */
function buildPayload() {
  return {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'Subject', value: 'Hello' }],
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0.0', mimeType: 'text/plain', body: { data: b64url('Plain body text') } },
          { partId: '0.1', mimeType: 'text/html', body: { data: b64url('<p>Hello <b>world</b></p>') } },
        ],
      },
      {
        partId: '1',
        mimeType: 'image/png',
        filename: 'logo.png',
        headers: [
          { name: 'Content-ID', value: '<logo@swaniki>' },
          { name: 'Content-Disposition', value: 'inline; filename="logo.png"' },
        ],
        body: { size: 1234, attachmentId: 'IMG_ATTACH_ID' },
      },
      {
        partId: '2',
        mimeType: 'application/pdf',
        filename: 'report.pdf',
        headers: [{ name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }],
        body: { size: 56789, attachmentId: 'PDF_ATTACH_ID' },
      },
    ],
  };
}

describe('Gmail MIME body & attachment extraction', () => {
  it('decodes base64url chunks', () => {
    expect(decodeBase64Url(b64url('hello world'))).toBe('hello world');
    expect(decodeBase64Url('')).toBe('');
    expect(decodeBase64Url(undefined)).toBe('');
  });

  it('converts HTML to a readable plain-text fallback', () => {
    const text = stripHtmlToText('<style>.a{}</style><p>Hello <b>world</b></p><script>evil()</script>');
    expect(text).toContain('Hello');
    expect(text).toContain('world');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('<');
  });

  it('extracts both text and HTML bodies while ignoring inline/attached parts', () => {
    const { text, html } = extractBodiesFromPayload(buildPayload());
    expect(text).toBe('Plain body text');
    expect(html).toBe('<p>Hello <b>world</b></p>');
  });

  it('captures attachmentId, contentId and inline flags', () => {
    const attachments = extractAttachmentsFromPayload(buildPayload());
    expect(attachments).toHaveLength(2);

    const [image, pdf] = attachments;
    expect(image.filename).toBe('logo.png');
    expect(image.contentId).toBe('logo@swaniki');
    expect(image.attachmentId).toBe('IMG_ATTACH_ID');
    expect(image.isInline).toBe(true);

    expect(pdf.filename).toBe('report.pdf');
    expect(pdf.attachmentId).toBe('PDF_ATTACH_ID');
    expect(pdf.isInline).toBe(false);
  });

  it('persists embedded inline bytes when no attachmentId is present', () => {
    const payload = {
      mimeType: 'multipart/related',
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<p>x</p>') } },
        {
          partId: '1',
          mimeType: 'image/gif',
          headers: [{ name: 'Content-ID', value: '<tiny@x>' }],
          body: { data: b64url('GIF89a') },
        },
      ],
    };
    const [inline] = extractAttachmentsFromPayload(payload);
    expect(inline.isInline).toBe(true);
    expect(inline.contentId).toBe('tiny@x');
    expect(decodeBase64Url(inline.inlineData)).toBe('GIF89a');
  });

  it('parses filenames from content-disposition including RFC 2231', () => {
    expect(filenameFromDisposition('attachment; filename="report.pdf"')).toBe('report.pdf');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''caf%C3%A9.pdf")).toBe('café.pdf');
    expect(filenameFromDisposition('inline')).toBe('');
  });
});

describe('Attachment download endpoint: authorization & isolation', () => {
  let app: any;
  const orgA = 'org_attach_owner';
  const orgB = 'org_attach_other';
  const mailbox = 'attach@swaniki.dev';
  const threadId = 'thread_attach_1';
  const messageId = 'msg_attach_1';
  const attachmentId = 'ATTACH_PDF_1';

  beforeAll(async () => {
    await connectDatabase();
    app = createApp();

    await EmailThread.deleteMany({ organizationId: { $in: [orgA, orgB] } });
    await EmailAccount.deleteMany({ organizationId: { $in: [orgA, orgB] } });

    await EmailAccount.create({
      organizationId: orgA,
      emailAddress: mailbox,
      displayName: 'Attachment Owner',
      provider: 'gmail',
      status: 'connected',
    });

    await EmailThread.create({
      organizationId: orgA,
      mailboxEmail: mailbox,
      threadId,
      subject: 'Attachment Thread',
      messages: [
        {
          id: messageId,
          from: { name: 'Sender', email: 'sender@prospect.example.com' },
          to: [{ email: mailbox }],
          subject: 'With attachment',
          bodyText: 'See attached.',
          attachments: [
            { filename: 'report.pdf', mimeType: 'application/pdf', size: 7, attachmentId, isInline: false },
          ],
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await EmailThread.deleteMany({ organizationId: { $in: [orgA, orgB] } });
    await EmailAccount.deleteMany({ organizationId: { $in: [orgA, orgB] } });
    await disconnectDatabase();
  });

  const url = (mb: string, th: string, msg: string, att: string, inline = false) =>
    `/api/v1/mailboxes/${mb}/threads/${th}/messages/${msg}/attachments/${att}${inline ? '?inline=1' : ''}`;

  it('returns 404 when the thread does not exist for the organization', async () => {
    const res = await request(app)
      .get(url(mailbox, 'missing_thread', messageId, attachmentId))
      .set('x-organization-id', orgA);
    expect(res.status).toBe(404);
  });

  it('enforces mailbox isolation across organizations', async () => {
    const res = await request(app)
      .get(url(mailbox, threadId, messageId, attachmentId))
      .set('x-organization-id', orgB);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown attachment id', async () => {
    const spy = vi.spyOn(gmailProvider, 'getAttachmentBytes');
    const res = await request(app)
      .get(url(mailbox, threadId, messageId, 'does-not-exist'))
      .set('x-organization-id', orgA);
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects mailboxes that are not connected Gmail accounts', async () => {
    await EmailAccount.updateOne(
      { organizationId: orgA, emailAddress: mailbox },
      { $set: { status: 'disconnected' } }
    );
    try {
      const spy = vi.spyOn(gmailProvider, 'getAttachmentBytes');
      const res = await request(app)
        .get(url(mailbox, threadId, messageId, attachmentId))
        .set('x-organization-id', orgA);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MAILBOX_NOT_GMAIL');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await EmailAccount.updateOne(
        { organizationId: orgA, emailAddress: mailbox },
        { $set: { status: 'connected' } }
      );
    }
  });

  it('streams attachment bytes with safe download headers', async () => {
    const bytes = Buffer.from('PDFDATA');
    const spy = vi.spyOn(gmailProvider, 'getAttachmentBytes').mockResolvedValue({ data: bytes, size: bytes.length });

    const res = await request(app)
      .get(url(mailbox, threadId, messageId, attachmentId))
      .set('x-organization-id', orgA);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('report.pdf');
    expect(spy).toHaveBeenCalledWith(mailbox, messageId, attachmentId, orgA);
  });

  it('uses inline disposition when inline=1 is requested', async () => {
    vi.spyOn(gmailProvider, 'getAttachmentBytes').mockResolvedValue({ data: Buffer.from('x'), size: 1 });
    const res = await request(app)
      .get(url(mailbox, threadId, messageId, attachmentId, true))
      .set('x-organization-id', orgA);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('inline');
  });
});

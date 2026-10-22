import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailThread } from '../models/EmailThread.js';
import { Suppression } from '../models/Suppression.js';
import { emailSendPipelineService } from '../services/email-send-pipeline.service.js';
import { gmailProvider, isInvalidGrantError } from '../providers/email/gmail.provider.js';
import { gmailQuotaService, GMAIL_METHOD_QUOTA_COST } from '../services/gmail-quota.service.js';
import { mockEmailProvider } from '../providers/email/mock-email.provider.js';
import { requireAuth } from '../middleware/session.js';
import { AppError } from '../middleware/errorHandler.js';
import { inboxCopilotService, CopilotTone } from '../services/inbox-copilot.service.js';

const router = Router();

const defaultMailboxEmail = 'outreach@swaniki.dev';
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

type MailFolder = 'inbox' | 'starred' | 'snoozed' | 'sent' | 'drafts' | 'spam' | 'trash' | 'all';

function folderQuery(folder: string): Record<string, any> {
  switch (folder) {
    case 'starred':
      return { isStarred: true, isTrash: { $ne: true } };
    case 'snoozed':
      return { isSnoozed: true, isTrash: { $ne: true } };
    case 'sent':
      return { labels: 'SENT', isTrash: { $ne: true } };
    case 'drafts':
      return { labels: 'DRAFT', isTrash: { $ne: true } };
    case 'spam':
      return { isSpam: true };
    case 'trash':
      return { isTrash: true };
    case 'all':
      return {};
    case 'inbox':
    default:
      return {
        inInbox: { $ne: false },
        isTrash: { $ne: true },
        isSpam: { $ne: true },
        isArchived: { $ne: true },
      };
  }
}

// GET /api/v1/mailboxes
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    let mailboxes = await EmailAccount.find({ organizationId: orgId })
      .select('-encryptedAccessToken -encryptedRefreshToken')
      .lean();

    if (mailboxes.length === 0) {
      // Seed default sandbox mailbox
      await EmailAccount.create({
        organizationId: orgId,
        emailAddress: defaultMailboxEmail,
        displayName: 'Swaniki Outreach (Mock Dev)',
        provider: 'mock',
        status: 'connected',
        dailySendLimit: 100,
        sendsToday: 0,
        isPaused: false,
      });

      // Seed initial sample threads so the workspace renders real records
      await EmailThread.create([
        {
          organizationId: orgId,
          mailboxEmail: defaultMailboxEmail,
          threadId: 'th_sample_001',
          subject: 'Inquiry regarding web performance & digital conversions',
          snippet: 'Thanks for reaching out! We are interested in hearing your benchmarks...',
          lastMessageDate: new Date(),
          messageCount: 2,
          isRead: false,
          isStarred: true,
          inInbox: true,
          unreadCount: 1,
          labels: ['INBOX', 'STARRED', 'CATEGORY_PERSONAL'],
          category: 'primary',
          lastFromName: 'Elena Rostova',
          lastFromEmail: 'elena@apexlogistics.example.com',
          participants: [defaultMailboxEmail, 'elena@apexlogistics.example.com'],
          companyName: 'Apex Logistics Corp',
          messages: [
            {
              id: 'msg_001',
              from: { name: 'Vansh Aggarwal', email: defaultMailboxEmail },
              to: [{ name: 'Elena Rostova', email: 'elena@apexlogistics.example.com' }],
              subject: 'Inquiry regarding web performance & digital conversions',
              bodyText:
                'Hi Elena,\n\nI noticed your recent expansion into cold-chain logistics. Our team specializes in sub-second mobile performance.\n\nBest,\nVansh',
              snippet: 'Hi Elena, I noticed your recent expansion...',
              date: new Date(Date.now() - 3600000 * 24),
              isRead: true,
              isStarred: false,
              hasAttachments: false,
            },
            {
              id: 'msg_002',
              from: { name: 'Elena Rostova', email: 'elena@apexlogistics.example.com' },
              to: [{ name: 'Vansh Aggarwal', email: defaultMailboxEmail }],
              subject: 'Re: Inquiry regarding web performance & digital conversions',
              bodyText:
                'Hi Vansh,\n\nThanks for reaching out! We have indeed experienced mobile drop-off. What benchmarks do you typically see in freight portals?\n\nElena',
              snippet: 'Thanks for reaching out! We have indeed experienced...',
              date: new Date(),
              isRead: false,
              isStarred: true,
              hasAttachments: false,
            },
          ],
        },
        {
          organizationId: orgId,
          mailboxEmail: defaultMailboxEmail,
          threadId: 'th_sample_002',
          subject: 'Q3 retainer scope & onboarding timeline',
          snippet: 'Following up on the proposal — happy to align on next steps this week.',
          lastMessageDate: new Date(Date.now() - 3600000 * 6),
          messageCount: 1,
          isRead: false,
          isStarred: false,
          inInbox: true,
          unreadCount: 1,
          labels: ['INBOX', 'CATEGORY_UPDATES'],
          category: 'updates',
          lastFromName: 'Marcus Devlin',
          lastFromEmail: 'marcus@northwind.io',
          participants: [defaultMailboxEmail, 'marcus@northwind.io'],
          companyName: 'Northwind Digital',
          messages: [
            {
              id: 'msg_010',
              from: { name: 'Marcus Devlin', email: 'marcus@northwind.io' },
              to: [{ name: 'Swaniki Outreach', email: defaultMailboxEmail }],
              subject: 'Q3 retainer scope & onboarding timeline',
              bodyText:
                'Hi team,\n\nFollowing up on the proposal — we are keen to align on scope and an onboarding timeline this week.\n\nMarcus',
              snippet: 'Following up on the proposal — happy to align...',
              date: new Date(Date.now() - 3600000 * 6),
              isRead: false,
              isStarred: false,
              hasAttachments: false,
            },
          ],
        },
        {
          organizationId: orgId,
          mailboxEmail: defaultMailboxEmail,
          threadId: 'th_sample_003',
          subject: 'Case study: freight portal performance benchmarks',
          snippet: 'Attached the benchmark study we discussed. Let me know your thoughts.',
          lastMessageDate: new Date(Date.now() - 3600000 * 48),
          messageCount: 1,
          isRead: true,
          isStarred: false,
          inInbox: false,
          unreadCount: 0,
          labels: ['SENT', 'CATEGORY_PERSONAL'],
          category: 'primary',
          lastFromName: 'Vansh Aggarwal',
          lastFromEmail: defaultMailboxEmail,
          participants: [defaultMailboxEmail, 'elena@apexlogistics.example.com'],
          companyName: 'Apex Logistics Corp',
          messages: [
            {
              id: 'msg_020',
              from: { name: 'Vansh Aggarwal', email: defaultMailboxEmail },
              to: [{ name: 'Elena Rostova', email: 'elena@apexlogistics.example.com' }],
              subject: 'Case study: freight portal performance benchmarks',
              bodyText:
                'Hi Elena,\n\nAttached the benchmark study we discussed. Sub-second LCP is the 95th percentile target for freight portals.\n\nBest,\nVansh',
              snippet: 'Attached the benchmark study we discussed...',
              date: new Date(Date.now() - 3600000 * 48),
              isRead: true,
              isStarred: false,
              hasAttachments: false,
            },
          ],
        },
      ]);

      mailboxes = await EmailAccount.find({ organizationId: orgId })
        .select('-encryptedAccessToken -encryptedRefreshToken')
        .lean();
    }

    res.status(200).json({
      success: true,
      data: mailboxes,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/mailboxes/:id/threads
router.get('/:id/threads', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const mailboxEmail = req.params.id.toLowerCase();
    const { q, starred, folder = 'inbox', page = '1', limit = '25', companyId } = req.query;

    const query: any = { organizationId: orgId, mailboxEmail, ...folderQuery(String(folder)) };

    // Backwards compatible explicit star filter
    if (starred === 'true') {
      query.isStarred = true;
    }
    if (companyId) {
      query.companyId = String(companyId);
    }
    if (q && String(q).trim()) {
      const searchRegex = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { subject: searchRegex },
        { snippet: searchRegex },
        { companyName: searchRegex },
        { lastFromName: searchRegex },
        { lastFromEmail: searchRegex },
        { participants: searchRegex },
        { 'messages.from.email': searchRegex },
        { 'messages.to.email': searchRegex },
        { 'messages.bodyText': searchRegex },
      ];
    }

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const [threads, total] = await Promise.all([
      EmailThread.find(query).sort({ lastMessageDate: -1 }).skip(skip).limit(limitNum).lean(),
      EmailThread.countDocuments(query),
    ]);

    // Lightweight list projection: omit full message bodies (and inline image
    // bytes) from the list payload — those load when a message is opened.
    const list = threads.map((t: any) => ({
      ...t,
      messages: t.messages.map((m: any) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        date: m.date,
        isRead: m.isRead,
        isStarred: m.isStarred,
        hasAttachments: m.hasAttachments,
        attachments: (m.attachments || []).map((a: any) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          attachmentId: a.attachmentId,
          contentId: a.contentId,
          partId: a.partId,
          isInline: a.isInline,
        })),
      })),
    }));

    res.status(200).json({
      success: true,
      data: list,
      meta: {
        page: pageNum,
        limit: limitNum,
        total,
        hasMore: skip + list.length < total,
        folder: String(folder),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/mailboxes/:id/counts
router.get('/:id/counts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const mailboxEmail = req.params.id.toLowerCase();

    const base = { organizationId: orgId, mailboxEmail };
    const [inbox, unreadInbox, starred, snoozed, sent, drafts, spam, trash] = await Promise.all([
      EmailThread.countDocuments({ ...base, ...folderQuery('inbox') }),
      EmailThread.countDocuments({ ...base, ...folderQuery('inbox'), isRead: false }),
      EmailThread.countDocuments({ ...base, ...folderQuery('starred') }),
      EmailThread.countDocuments({ ...base, ...folderQuery('snoozed') }),
      EmailThread.countDocuments({ ...base, ...folderQuery('sent') }),
      EmailThread.countDocuments({ ...base, ...folderQuery('drafts') }),
      EmailThread.countDocuments({ ...base, ...folderQuery('spam') }),
      EmailThread.countDocuments({ ...base, ...folderQuery('trash') }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        inbox,
        inboxUnread: unreadInbox,
        starred,
        snoozed,
        sent,
        drafts,
        spam,
        trash,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/mailboxes/:id/threads/:threadId
router.get('/:id/threads/:threadId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const thread = await EmailThread.findOne({
      organizationId: req.organizationId,
      mailboxEmail: req.params.id.toLowerCase(),
      threadId: req.params.threadId,
    }).lean();

    if (!thread) {
      throw new AppError('Thread not found', 404, 'NOT_FOUND');
    }

    res.status(200).json({
      success: true,
      data: thread,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/mailboxes/:id/threads/:threadId/copilot
// AI Inbox Copilot for conversation summaries, contextual reply suggestions, tone changes, action items, next steps
router.post('/:id/threads/:threadId/copilot', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const toneSchema = z.enum(['consultative', 'direct', 'friendly', 'formal', 'urgent']).optional();
    const { tone, instruction, action } = z
      .object({
        tone: toneSchema,
        instruction: z.string().max(500).optional(),
        action: z.enum(['summary', 'reply', 'all']).optional(),
      })
      .parse(req.body);

    const result = await inboxCopilotService.analyzeAndAssist({
      organizationId: req.organizationId,
      mailboxEmail: req.params.id,
      threadId: req.params.threadId,
      tone: tone as CopilotTone | undefined,
      instruction,
      action,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/mailboxes/:id/threads/:threadId/messages/:messageId/attachments/:attachmentId
// Streams attachment / inline-image bytes from Gmail. Org- and mailbox-scoped:
// the stored thread must belong to the caller's organization + mailbox, and the
// attachment id must exist on that message. Tokens never leave the server.
router.get(
  '/:id/threads/:threadId/messages/:messageId/attachments/:attachmentId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mailboxEmail = req.params.id.toLowerCase();
      const { threadId, messageId, attachmentId } = req.params;
      const wantsInline = req.query.inline === '1' || req.query.inline === 'true';

      const thread = await EmailThread.findOne({
        organizationId: req.organizationId,
        mailboxEmail,
        threadId,
      }).lean();

      if (!thread) {
        throw new AppError('Thread not found', 404, 'NOT_FOUND');
      }

      const message: any = (thread.messages || []).find((m: any) => m.id === messageId);
      if (!message) {
        throw new AppError('Message not found', 404, 'NOT_FOUND');
      }

      const attachment: any = (message.attachments || []).find(
        (a: any) => a.attachmentId === attachmentId || a.partId === attachmentId || a.contentId === attachmentId
      );
      if (!attachment || !attachment.attachmentId) {
        throw new AppError('Attachment not found', 404, 'NOT_FOUND');
      }

      const account = await EmailAccount.findOne({
        organizationId: req.organizationId,
        emailAddress: mailboxEmail,
        provider: 'gmail',
      });
      if (!account || account.status === 'disconnected') {
        throw new AppError('Mailbox is not a connected Gmail account', 400, 'MAILBOX_NOT_GMAIL');
      }

      const { data } = await gmailProvider.getAttachmentBytes(
        mailboxEmail,
        messageId,
        attachmentId,
        req.organizationId
      );

      const filename = sanitizeFilename(attachment.filename || 'attachment');
      const disposition = wantsInline || attachment.isInline ? 'inline' : 'attachment';

      res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', String(data.length));
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).end(data);
    } catch (err) {
      handleGmailReauth(err, req, res, next);
    }
  }
);

// PATCH /api/v1/mailboxes/:id/threads/:threadId
router.patch('/:id/threads/:threadId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxEmail = req.params.id.toLowerCase();
    const parsed = z
      .object({
        isRead: z.boolean().optional(),
        isStarred: z.boolean().optional(),
        isArchived: z.boolean().optional(),
        isSpam: z.boolean().optional(),
        isTrash: z.boolean().optional(),
        isSnoozed: z.boolean().optional(),
        snoozedUntil: z.string().or(z.date()).nullable().optional(),
        labels: z.array(z.string()).optional(),
        companyId: z.string().nullable().optional(),
        companyName: z.string().nullable().optional(),
      })
      .parse(req.body);

    const thread = await EmailThread.findOne({
      organizationId: req.organizationId,
      mailboxEmail,
      threadId: req.params.threadId,
    });

    if (!thread) {
      throw new AppError('Thread not found', 404, 'NOT_FOUND');
    }

    const update: Record<string, any> = {};
    if (parsed.isRead !== undefined) {
      update.isRead = parsed.isRead;
      thread.messages.forEach((m) => {
        m.isRead = parsed.isRead as boolean;
      });
      thread.unreadCount = parsed.isRead ? 0 : thread.messages.length;
      thread.markModified('messages');
    }
    if (parsed.isStarred !== undefined) update.isStarred = parsed.isStarred;
    if (parsed.isArchived !== undefined) {
      update.isArchived = parsed.isArchived;
      update.inInbox = !parsed.isArchived;
    }
    if (parsed.isSpam !== undefined) {
      update.isSpam = parsed.isSpam;
      if (parsed.isSpam) update.inInbox = false;
    }
    if (parsed.isTrash !== undefined) {
      update.isTrash = parsed.isTrash;
      if (parsed.isTrash) update.inInbox = false;
    }
    if (parsed.isSnoozed !== undefined) update.isSnoozed = parsed.isSnoozed;
    if (parsed.snoozedUntil !== undefined) update.snoozedUntil = parsed.snoozedUntil ? new Date(parsed.snoozedUntil) : undefined;
    if (parsed.labels !== undefined) update.labels = parsed.labels;
    if (parsed.companyId !== undefined) update.companyId = parsed.companyId || undefined;
    if (parsed.companyName !== undefined) update.companyName = parsed.companyName || undefined;

    Object.assign(thread, update);
    await thread.save();

    // Mirror Gmail label changes where supported (best-effort)
    await mirrorGmailState(mailboxEmail, thread.threadId, parsed, req.organizationId);

    res.status(200).json({ success: true, data: thread });
  } catch (err) {
    handleGmailReauth(err, req, res, next);
  }
});

// POST /api/v1/mailboxes/:id/threads/bulk
router.post('/:id/threads/bulk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxEmail = req.params.id.toLowerCase();
    const { threadIds, action } = z
      .object({
        threadIds: z.array(z.string()).min(1),
        action: z.enum([
          'markRead',
          'markUnread',
          'star',
          'unstar',
          'archive',
          'unarchive',
          'trash',
          'untrash',
          'spam',
          'notSpam',
        ]),
      })
      .parse(req.body);

    const orgId = req.organizationId;
    const filter = { organizationId: orgId, mailboxEmail, threadId: { $in: threadIds } };

    const flagByAction: Record<string, Record<string, any>> = {
      markRead: { isRead: true },
      markUnread: { isRead: false },
      star: { isStarred: true },
      unstar: { isStarred: false },
      archive: { isArchived: true, inInbox: false },
      unarchive: { isArchived: false, inInbox: true },
      trash: { isTrash: true, inInbox: false },
      untrash: { isTrash: false, inInbox: true },
      spam: { isSpam: true, inInbox: false },
      notSpam: { isSpam: false, inInbox: true },
    };
    const set = flagByAction[action];

    const threads = await EmailThread.find(filter);
    for (const thread of threads) {
      Object.assign(thread, set);
      if (action === 'markRead') {
        thread.messages.forEach((m) => (m.isRead = true));
        thread.unreadCount = 0;
        thread.markModified('messages');
      } else if (action === 'markUnread') {
        thread.unreadCount = thread.messages.length;
      }
      await thread.save();

      // Best-effort Gmail mirror
      if (action === 'trash') {
        await safeGmailCall(() => gmailProvider.trashThread(mailboxEmail, thread.threadId, orgId));
      } else {
        const { add, remove } = gmailLabelsForAction(action);
        if (add.length || remove.length) {
          await safeGmailCall(() => gmailProvider.modifyThread(mailboxEmail, thread.threadId, add, remove, orgId));
        }
      }
    }

    res.status(200).json({
      success: true,
      data: { updatedCount: threads.length, action },
    });
  } catch (err) {
    handleGmailReauth(err, req, res, next);
  }
});

// DELETE /api/v1/mailboxes/:id/threads/:threadId
router.delete('/:id/threads/:threadId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxEmail = req.params.id.toLowerCase();
    const thread = await EmailThread.findOneAndDelete({
      organizationId: req.organizationId,
      mailboxEmail,
      threadId: req.params.threadId,
    });

    if (!thread) {
      throw new AppError('Thread not found', 404, 'NOT_FOUND');
    }

    const mailbox = await EmailAccount.findOne({ organizationId: req.organizationId, emailAddress: mailboxEmail });
    if (mailbox?.provider === 'gmail' && mailbox.status === 'connected') {
      await safeGmailCall(() => gmailProvider.deleteThread(mailboxEmail, thread.threadId, req.organizationId));
    }

    res.status(200).json({ success: true, data: { threadId: thread.threadId, deleted: true } });
  } catch (err) {
    handleGmailReauth(err, req, res, next);
  }
});

// POST /api/v1/mailboxes/:id/threads/:threadId/reply
router.post('/:id/threads/:threadId/reply', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bodyText, to, cc, bcc, subject } = z
      .object({
        bodyText: z.string().min(1),
        to: z.string().optional(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string().optional(),
      })
      .parse(req.body);

    const mailboxEmail = req.params.id.toLowerCase();
    const thread = await EmailThread.findOne({
      organizationId: req.organizationId,
      mailboxEmail,
      threadId: req.params.threadId,
    });

    if (!thread) {
      throw new AppError('Thread not found', 404, 'NOT_FOUND');
    }

    const mailbox = await EmailAccount.findOne({ organizationId: req.organizationId, emailAddress: mailboxEmail });

    // Determine recipient(s)
    const lastOtherMessage = [...thread.messages].reverse().find(
      (m) => m.from.email.toLowerCase() !== mailboxEmail
    );
    const defaultRecipient = lastOtherMessage
      ? lastOtherMessage.from.email
      : thread.participants.find((p) => p.toLowerCase() !== mailboxEmail) || 'recipient@example.com';
    const recipientEmail = (to || defaultRecipient).trim().toLowerCase();
    const recipientName = lastOtherMessage?.from?.name || thread.companyName || 'Recipient';
    const replySubject = subject || `Re: ${thread.subject.replace(/^re:\s*/i, '')}`;

    if (!EMAIL_REGEX.test(recipientEmail)) {
      throw new AppError(`Recipient address '${recipientEmail}' is invalid`, 400, 'INVALID_RECIPIENT');
    }

    const lastMessage = thread.messages[thread.messages.length - 1];
    // Prefer the RFC 5322 Message-ID for standards-compliant threading, falling
    // back to the Gmail message id.
    const lastMsgId = (lastMessage as any)?.messageIdHeader || lastMessage?.id;
    let messageId = `msg_${crypto.randomBytes(4).toString('hex')}`;

    // If mailbox is connected to real Gmail, dispatch via Gmail API
    if (mailbox && mailbox.provider === 'gmail' && mailbox.status === 'connected' && !mailbox.isPaused) {
      const sendResult = await gmailProvider.sendMessage(
        mailboxEmail,
        {
          to: recipientEmail,
          cc: cc?.trim() || undefined,
          bcc: bcc?.trim() || undefined,
          subject: replySubject,
          body: bodyText,
          inReplyTo: lastMsgId,
          references: (lastMessage as any)?.references || lastMsgId,
          threadId: thread.threadId,
        },
        req.organizationId
      );
      messageId = sendResult.messageId;
    }

    const now = new Date();
    const newMessage = {
      id: messageId,
      from: { name: 'Swaniki Outreach', email: mailboxEmail },
      to: [{ name: recipientName, email: recipientEmail }],
      cc: parseEmails(cc),
      bcc: parseEmails(bcc),
      subject: replySubject,
      bodyText,
      snippet: bodyText.slice(0, 140),
      date: now,
      isRead: true,
      isStarred: false,
      hasAttachments: false,
      attachments: [],
    };

    thread.messages.push(newMessage as any);
    thread.lastMessageDate = now;
    thread.messageCount += 1;
    thread.snippet = newMessage.snippet;
    thread.lastFromName = 'Swaniki Outreach';
    thread.lastFromEmail = mailboxEmail;
    if (!thread.participants.includes(mailboxEmail)) thread.participants.push(mailboxEmail);
    await thread.save();

    res.status(201).json({
      success: true,
      data: thread,
    });
  } catch (err) {
    handleGmailReauth(err, req, res, next);
  }
});

// POST /api/v1/mailboxes/:id/messages  (compose & send a new message)
router.post('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxEmail = req.params.id.toLowerCase();
    const { to, cc, bcc, subject, body } = z
      .object({
        to: z.string().min(3),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string().min(1),
        body: z.string().min(1),
      })
      .parse(req.body);

    const primaryRecipient = to.split(',')[0].trim().toLowerCase();
    if (!EMAIL_REGEX.test(primaryRecipient)) {
      throw new AppError(`Recipient address '${primaryRecipient}' is invalid`, 400, 'INVALID_RECIPIENT');
    }

    const mailbox = await EmailAccount.findOne({ organizationId: req.organizationId, emailAddress: mailboxEmail });
    if (!mailbox) {
      throw new AppError('Mailbox not found', 404, 'NOT_FOUND');
    }
    if (mailbox.status === 'error' || mailbox.isPaused) {
      throw new AppError(
        'Mailbox is not available for sending. Reconnect or unpause the account.',
        401,
        'GMAIL_REAUTH_REQUIRED',
        { requiresReconnect: true, emailAddress: mailboxEmail }
      );
    }

    // Suppression safety check
    const suppressed = await Suppression.findOne({ organizationId: req.organizationId, email: primaryRecipient });
    if (suppressed) {
      throw new AppError(
        `Recipient '${primaryRecipient}' is on the suppression list (${suppressed.reason})`,
        400,
        'RECIPIENT_SUPPRESSED'
      );
    }

    let providerMessageId = `sim_msg_${crypto.randomBytes(6).toString('hex')}`;
    let providerThreadId = `sim_th_${crypto.randomBytes(6).toString('hex')}`;
    let isSimulated = true;

    if (mailbox.provider === 'gmail' && mailbox.status === 'connected') {
      const result = await gmailProvider.sendMessage(
        mailboxEmail,
        { to, cc: cc?.trim() || undefined, bcc: bcc?.trim() || undefined, subject, body },
        req.organizationId
      );
      providerMessageId = result.messageId;
      providerThreadId = result.threadId;
      isSimulated = result.isSimulated;
      mailbox.sendsToday += 1;
      await mailbox.save();
    } else {
      const result = await mockEmailProvider.sendMessage(mailboxEmail, { to, subject, body });
      providerMessageId = result.messageId;
      providerThreadId = result.threadId;
      isSimulated = true;
    }

    const now = new Date();
    const sentMessage = {
      id: providerMessageId,
      from: { name: 'Swaniki Outreach', email: mailboxEmail },
      to: parseEmails(to),
      cc: parseEmails(cc),
      bcc: parseEmails(bcc),
      subject,
      bodyText: body,
      snippet: body.slice(0, 140),
      date: now,
      isRead: true,
      isStarred: false,
      hasAttachments: false,
      attachments: [],
    };

    const thread = await EmailThread.findOneAndUpdate(
      { organizationId: req.organizationId, mailboxEmail, threadId: providerThreadId },
      {
        $set: {
          subject,
          snippet: sentMessage.snippet,
          lastMessageDate: now,
          isRead: true,
          inInbox: false,
          isArchived: true,
          lastFromName: 'Swaniki Outreach',
          lastFromEmail: mailboxEmail,
          labels: ['SENT'],
          category: 'primary',
        },
        $setOnInsert: { organizationId: req.organizationId, mailboxEmail, threadId: providerThreadId },
        $push: { messages: sentMessage },
        $addToSet: { participants: { $each: [mailboxEmail, ...sentMessage.to.map((a) => a.email)] } },
        $inc: { messageCount: 1 },
      },
      { upsert: true, new: true }
    );

    res.status(201).json({
      success: true,
      data: { threadId: thread.threadId, messageId: providerMessageId, isSimulated },
    });
  } catch (err) {
    handleGmailReauth(err, req, res, next);
  }
});

// POST /api/v1/mailboxes/:id/sync
router.post('/:id/sync', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxEmail = req.params.id.toLowerCase();
    const mailbox = await EmailAccount.findOne({
      organizationId: req.organizationId,
      emailAddress: mailboxEmail,
    });

    if (!mailbox) {
      throw new AppError('Mailbox not found', 404, 'NOT_FOUND');
    }

    if (mailbox.provider === 'gmail' && (mailbox.status === 'error' || mailbox.isPaused)) {
      throw new AppError(
        'Gmail authorization expired or revoked. Please reconnect the account in Integrations.',
        401,
        'GMAIL_REAUTH_REQUIRED',
        { emailAddress: mailboxEmail, requiresReconnect: true }
      );
    }

    let syncedCount = 0;
    if (mailbox.provider === 'gmail') {
      // A full thread costs 120 quota units, so 50 threads would need 6,010
      // units — more than a mailbox's entire per-minute budget. The thread
      // count is therefore derived from the remaining budget.
      const threadCost = GMAIL_METHOD_QUOTA_COST['threads.get.full'] ?? 120;
      const state = await gmailQuotaService.getState(mailboxEmail).catch(() => null);
      const affordable = state
        ? Math.max(1, Math.floor(Math.max(0, state.tokens - 200) / threadCost))
        : 25;
      const maxThreads = Math.min(50, Math.max(1, affordable));
      syncedCount = await gmailProvider.syncThreadsToDb(req.organizationId, mailboxEmail, { maxThreads });
    } else {
      mailbox.lastSyncedAt = new Date();
      await mailbox.save();
    }

    res.status(200).json({
      success: true,
      data: {
        syncedCount,
        lastSyncedAt: new Date(),
      },
    });
  } catch (err: any) {
    if (err.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
      await gmailProvider.markMailboxReauthRequired(req.organizationId, req.params.id);
      return res.status(401).json({
        success: false,
        error: {
          message: 'Gmail authorization expired or revoked. Please reconnect the account in Integrations.',
          code: 'GMAIL_REAUTH_REQUIRED',
          requiresReconnect: true,
          emailAddress: req.params.id.toLowerCase(),
        },
      });
    }
    next(err);
  }
});

// POST /api/v1/mailboxes/:id/send (Safe Pre-flight Send Pipeline)
router.post('/:id/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { draftId, idempotencyKey } = z
      .object({
        draftId: z.string().min(1),
        idempotencyKey: z.string().min(1),
      })
      .parse(req.body);

    const result = await emailSendPipelineService.executeSend({
      draftId,
      mailboxId: req.params.id.toLowerCase(),
      organizationId: req.organizationId,
      actorId: req.userId,
      idempotencyKey,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/mailboxes/suppressions
router.post('/suppressions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, reason } = z
      .object({
        email: z.string().email(),
        reason: z.enum(['unsubscribed', 'bounced', 'manual_block', 'competitor']).default('manual_block'),
      })
      .parse(req.body);

    const suppression = await Suppression.findOneAndUpdate(
      { organizationId: req.organizationId, email: email.toLowerCase() },
      { $set: { reason } },
      { upsert: true, new: true }
    );

    res.status(201).json({
      success: true,
      data: suppression,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/mailboxes/suppressions
router.get('/suppressions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const suppressions = await Suppression.find({ organizationId: req.organizationId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.status(200).json({
      success: true,
      data: suppressions,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strips characters that could break a Content-Disposition header. */
function sanitizeFilename(name: string): string {
  return String(name || 'attachment')
    .replace(/[\r\n"]/g, '')
    .replace(/[\\/]/g, '_')
    .slice(0, 200)
    .trim() || 'attachment';
}

function parseEmails(raw?: string): { name: string; email: string }[] {  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const match = chunk.match(/^(.*?)<([^>]+)>$/);
      if (match) {
        return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim().toLowerCase() };
      }
      return { name: '', email: chunk.toLowerCase() };
    });
}

function gmailLabelsForAction(action: string): { add: string[]; remove: string[] } {
  switch (action) {
    case 'markRead':
      return { add: [], remove: ['UNREAD'] };
    case 'markUnread':
      return { add: ['UNREAD'], remove: [] };
    case 'star':
      return { add: ['STARRED'], remove: [] };
    case 'unstar':
      return { add: [], remove: ['STARRED'] };
    case 'archive':
      return { add: [], remove: ['INBOX'] };
    case 'unarchive':
      return { add: ['INBOX'], remove: [] };
    case 'untrash':
      return { add: ['INBOX'], remove: ['TRASH'] };
    case 'spam':
      return { add: ['SPAM'], remove: ['INBOX'] };
    case 'notSpam':
      return { add: ['INBOX'], remove: ['SPAM'] };
    default:
      return { add: [], remove: [] };
  }
}

async function mirrorGmailState(
  mailboxEmail: string,
  threadId: string,
  changes: Record<string, any>,
  organizationId: string
): Promise<void> {
  const mailbox = await EmailAccount.findOne({ organizationId, emailAddress: mailboxEmail });
  if (!mailbox || mailbox.provider !== 'gmail' || mailbox.status !== 'connected') return;

  const add: string[] = [];
  const remove: string[] = [];
  if (changes.isRead === true) remove.push('UNREAD');
  if (changes.isRead === false) add.push('UNREAD');
  if (changes.isStarred === true) add.push('STARRED');
  if (changes.isStarred === false) remove.push('STARRED');
  if (changes.isArchived === true) remove.push('INBOX');
  if (changes.isArchived === false) add.push('INBOX');
  if (changes.isSpam === true) {
    add.push('SPAM');
    remove.push('INBOX');
  }
  if (changes.isSpam === false) {
    add.push('INBOX');
    remove.push('SPAM');
  }
  if (changes.isTrash === true) {
    await safeGmailCall(() => gmailProvider.trashThread(mailboxEmail, threadId, organizationId));
    return;
  }
  if (changes.isTrash === false) {
    add.push('INBOX');
    remove.push('TRASH');
  }

  if (add.length || remove.length) {
    await safeGmailCall(() => gmailProvider.modifyThread(mailboxEmail, threadId, add, remove, organizationId));
  }
}

async function safeGmailCall(fn: () => Promise<any>): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    if (err.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
      throw err;
    }
    console.warn('Gmail mirror operation failed (local state preserved):', err?.message || err);
  }
}

function handleGmailReauth(err: any, req: Request, res: Response, next: NextFunction): void {
  if (err?.code === 'GMAIL_REAUTH_REQUIRED' || isInvalidGrantError(err)) {
    res.status(401).json({
      success: false,
      error: {
        message: 'Gmail authorization expired or revoked. Please reconnect the account in Integrations.',
        code: 'GMAIL_REAUTH_REQUIRED',
        requiresReconnect: true,
        emailAddress: String(req.params.id || '').toLowerCase(),
      },
    });
    return;
  }
  next(err);
}

export default router;

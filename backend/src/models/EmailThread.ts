import mongoose, { Schema, Document } from 'mongoose';

export interface IEmailAttachment {
  /** Display filename, e.g. "invoice.pdf" or "logo.png" (inline images may omit it). */
  filename: string;
  mimeType?: string;
  size?: number;
  /** Gmail part body attachmentId, required to fetch the bytes from the Gmail API. */
  attachmentId?: string;
  /** Content-ID (without angle brackets) for inline `cid:` image references. */
  contentId?: string;
  /** Gmail MIME partId (e.g. "0.1") — stable identifier within the message. */
  partId?: string;
  /** True when the part is referenced inline in the HTML body (not a download). */
  isInline?: boolean;
  /**
   * Base64url-encoded bytes for small inline parts that Gmail embeds directly in
   * `body.data` (no attachmentId). Kept only for inline images so the reader can
   * render them without an extra round-trip.
   */
  inlineData?: string;
}

export interface IEmailMessageItem {
  id: string;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc?: { name: string; email: string }[];
  bcc?: { name: string; email: string }[];
  /** Sender-supplied Reply-To address (falls back to `from` when absent). */
  replyTo?: { name: string; email: string };
  subject: string;
  /** Plain-text rendering of the body (always present, used as a safe fallback). */
  bodyText: string;
  /** Sanitized-able HTML rendering of the body, when the message has an HTML part. */
  bodyHtml?: string;
  snippet: string;
  date: Date;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  attachments?: IEmailAttachment[];
  /** RFC 5322 Message-ID header, used for correct In-Reply-To/References on reply. */
  messageIdHeader?: string;
  /** RFC 5322 In-Reply-To header. */
  inReplyTo?: string;
  /** RFC 5322 References header chain. */
  references?: string;
}

export interface IEmailThread extends Document {
  organizationId: string;
  mailboxEmail: string;
  threadId: string;
  subject: string;
  snippet: string;
  lastMessageDate: Date;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isSpam: boolean;
  isTrash: boolean;
  isSnoozed: boolean;
  snoozedUntil?: Date;
  inInbox: boolean;
  hasAttachments: boolean;
  unreadCount: number;
  labels: string[];
  category?: string;
  lastFromName?: string;
  lastFromEmail?: string;
  participants: string[];
  companyId?: mongoose.Types.ObjectId;
  companyName?: string;
  campaignName?: string;
  messages: IEmailMessageItem[];
  createdAt: Date;
  updatedAt: Date;
}

const AddressSchema = new Schema(
  {
    name: { type: String, default: '' },
    email: { type: String, required: true, lowercase: true, trim: true },
  },
  { _id: false }
);

const AttachmentSchema = new Schema(
  {
    filename: { type: String, default: '' },
    mimeType: { type: String },
    size: { type: Number },
    attachmentId: { type: String },
    contentId: { type: String },
    partId: { type: String },
    isInline: { type: Boolean, default: false },
    inlineData: { type: String },
  },
  { _id: false }
);

const EmailMessageSubSchema = new Schema<IEmailMessageItem>(
  {
    id: { type: String, required: true },
    from: {
      name: { type: String, default: '' },
      email: { type: String, required: true, lowercase: true, trim: true },
    },
    to: [AddressSchema],
    cc: { type: [AddressSchema], default: [] },
    bcc: { type: [AddressSchema], default: [] },
    replyTo: { type: AddressSchema, default: undefined },
    subject: { type: String, required: true },
    bodyText: { type: String, required: true },
    bodyHtml: { type: String },
    snippet: { type: String, default: '' },
    date: { type: Date, default: Date.now },
    isRead: { type: Boolean, default: true },
    isStarred: { type: Boolean, default: false },
    hasAttachments: { type: Boolean, default: false },
    attachments: { type: [AttachmentSchema], default: [] },
    messageIdHeader: { type: String },
    inReplyTo: { type: String },
    references: { type: String },
  },
  { _id: false }
);

const EmailThreadSchema = new Schema<IEmailThread>(
  {
    organizationId: { type: String, required: true, index: true },
    mailboxEmail: { type: String, required: true, lowercase: true },
    threadId: { type: String, required: true },
    subject: { type: String, required: true, trim: true },
    snippet: { type: String, default: '' },
    lastMessageDate: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 1 },
    isRead: { type: Boolean, default: true },
    isStarred: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false },
    isSpam: { type: Boolean, default: false },
    isTrash: { type: Boolean, default: false },
    isSnoozed: { type: Boolean, default: false },
    snoozedUntil: { type: Date },
    inInbox: { type: Boolean, default: true },
    hasAttachments: { type: Boolean, default: false },
    unreadCount: { type: Number, default: 0 },
    labels: { type: [String], default: [] },
    category: { type: String },
    lastFromName: { type: String },
    lastFromEmail: { type: String, lowercase: true },
    participants: { type: [String], default: [] },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', index: true },
    companyName: { type: String },
    campaignName: { type: String },
    messages: { type: [EmailMessageSubSchema], default: [] },
  },
  { timestamps: true }
);

EmailThreadSchema.index({ organizationId: 1, mailboxEmail: 1, threadId: 1 }, { unique: true });
EmailThreadSchema.index({ organizationId: 1, mailboxEmail: 1, lastMessageDate: -1 });
EmailThreadSchema.index({ organizationId: 1, mailboxEmail: 1, inInbox: 1, isTrash: 1, isSpam: 1, lastMessageDate: -1 });

export const EmailThread = mongoose.model<IEmailThread>('EmailThread', EmailThreadSchema);

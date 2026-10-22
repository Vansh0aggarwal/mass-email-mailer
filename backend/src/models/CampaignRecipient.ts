import mongoose, { Schema, Document } from 'mongoose';

export type RecipientStatus =
  | 'pending'
  | 'prepared'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'replied'
  | 'failed'
  | 'skipped'
  | 'suppressed';

export interface IRecipientStepDraft {
  stepIndex: number;
  draftId?: mongoose.Types.ObjectId;
  status: 'pending' | 'draft' | 'approved' | 'sent' | 'failed' | 'skipped';
  providerMessageId?: string;
  providerThreadId?: string;
  error?: string;
  sentAt?: Date;
  scheduledAt?: Date;
}

export interface ICampaignRecipient extends Document {
  organizationId: string;
  campaignId: mongoose.Types.ObjectId;
  rowNumber: number;
  companyId?: mongoose.Types.ObjectId;
  contactId?: mongoose.Types.ObjectId;
  email: string;
  name?: string;
  companyName?: string;
  /** Bounded snapshot of source columns, used for personalization interpolation. */
  customFields: Record<string, string>;
  status: RecipientStatus;
  /** Highest number of fully-sent steps; equals steps.length once complete. */
  completedSteps: number;
  stepDrafts: IRecipientStepDraft[];
  /**
   * The connected Gmail account this recipient is assigned to. Assignment is
   * stable: once written it is never changed automatically, so a partial send
   * can never be duplicated by moving a recipient to another mailbox.
   */
  assignedAccountId?: string;
  /** Denormalized address of the assigned account (display + dispatch). */
  assignedAccountEmail?: string;
  /** When the account assignment was made. */
  assignedAt?: Date;
  /**
   * True once a step was actually sent from the assigned account. Locked
   * recipients can never be migrated to another account.
   */
  assignmentLocked?: boolean;
  lastSentAt?: Date;
  /** True once a genuine inbound reply has been associated with this recipient. */
  replied: boolean;
  repliedAt?: Date;
  /** Gmail thread id of the associated inbound reply, when known. */
  replyThreadId?: string;
  /** Text preview of the received reply message. */
  replySnippet?: string;
  /** Subject of the received reply message. */
  replySubject?: string;
  /** Sender address of the reply message. */
  replyFromEmail?: string;
  /** Mailbox (connected Gmail account) the reply was received in. */
  replyMailboxEmail?: string;
  skipReason?: string;
  canRetry?: boolean;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const RecipientStepDraftSchema = new Schema<IRecipientStepDraft>(
  {
    stepIndex: { type: Number, required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'EmailDraft' },
    status: {
      type: String,
      enum: ['pending', 'draft', 'approved', 'sent', 'failed', 'skipped'],
      default: 'pending',
    },
    providerMessageId: { type: String },
    providerThreadId: { type: String },
    error: { type: String },
    sentAt: { type: Date },
    scheduledAt: { type: Date },
  },
  { _id: false }
);

const CampaignRecipientSchema = new Schema<ICampaignRecipient>(
  {
    organizationId: { type: String, required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    rowNumber: { type: Number, required: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company' },
    contactId: { type: Schema.Types.ObjectId, ref: 'CompanyContact' },
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, trim: true },
    companyName: { type: String, trim: true },
    customFields: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ['pending', 'prepared', 'approved', 'sending', 'sent', 'replied', 'failed', 'skipped', 'suppressed'],
      default: 'pending',
      index: true,
    },
    completedSteps: { type: Number, default: 0 },
    assignedAccountId: { type: String, index: true },
    assignedAccountEmail: { type: String, trim: true, lowercase: true },
    assignedAt: { type: Date },
    assignmentLocked: { type: Boolean, default: false },
    lastSentAt: { type: Date },
    stepDrafts: { type: [RecipientStepDraftSchema], default: [] },
    replied: { type: Boolean, default: false },
    repliedAt: { type: Date },
    replyThreadId: { type: String, index: true },
    replySnippet: { type: String },
    replySubject: { type: String },
    replyFromEmail: { type: String },
    replyMailboxEmail: { type: String, trim: true, lowercase: true },
    skipReason: { type: String },
    canRetry: { type: Boolean, default: false },
    lastError: { type: String },
  },
  { timestamps: true }
);

CampaignRecipientSchema.index({ organizationId: 1, campaignId: 1, rowNumber: 1 });
CampaignRecipientSchema.index({ organizationId: 1, campaignId: 1, status: 1 });
// Fast lookup of a recipient by inbound sender email during reply association.
CampaignRecipientSchema.index({ organizationId: 1, email: 1, replied: 1, createdAt: -1 });
// Row number is unique per campaign import.
CampaignRecipientSchema.index({ campaignId: 1, rowNumber: 1 }, { unique: true });
// Index on campaignId and email for efficient queries.
CampaignRecipientSchema.index({ campaignId: 1, email: 1 });
// Per-account dispatch queue: find the next recipients of a sender account.
CampaignRecipientSchema.index({ organizationId: 1, campaignId: 1, assignedAccountId: 1, status: 1 });

export const CampaignRecipient = mongoose.model<ICampaignRecipient>(
  'CampaignRecipient',
  CampaignRecipientSchema
);

// Gracefully drop legacy unique index on (campaignId, email) if it exists so duplicate skipped records can be stored
CampaignRecipient.collection.dropIndex('campaignId_1_email_1').catch(() => {});


import mongoose, { Schema, Document } from 'mongoose';

export type DraftStatus =
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

export interface IEmailDraft extends Document {
  organizationId: string;
  campaignId?: mongoose.Types.ObjectId;
  recipientId?: mongoose.Types.ObjectId;
  stepIndex?: number;
  companyId?: mongoose.Types.ObjectId;
  companyName?: string;
  contactId?: mongoose.Types.ObjectId;
  recipientEmail: string;
  recipientName?: string;
  subject: string;
  bodyText: string;
  tone: string;
  status: DraftStatus;
  recommendedServiceId?: string;
  recommendedServiceName?: string;
  recommendationExplanation?: string;
  factsUsed: string[];
  missingInformation: string[];
  warnings: string[];
  /** Offending company-like phrase found in the copy that does not match this recipient. */
  companyNameMismatch?: string;
  /** Unverified factual claims detected in copy (incorporation, website status, etc.) */
  unsupportedClaims?: string[];
  estimatedCostUsd: number;
  isFallbackTemplate: boolean;
  /** Distinguishes cold outreach from an AI-assisted reply to an inbound message. */
  kind: 'outreach' | 'reply';
  /** Present for reply drafts so they can be sent into the correct thread. */
  replyContext?: {
    mailboxEmail: string;
    threadId: string;
    inReplyTo?: string;
    action?: string;
  };
  sentAt?: Date;
  providerMessageId?: string;
  providerThreadId?: string;
  messageIdHeader?: string;
  originalSubject?: string;
  originalBodyText?: string;
  isManualEdit?: boolean;
  generationSource?: 'csv_template' | 'personalized_template' | 'ai_grounded' | 'manual_edit';
  createdAt: Date;
  updatedAt: Date;
}

const EmailDraftSchema = new Schema<IEmailDraft>(
  {
    organizationId: { type: String, required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'CampaignRecipient', index: true },
    stepIndex: { type: Number },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', index: true },
    companyName: { type: String, trim: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'CompanyContact', index: true },
    recipientEmail: { type: String, required: true, trim: true, lowercase: true },
    recipientName: { type: String, trim: true },
    subject: { type: String, required: true, trim: true },
    bodyText: { type: String, required: true },
    tone: { type: String, default: 'consultative' },
    status: {
      type: String,
      enum: [
        'draft',
        'pending_approval',
        'approved',
        'rejected',
        'queued',
        'sending',
        'accepted',
        'failed',
        'unknown_outcome',
        'archived',
      ],
      default: 'draft',
      index: true,
    },
    recommendedServiceId: { type: String },
    recommendedServiceName: { type: String },
    recommendationExplanation: { type: String },
    factsUsed: { type: [String], default: [] },
    missingInformation: { type: [String], default: [] },
    warnings: { type: [String], default: [] },
    companyNameMismatch: { type: String },
    unsupportedClaims: { type: [String], default: [] },
    estimatedCostUsd: { type: Number, default: 0 },
    isFallbackTemplate: { type: Boolean, default: false },
    kind: { type: String, enum: ['outreach', 'reply'], default: 'outreach', index: true },
    replyContext: {
      mailboxEmail: { type: String, lowercase: true, trim: true },
      threadId: { type: String },
      inReplyTo: { type: String },
      action: { type: String },
    },
    sentAt: { type: Date },
    providerMessageId: { type: String, index: true },
    providerThreadId: { type: String, index: true },
    messageIdHeader: { type: String, index: true },
    originalSubject: { type: String },
    originalBodyText: { type: String },
    isManualEdit: { type: Boolean, default: false },
    generationSource: {
      type: String,
      enum: ['csv_template', 'personalized_template', 'ai_grounded', 'manual_edit'],
      default: 'csv_template',
    },
  },
  { timestamps: true }
);

EmailDraftSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
EmailDraftSchema.index({ organizationId: 1, campaignId: 1, createdAt: -1 });
EmailDraftSchema.index({ organizationId: 1, campaignId: 1, recipientId: 1, stepIndex: 1 });
EmailDraftSchema.index({ organizationId: 1, providerThreadId: 1 });

export const EmailDraft = mongoose.model<IEmailDraft>('EmailDraft', EmailDraftSchema);

import mongoose, { Schema, Document } from 'mongoose';

export type SendAttemptStatus =
  | 'pending_check'
  | 'dispatching'
  | 'accepted'
  | 'failed'
  | 'unknown_timeout'
  | 'deferred';

export interface IEmailSendAttempt extends Document {
  organizationId: string;
  draftId: mongoose.Types.ObjectId;
  /** Campaign this send belongs to, when it is a campaign dispatch (not a test/workspace send). */
  campaignId?: mongoose.Types.ObjectId;
  /** Campaign recipient this send belongs to, when applicable. */
  recipientId?: mongoose.Types.ObjectId;
  /** Zero-based campaign step index this send belongs to, when applicable. */
  stepIndex?: number;
  mailboxId: string;
  /**
   * The connected Gmail account (`EmailAccount._id`) that actually performed the
   * send. Distinct from `mailboxId` (the address) so per-account reporting and
   * reconciliation can rely on a stable identifier.
   */
  accountId?: string;
  actorId: string;
  recipientEmail: string;
  idempotencyKey: string;
  status: SendAttemptStatus;
  providerMessageId?: string;
  providerThreadId?: string;
  errorMessage?: string;
  /** Number of dispatch attempts made for this logical send. */
  attempts: number;
  /**
   * True when the provider outcome is unknown (e.g. a timeout after the request
   * was transmitted). The message may or may not have been delivered, so it must
   * be reconciled before any retry to avoid duplicate sends.
   */
  deliveryUncertain: boolean;
  /** Earliest time a deferred (quota-limited) send may be retried. */
  deferredUntil?: Date;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

const EmailSendAttemptSchema = new Schema<IEmailSendAttempt>(
  {
    organizationId: { type: String, required: true, index: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'EmailDraft', required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'CampaignRecipient', index: true },
    stepIndex: { type: Number },
    mailboxId: { type: String, required: true },
    accountId: { type: String, index: true },
    actorId: { type: String, required: true },
    recipientEmail: { type: String, required: true, lowercase: true },
    idempotencyKey: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending_check', 'dispatching', 'accepted', 'failed', 'unknown_timeout', 'deferred'],
      default: 'pending_check',
    },
    providerMessageId: { type: String, index: true },
    providerThreadId: { type: String, index: true },
    errorMessage: { type: String },
    attempts: { type: Number, default: 0 },
    deliveryUncertain: { type: Boolean, default: false },
    deferredUntil: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Enforce unique idempotencyKey per tenant to block race conditions and double-sends
EmailSendAttemptSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
// Fast, dedupe-safe count of accepted sends per campaign (campaign "Sent" metric).
EmailSendAttemptSchema.index({ organizationId: 1, campaignId: 1, status: 1 });
// Per-account campaign reporting ("sent by each connected Gmail account").
EmailSendAttemptSchema.index({ organizationId: 1, campaignId: 1, accountId: 1, status: 1 });
EmailSendAttemptSchema.index({ organizationId: 1, providerThreadId: 1 });

export const EmailSendAttempt = mongoose.model<IEmailSendAttempt>('EmailSendAttempt', EmailSendAttemptSchema);

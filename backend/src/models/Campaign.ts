import mongoose, { Schema, Document } from 'mongoose';

export type CampaignStatus =
  | 'draft'
  | 'generating'
  | 'ready_for_review'
  | 'scheduled'
  | 'sending'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ICampaignStep {
  stepIndex: number;
  subject: string;
  bodyText: string;
  /** Days to wait after the previous step before this follow-up becomes due. */
  delayDays: number;
}

export interface ICampaignSchedule {
  /** Absolute UTC instant the campaign becomes eligible to send. */
  startAt: Date;
  /** IANA timezone used to interpret the sending window (display/precision only). */
  timezone: string;
  /** Recipients processed per scheduler tick. */
  batchSize: number;
  /** Minutes between scheduler ticks for this campaign. */
  paceMinutes: number;
  /** Optional permitted sending window in the schedule's timezone (0-23, local hours). */
  windowStartHour?: number;
  windowEndHour?: number;
  /** Permitted weekdays in the schedule timezone (0 = Sunday ... 6 = Saturday). */
  allowedWeekdays?: number[];
  /**
   * Global minimum spacing between two sends from the same account (seconds).
   * A per-account value on the sender roster takes precedence.
   */
  minIntervalSeconds?: number;
  /** Global randomized extra spacing bound (seconds). */
  jitterSeconds?: number;
  /** Global per-account hourly rate cap. */
  maxPerHour?: number;
  /** Global per-account daily cap. */
  dailySendCap?: number;
  /** Display label captured at scheduling time. */
  label?: string;
  scheduledBy: string;
  scheduledAt: Date;
  /** Last time the background scheduler processed this campaign. */
  lastRunAt?: Date;
}

/**
 * One connected Gmail account that participates in a campaign.
 *
 * The roster is the campaign's sender list: it is deliberately separate from
 * `Campaign.mailboxId` (the legacy single-sender field) and from campaign
 * membership. Every recipient is assigned to exactly one roster entry.
 */
export interface ICampaignSenderAccount {
  /** `EmailAccount._id` of the connected Gmail account. */
  accountId: string;
  /** Denormalized mailbox address (the Gmail "user" for quota purposes). */
  emailAddress: string;
  displayName?: string;
  /** User toggle: a disabled account never receives campaign sends. */
  enabled: boolean;
  /** Effective daily cap for this account inside this campaign. */
  dailySendCap: number;
  /** Maximum sends per hour for this account. */
  maxPerHour: number;
  /** Minimum spacing between two sends from this account (seconds). */
  minIntervalSeconds: number;
  /** Randomized extra spacing added on top of the minimum (seconds). */
  jitterSeconds: number;
  /** Recipients currently assigned to this account. */
  assignedCount: number;
  /** Campaign steps sent from this account so far. */
  sentCount: number;
  /** Timestamp of the last successful send from this account. */
  lastSentAt?: Date;
  /** Earliest time this account may send again (computed by the sender queue). */
  nextSendAt?: Date;
  /**
   * Set when the account cannot be used at all (disconnected, revoked, paused
   * or missing a scope). Transient states (a reached cap, no due recipient)
   * are never stored here — they are computed live by the sender queue.
   */
  unavailableReason?: string;
  /** Machine readable reason why the account is unavailable. */
  unavailableReasonCode?: string;
  /** When the account was held back by the sender queue. */
  pausedAt?: Date;
  lastError?: string;
}

export interface ICampaignStats {
  totalRecipients: number;
  prepared: number;
  sent: number;
  failed: number;
  skipped: number;
  replied?: number;
}

export interface ICampaign extends Document {
  organizationId: string;
  name: string;
  status: CampaignStatus;
  mailboxId: string;
  /**
   * Connected Gmail accounts that participate in this campaign. Empty means
   * the campaign falls back to the legacy single `mailboxId` sender.
   */
  senderAccounts?: ICampaignSenderAccount[];
  tone: string;
  /** 'template' = deterministic {{token}} merge; 'ai' = real AI provider per company. */
  generationMode: 'template' | 'ai';
  /** Optional service theme used to ground AI generation. */
  targetService?: string;
  /** Optional scheduled start (durable campaigns). */
  schedule?: ICampaignSchedule;
  /** Set when the campaign is mid-send under the background scheduler. */
  lastScheduledRunAt?: Date;
  /** Number of inbound replies associated with this campaign. */
  repliesReceived: number;
  steps: ICampaignStep[];
  /** Maps a source CSV header -> a bounded custom field key on Company.customFields. */
  customFieldMapping: Record<string, string>;
  /** Maps a source CSV header -> the fixed destination field, as performed at import time. */
  columnMapping: Record<string, string>;
  importId?: mongoose.Types.ObjectId;
  importJobId?: mongoose.Types.ObjectId;
  createdBy: string;
  stats: ICampaignStats;
  /** Cursor used to resume batched draft generation without redoing work. */
  generationCursor: number;
  /** Cursor used to resume batched sending without redoing work. */
  sendCursor: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignStepSchema = new Schema<ICampaignStep>(
  {
    stepIndex: { type: Number, required: true },
    subject: { type: String, required: true, trim: true },
    bodyText: { type: String, required: true },
    delayDays: { type: Number, default: 0, min: 0, max: 90 },
  },
  { _id: false }
);

const CampaignSenderAccountSchema = new Schema<ICampaignSenderAccount>(
  {
    accountId: { type: String, required: true },
    emailAddress: { type: String, required: true, trim: true, lowercase: true },
    displayName: { type: String, trim: true },
    enabled: { type: Boolean, default: true },
    dailySendCap: { type: Number, default: 100, min: 0, max: 2000 },
    maxPerHour: { type: Number, default: 60, min: 0, max: 2000 },
    minIntervalSeconds: { type: Number, default: 60, min: 0, max: 86400 },
    jitterSeconds: { type: Number, default: 0, min: 0, max: 3600 },
    assignedCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    lastSentAt: { type: Date },
    nextSendAt: { type: Date },
    unavailableReason: { type: String },
    unavailableReasonCode: { type: String },
    pausedAt: { type: Date },
    lastError: { type: String },
  },
  { _id: false }
);

const CampaignScheduleSchema = new Schema<ICampaignSchedule>(
  {
    startAt: { type: Date, required: true },
    timezone: { type: String, default: 'UTC' },
    batchSize: { type: Number, default: 25, min: 1, max: 200 },
    paceMinutes: { type: Number, default: 0, min: 0, max: 1440 },
    windowStartHour: { type: Number, min: 0, max: 23 },
    windowEndHour: { type: Number, min: 0, max: 23 },
    allowedWeekdays: { type: [Number], default: undefined },
    minIntervalSeconds: { type: Number, min: 0, max: 86400 },
    jitterSeconds: { type: Number, min: 0, max: 3600 },
    maxPerHour: { type: Number, min: 0, max: 2000 },
    dailySendCap: { type: Number, min: 0, max: 2000 },
    label: { type: String },
    scheduledBy: { type: String, default: 'system' },
    scheduledAt: { type: Date, default: Date.now },
    lastRunAt: { type: Date },
  },
  { _id: false }
);

const CampaignSchema = new Schema<ICampaign>(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: [
        'draft',
        'generating',
        'ready_for_review',
        'scheduled',
        'sending',
        'paused',
        'completed',
        'failed',
        'cancelled',
      ],
      default: 'draft',
      index: true,
    },
    mailboxId: { type: String, required: true, trim: true, lowercase: true },
    senderAccounts: { type: [CampaignSenderAccountSchema], default: [] },
    tone: { type: String, default: 'consultative' },
    generationMode: { type: String, enum: ['template', 'ai'], default: 'template' },
    targetService: { type: String, trim: true },
    schedule: { type: CampaignScheduleSchema, default: undefined },
    lastScheduledRunAt: { type: Date },
    repliesReceived: { type: Number, default: 0 },
    steps: { type: [CampaignStepSchema], default: [] },
    customFieldMapping: { type: Schema.Types.Mixed, default: {} },
    columnMapping: { type: Schema.Types.Mixed, default: {} },
    importId: { type: Schema.Types.ObjectId, ref: 'CSVImport' },
    importJobId: { type: Schema.Types.ObjectId, ref: 'CampaignImportJob' },
    createdBy: { type: String, required: true },
    stats: {
      totalRecipients: { type: Number, default: 0 },
      prepared: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
    },
    generationCursor: { type: Number, default: 0 },
    sendCursor: { type: Number, default: 0 },
    lastError: { type: String },
  },
  { timestamps: true }
);

CampaignSchema.index({ organizationId: 1, createdAt: -1 });
CampaignSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
CampaignSchema.index({ status: 1, 'schedule.startAt': 1 });
// Sender roster lookups (per-account dispatch, allocation, progress).
CampaignSchema.index({ organizationId: 1, 'senderAccounts.accountId': 1 });

export const Campaign = mongoose.model<ICampaign>('Campaign', CampaignSchema);

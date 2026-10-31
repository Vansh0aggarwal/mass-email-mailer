import mongoose, { Schema, Document } from 'mongoose';

/**
 * Lifecycle of a split import (one uploaded file -> many child campaigns).
 *
 * `analyzing` and `generating` are long-running background phases. `ready`
 * means analysis finished and the user still has to confirm the split preview,
 * which is deliberate: nothing is generated until the operator approves the
 * proposed campaign count.
 */
export type CampaignSplitStatus =
  | 'queued'
  | 'analyzing'
  | 'ready'
  | 'generating'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancellation_requested'
  | 'cancelled';

export type CampaignSplitPhase = 'upload' | 'analysis' | 'ready' | 'generation' | 'done';

export interface ICampaignSplitStep {
  stepIndex: number;
  subject: string;
  bodyText: string;
  delayDays: number;
}

export interface ICampaignSplitJob extends Document {
  organizationId: string;
  /** Authenticated user who started the split (never taken from the client body). */
  createdBy: string;
  /** Human label for the batch, e.g. "October Prospect Import". */
  groupName: string;
  /** Template used for child names. Supports `{group}` and `{number}`. */
  campaignNamePattern: string;

  fileName: string;
  fileSizeBytes: number;
  uploadId?: string;
  storedFilePath?: string;
  fileType?: 'csv' | 'xlsx';
  totalRows: number;
  totalRowsIsExact: boolean;

  status: CampaignSplitStatus;
  phase: CampaignSplitPhase;

  // ---- Analysis counters (each source row contributes to exactly one bucket) ----
  processedRows: number;
  /** Last source row number durably processed; used to resume analysis. */
  lastProcessedRow: number;
  /** Unique, valid, non-suppressed contacts that will be distributed. */
  validContacts: number;
  invalidContacts: number;
  duplicateContacts: number;
  suppressedContacts: number;
  analyzedAt?: Date;
  analysisThroughputRowsPerSecond?: number;

  // ---- Split configuration ----
  contactsPerCampaign: number;
  expectedCampaigns: number;
  lastCampaignContacts: number;

  // ---- Generation counters ----
  campaignsCreated: number;
  contactsAssigned: number;
  failedCampaigns: number;
  failedCampaignNumbers: number[];
  currentCampaignNumber: number;
  currentCampaignName?: string;
  generationStartedAt?: Date;
  /** Allocation pass cursor: last staged row number assigned to a campaign. */
  allocationCheckpointRow: number;
  allocationComplete: boolean;

  /**
   * Copies of the campaign definition shared by every child campaign. Children
   * are still independent Campaign documents, so approval, scheduling and
   * sending all flow through the existing campaign lifecycle.
   */
  mailboxId: string;
  senderAccountIds: string[];
  tone: string;
  generationMode: 'template' | 'ai';
  targetService?: string;
  steps: ICampaignSplitStep[];
  columnMapping: Record<string, string>;
  customFieldMapping: Record<string, string>;
  scaleType: 'standard' | 'five_star' | 'ten_point';

  errorReportPath?: string;
  hasErrorReport: boolean;
  errorMessage?: string;

  heartbeatAt?: Date;
  startedAt?: Date;
  completedAt?: Date;

  cancellationRequestedAt?: Date;
  cancelledAt?: Date;
  cancelledBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

const CampaignSplitStepSchema = new Schema<ICampaignSplitStep>(
  {
    stepIndex: { type: Number, required: true },
    subject: { type: String, required: true },
    bodyText: { type: String, required: true },
    delayDays: { type: Number, default: 0, min: 0, max: 90 },
  },
  { _id: false }
);

const CampaignSplitJobSchema = new Schema<ICampaignSplitJob>(
  {
    organizationId: { type: String, required: true, index: true },
    createdBy: { type: String, required: true },
    groupName: { type: String, required: true, trim: true },
    campaignNamePattern: { type: String, default: '{group} – Campaign {number}' },

    fileName: { type: String, required: true },
    fileSizeBytes: { type: Number, default: 0 },
    uploadId: { type: String, index: true },
    storedFilePath: { type: String },
    fileType: { type: String, enum: ['csv', 'xlsx'], default: 'csv' },
    totalRows: { type: Number, default: 0 },
    totalRowsIsExact: { type: Boolean, default: true },

    status: {
      type: String,
      enum: [
        'queued',
        'analyzing',
        'ready',
        'generating',
        'completed',
        'completed_with_errors',
        'failed',
        'cancellation_requested',
        'cancelled',
      ],
      default: 'queued',
      index: true,
    },
    phase: {
      type: String,
      enum: ['upload', 'analysis', 'ready', 'generation', 'done'],
      default: 'upload',
    },

    processedRows: { type: Number, default: 0 },
    lastProcessedRow: { type: Number, default: 0 },
    validContacts: { type: Number, default: 0 },
    invalidContacts: { type: Number, default: 0 },
    duplicateContacts: { type: Number, default: 0 },
    suppressedContacts: { type: Number, default: 0 },
    analyzedAt: { type: Date },
    analysisThroughputRowsPerSecond: { type: Number, default: 0 },

    contactsPerCampaign: { type: Number, required: true, min: 1, max: 10000 },
    expectedCampaigns: { type: Number, default: 0 },
    lastCampaignContacts: { type: Number, default: 0 },

    campaignsCreated: { type: Number, default: 0 },
    contactsAssigned: { type: Number, default: 0 },
    failedCampaigns: { type: Number, default: 0 },
    failedCampaignNumbers: { type: [Number], default: [] },
    currentCampaignNumber: { type: Number, default: 0 },
    currentCampaignName: { type: String },
    generationStartedAt: { type: Date },
    allocationCheckpointRow: { type: Number, default: 0 },
    allocationComplete: { type: Boolean, default: false },

    mailboxId: { type: String, required: true, trim: true, lowercase: true },
    senderAccountIds: { type: [String], default: [] },
    tone: { type: String, default: 'consultative' },
    generationMode: { type: String, enum: ['template', 'ai'], default: 'template' },
    targetService: { type: String, trim: true },
    steps: { type: [CampaignSplitStepSchema], default: [] },
    columnMapping: { type: Schema.Types.Mixed, default: {} },
    customFieldMapping: { type: Schema.Types.Mixed, default: {} },
    scaleType: {
      type: String,
      enum: ['standard', 'five_star', 'ten_point'],
      default: 'standard',
    },

    errorReportPath: { type: String },
    hasErrorReport: { type: Boolean, default: false },
    errorMessage: { type: String },

    heartbeatAt: { type: Date, default: Date.now },
    startedAt: { type: Date },
    completedAt: { type: Date },

    cancellationRequestedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelledBy: { type: String },
  },
  { timestamps: true }
);

CampaignSplitJobSchema.index({ organizationId: 1, createdAt: -1 });
CampaignSplitJobSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
// Recovery sweep: jobs left mid-flight by a restart.
CampaignSplitJobSchema.index({ status: 1, heartbeatAt: 1 });

export const CampaignSplitJob = mongoose.model<ICampaignSplitJob>(
  'CampaignSplitJob',
  CampaignSplitJobSchema
);

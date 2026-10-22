import mongoose, { Schema, Document } from 'mongoose';

export type CampaignJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancellation_requested'
  | 'cancelling'
  | 'cancelled';

export interface ICampaignImportJobRowError {
  row: number;
  field: string;
  reason: string;
}

export interface ICampaignImportJob extends Document {
  organizationId: string;
  campaignId: mongoose.Types.ObjectId;
  campaignName: string;
  fileName?: string;
  status: CampaignJobStatus;
  phase?: string;
  totalRows: number;
  totalRowsIsExact: boolean;
  processedRows: number;
  committedRows: number;
  checkpointRow: number;
  importedCount: number; // successfully created/linked recipients
  skippedCount: number;  // skipped due to suppression, duplicates, missing email, format errors
  failedRows: number;    // database insert failure
  currentRow: number;
  currentRecipientEmail?: string;
  currentCompanyName?: string;
  throughputRowsPerSecond?: number;
  estimatedTimeRemainingSeconds?: number;
  fileSizeBytes?: number;
  uploadedBytes?: number;
  hasErrorReport?: boolean;
  rowErrors: ICampaignImportJobRowError[];
  uploadId?: string;
  storedFilePath?: string;
  fileType?: 'csv' | 'xlsx';
  errorReportPath?: string;
  lastProcessedRow?: number;
  errorMessage?: string;
  heartbeatAt?: Date;
  cancellationRequestedAt?: Date;
  cancelledAt?: Date;
  cancelledBy?: string;
  createdCompanyIds?: mongoose.Types.ObjectId[];
  createdContactIds?: mongoose.Types.ObjectId[];
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignImportJobSchema = new Schema<ICampaignImportJob>(
  {
    organizationId: { type: String, required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    campaignName: { type: String, required: true },
    fileName: { type: String, default: 'recipients.csv' },
    uploadId: { type: String, index: true },
    storedFilePath: { type: String },
    fileType: { type: String, enum: ['csv', 'xlsx'], default: 'csv' },
    errorReportPath: { type: String },
    lastProcessedRow: { type: Number, default: 0 },
    checkpointRow: { type: Number, default: 0 },
    committedRows: { type: Number, default: 0 },
    throughputRowsPerSecond: { type: Number, default: 0 },
    estimatedTimeRemainingSeconds: { type: Number, default: 0 },
    fileSizeBytes: { type: Number, default: 0 },
    uploadedBytes: { type: Number, default: 0 },
    hasErrorReport: { type: Boolean, default: false },
    status: {
      type: String,
      enum: [
        'queued',
        'processing',
        'completed',
        'completed_with_errors',
        'failed',
        'cancellation_requested',
        'cancelling',
        'cancelled',
      ],
      default: 'queued',
      index: true,
    },
    phase: { type: String, default: 'queued' },
    heartbeatAt: { type: Date, default: Date.now },
    cancellationRequestedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelledBy: { type: String },
    createdCompanyIds: { type: [Schema.Types.ObjectId], ref: 'Company', default: [] },
    createdContactIds: { type: [Schema.Types.ObjectId], ref: 'CompanyContact', default: [] },
    totalRows: { type: Number, default: 0 },
    totalRowsIsExact: { type: Boolean, default: true },
    processedRows: { type: Number, default: 0 },
    importedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    failedRows: { type: Number, default: 0 },
    currentRow: { type: Number, default: 0 },
    currentRecipientEmail: { type: String },
    currentCompanyName: { type: String },
    rowErrors: { type: [{ row: Number, field: String, reason: String }], default: [] },
    errorMessage: { type: String },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true }
);

export const CampaignImportJob = mongoose.model<ICampaignImportJob>(
  'CampaignImportJob',
  CampaignImportJobSchema
);

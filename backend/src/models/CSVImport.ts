import mongoose, { Schema, Document } from 'mongoose';

export type ImportJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  // legacy statuses retained so previously persisted documents remain valid
  | 'pending'
  | 'validated'
  | 'cancellation_requested'
  | 'cancelling'
  | 'cancelled';

export interface ImportRowError {
  row: number;
  field: string;
  reason: string;
}

export interface ICSVImport extends Document {
  organizationId: string;
  fileName: string;
  /** Rows detected in the source file. */
  totalRows: number;
  /** Valid, non-duplicate rows that were inserted or updated. */
  validRows: number;
  /** Rows that failed validation. */
  errorRows: number;
  /** Rows skipped because they were duplicates. */
  duplicateRows: number;
  /** New companies created. */
  importedCount: number;
  /** Existing companies updated (fill-empty-only). */
  updatedCount: number;
  /** Rows consumed by the streaming processor (resume cursor companion). */
  processedRows: number;
  /** Rows rejected by validation (alias of errorRows for the job view). */
  invalidRows: number;
  /** Rows that failed during the database write phase. */
  failedRows: number;
  /** Zero-based index of the next row to process — enables safe resume/retry. */
  lastProcessedRow: number;
  /** Number of row-level errors kept inline (full report lives on disk). */
  rowErrorCount: number;
  status: ImportJobStatus;
  /** Bounded inline error sample; the complete report is streamed from disk. */
  rowErrors: ImportRowError[];
  mapping: Record<string, string>;
  customFieldMapping?: Record<string, string>;
  duplicateStrategy?: 'skip' | 'update';
  scaleType?: 'standard' | 'five_star' | 'ten_point';
  fileBytes: number;
  storedFilePath?: string;
  errorReportPath?: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  heartbeatAt?: Date;
  cancellationRequestedAt?: Date;
  cancelledAt?: Date;
  cancelledBy?: string;
  createdCompanyIds?: mongoose.Types.ObjectId[];
  createdContactIds?: mongoose.Types.ObjectId[];
  startedAt?: Date;
  finishedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CSVImportSchema = new Schema<ICSVImport>(
  {
    organizationId: { type: String, required: true, index: true },
    fileName: { type: String, required: true },
    totalRows: { type: Number, default: 0 },
    validRows: { type: Number, default: 0 },
    errorRows: { type: Number, default: 0 },
    duplicateRows: { type: Number, default: 0 },
    importedCount: { type: Number, default: 0 },
    updatedCount: { type: Number, default: 0 },
    processedRows: { type: Number, default: 0 },
    invalidRows: { type: Number, default: 0 },
    failedRows: { type: Number, default: 0 },
    lastProcessedRow: { type: Number, default: 0 },
    rowErrorCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: [
        'queued',
        'processing',
        'completed',
        'completed_with_errors',
        'failed',
        'pending',
        'validated',
        'cancellation_requested',
        'cancelling',
        'cancelled',
      ],
      default: 'queued',
    },
    heartbeatAt: { type: Date, default: Date.now },
    cancellationRequestedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelledBy: { type: String },
    createdCompanyIds: { type: [Schema.Types.ObjectId], ref: 'Company', default: [] },
    createdContactIds: { type: [Schema.Types.ObjectId], ref: 'CompanyContact', default: [] },
    rowErrors: { type: [{ row: Number, field: String, reason: String }], default: [] },
    mapping: { type: Schema.Types.Mixed, default: {} },
    customFieldMapping: { type: Schema.Types.Mixed, default: {} },
    duplicateStrategy: { type: String, enum: ['skip', 'update'], default: 'skip' },
    scaleType: { type: String, enum: ['standard', 'five_star', 'ten_point'], default: 'standard' },
    fileBytes: { type: Number, default: 0 },
    storedFilePath: { type: String },
    errorReportPath: { type: String },
    headers: { type: [String], default: [] },
    sampleRows: { type: Schema.Types.Mixed, default: [] },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    errorMessage: { type: String },
  },
  { timestamps: true }
);

CSVImportSchema.index({ organizationId: 1, createdAt: -1 });
CSVImportSchema.index({ organizationId: 1, status: 1 });

export const CSVImport = mongoose.model<ICSVImport>('CSVImport', CSVImportSchema);

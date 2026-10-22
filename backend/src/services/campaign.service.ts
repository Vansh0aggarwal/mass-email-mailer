import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient, ICampaignRecipient } from '../models/CampaignRecipient.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { CSVImport } from '../models/CSVImport.js';
import { CampaignImportJob, ICampaignImportJob } from '../models/CampaignImportJob.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { Suppression } from '../models/Suppression.js';
import { WorkspaceSettings } from '../models/WorkspaceSettings.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  parseCsvString,
  parseCsvDetailed,
  validateAndNormalizeRows,
  normalizeParsedRow,
  createDuplicateSets,
  mappedValue,
  extractDomainFromUrl,
  ColumnMapping,
  assertByteLimit,
  assertRowLimit,
} from '../services/csv-parser.service.js';
import {
  createSpreadsheetRowStream,
  inspectSpreadsheetFile,
  safeUnlinkFile,
  resolveUploadedFilePath,
  writeCsvStringToTempFile,
  cleanupStaleUploads,
  appendRowErrorToDisk,
  getJobErrorReportPath,
  abortUploadSession,
} from '../services/spreadsheet-stream.service.js';
import { env } from '../config/env.js';
import {
  boundCustomFields,
  buildInterpolationValues,
  interpolateTemplate,
  sanitizeHeaderValue,
  isCompanyNameLike,
  detectCompanyNameMismatch,
  validateEmailCopy,
  repairUnsupportedClaims,
  STEP_COPY_FIELD_KEYS,
  MAX_TEMPLATE_LENGTH,
} from '../services/template-interpolation.service.js';
import { emailSendPipelineService } from '../services/email-send-pipeline.service.js';
import { senderAccountService } from '../services/sender-account.service.js';
import { senderAllocationService } from '../services/sender-allocation.service.js';
import { aiGroundingService } from '../providers/ai/ai-grounding.service.js';

export interface CampaignStepInput {
  subject: string;
  bodyText: string;
  delayDays?: number;
}

/** CSV custom-field keys that describe a company's documented needs. */
const NEED_FIELD_KEYS = ['requirements', 'business_needs', 'documented_problems', 'website_issues'];

function extractDeclaredNeeds(customFields: Record<string, string>): string[] {
  const needs: string[] = [];
  for (const key of NEED_FIELD_KEYS) {
    if (customFields[key]) needs.push(customFields[key]);
  }
  return needs.slice(0, 5);
}

type SupportedTone = 'professional' | 'friendly' | 'concise' | 'consultative' | 'urgent';

function coerceTone(tone?: string): SupportedTone {
  const allowed: SupportedTone[] = ['professional', 'friendly', 'concise', 'consultative', 'urgent'];
  return allowed.includes(tone as SupportedTone) ? (tone as SupportedTone) : 'consultative';
}

function resolveTargetService(campaignTarget: string | undefined, customFields: Record<string, string>): string {
  return (
    campaignTarget ||
    customFields['recommended_service'] ||
    customFields['recommended_service_or_solution'] ||
    customFields['service'] ||
    customFields['proposed_solution'] ||
    'Website Modernization'
  );
}

export interface CreateCampaignInput {
  organizationId: string;
  actorId: string;
  name: string;
  mailboxId: string;
  tone?: string;
  generationMode?: 'template' | 'ai';
  targetService?: string;
  steps: CampaignStepInput[];
  csvContent?: string;
  uploadId?: string;
  columnMapping: Record<string, string>;
  customFieldMapping?: Record<string, string>;
  scaleType?: 'standard' | 'five_star' | 'ten_point';
  duplicateStrategy?: 'skip' | 'include';
  senderName?: string;
  /**
   * Connected accounts that form the campaign's sender roster. When present
   * the recipients are spread over these mailboxes instead of the single
   * `mailboxId` sender.
   */
  senderAccountIds?: string[];
}

export interface CreateCampaignResult {
  campaignId: string;
  importId: string;
  summary: {
    totalRows: number;
    validRows: number;
    errorRows: number;
    duplicateRows: number;
    recipientsCreated: number;
  };
  warnings: string[];
}

export interface BatchResult {
  processed: number;
  remaining: number;
  status: string;
  stats: { totalRecipients: number; prepared: number; sent: number; failed: number; skipped: number };
  /**
   * Mailboxes that did not send in this batch because their daily or hourly
   * cap is reached. Their recipients stay queued and are sent later.
   */
  throttledAccounts?: { accountId: string; emailAddress: string; reason: string }[];
}

/**
 * Outcome of dispatching a single recipient step.
 *
 * `counted` mirrors the historical batch accounting: only a recipient that
 * actually reached the send pipeline counts as "processed".
 */
export interface RecipientStepOutcome {
  status:
    | 'sent'
    | 'deferred'
    | 'failed'
    | 'replied'
    | 'complete'
    | 'not_ready'
    | 'not_due'
    | 'suppressed';
  /** The recipient reached the pipeline and counts as processed. */
  counted: boolean;
  /** The account's daily allowance is exhausted — the batch must stop. */
  stopForLimit: boolean;
  /** The account is quota limited — the batch must yield. */
  quotaDeferred: boolean;
  /** The provider message id, when the send was accepted. */
  providerMessageId?: string;
  /** The provider thread id, when the send was accepted. */
  providerThreadId?: string;
  errorMessage?: string;
}

const MAX_BATCH_SIZE = 200;

function clampBatch(batchSize: number | undefined): number {
  const n = Math.floor(Number(batchSize) || 0);
  if (n <= 0) return 25;
  return Math.min(n, MAX_BATCH_SIZE);
}

function isStepDue(lastSentAt: Date | undefined, delayDays?: number): boolean {
  if (!lastSentAt || !delayDays) return true;
  const due = new Date(lastSentAt).getTime() + delayDays * 24 * 60 * 60 * 1000;
  return Date.now() >= due;
}

export function getImportedStepCopy(
  customObj: Record<string, string>,
  stepIndex: number,
  hasZeroIndexStep: boolean = true
): { subject?: string; body?: string } {
  const stepNum = hasZeroIndexStep ? stepIndex + 1 : stepIndex;
  const subj1 = customObj[`step_${stepNum}_subject`];
  const body1 = customObj[`step_${stepNum}_body`];
  if (subj1 || body1) {
    return { subject: subj1, body: body1 };
  }
  // Only fallback to 0-indexed if step_0_subject was explicitly provided in customObj
  if (customObj['step_0_subject'] || customObj['step_0_body']) {
    return {
      subject: customObj[`step_${stepIndex}_subject`],
      body: customObj[`step_${stepIndex}_body`],
    };
  }
  return { subject: undefined, body: undefined };
}

export const campaignJobEventEmitter = new EventEmitter();
campaignJobEventEmitter.setMaxListeners(200);

/** Process-level registry of campaign creation jobs flagged for cancellation */
export const cancelledCampaignJobIds = new Set<string>();

export function formatCampaignJobResponse(job: ICampaignImportJob) {
  const total = job.totalRows || 0;
  const processed = job.processedRows || 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 10000) / 100) : 0;
  const isExact = job.totalRowsIsExact ?? true;

  const now = Date.now();
  const lastActivity = job.heartbeatAt
    ? new Date(job.heartbeatAt).getTime()
    : job.updatedAt
    ? new Date(job.updatedAt).getTime()
    : now;
  const stallSeconds = Math.max(0, Math.round((now - lastActivity) / 1000));
  const isStalled = stallSeconds > 45 && (job.status === 'processing' || job.status === 'queued');

  let message = 'Preparing campaign...';
  if (job.status === 'completed' || job.status === 'completed_with_errors') {
    message = 'Campaign Created Successfully';
  } else if (job.status === 'cancelled') {
    message = job.errorMessage || 'Import was cancelled. Uncommitted data was removed and no emails will be sent.';
  } else if (job.status === 'cancellation_requested' || job.status === 'cancelling') {
    message = 'Cancelling import and rolling back uncommitted campaign data...';
  } else if (job.status === 'failed') {
    message = job.errorMessage || 'Campaign Creation Failed';
  } else if (isStalled) {
    message = `Import appears stalled (no progress for ${stallSeconds}s). You may safely cancel or retry.`;
  } else if (processed > 0) {
    message = `Loading recipient ${processed} of ${total}${isExact ? '' : ' (est.)'}`;
  } else if (job.phase === 'uploading') {
    message = 'Uploading recipient spreadsheet...';
  } else if (job.phase === 'preparing' || total === 0) {
    message = 'Inspecting recipient data and preparing campaign structure...';
  }

  return {
    jobId: String(job._id),
    campaignId: String(job.campaignId),
    campaignName: job.campaignName,
    fileName: job.fileName,
    status: job.status,
    phase: job.phase || job.status,
    isStalled,
    stallSeconds: isStalled ? stallSeconds : 0,
    totalRows: job.totalRows,
    totalRowsIsExact: isExact,
    processedRows: job.processedRows,
    committedRows: job.committedRows ?? job.importedCount ?? 0,
    checkpointRow: job.checkpointRow ?? 0,
    importedCount: job.importedCount,
    skippedCount: job.skippedCount,
    failedRows: job.failedRows,
    percent: pct,
    currentRow: job.currentRow,
    currentRecipientEmail: job.currentRecipientEmail,
    currentCompanyName: job.currentCompanyName,
    throughputRowsPerSecond: job.throughputRowsPerSecond ?? 0,
    estimatedTimeRemainingSeconds: job.estimatedTimeRemainingSeconds ?? 0,
    fileSizeBytes: job.fileSizeBytes ?? 0,
    uploadedBytes: job.uploadedBytes ?? 0,
    hasErrorReport: !!(job.hasErrorReport || job.failedRows > 0 || (job.rowErrors && job.rowErrors.length > 0)),
    message,
    rowErrors: job.rowErrors || [],
    errorMessage: job.errorMessage,
    heartbeatAt: job.heartbeatAt,
    cancellationRequestedAt: job.cancellationRequestedAt,
    cancelledAt: job.cancelledAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * Minimal structural view of a campaign used by the per-recipient send.
 * Keeps the shared send logic free of a hard model dependency.
 */
interface SendableCampaign {
  _id: unknown;
  organizationId: string;
  steps: Array<{ stepIndex: number; delayDays?: number }>;
  stats: { skipped: number };
  [key: string]: any;
}

interface SendableRecipient {
  _id: unknown;
  status: string;
  completedSteps: number;
  stepDrafts: Array<{
    stepIndex: number;
    draftId?: unknown;
    status: string;
    error?: string;
    sentAt?: Date;
    scheduledAt?: Date;
    providerMessageId?: string;
    providerThreadId?: string;
  }>;
  [key: string]: any;
}

export class CampaignService {
  /**
   * Starts an asynchronous campaign creation job, persisting the job in MongoDB
   * and emitting real-time per-recipient progress updates.
   */
  async startCampaignCreationJob(input: CreateCampaignInput): Promise<any> {
    const {
      organizationId,
      actorId,
      name,
      mailboxId,
      tone = 'consultative',
      generationMode = 'template',
      targetService,
      steps,
      csvContent,
      uploadId,
      columnMapping,
      customFieldMapping = {},
    } = input;

    // Check for in-flight active job for this campaign to prevent duplicate submission
    const existingActive = await CampaignImportJob.findOne({
      organizationId,
      campaignName: name.trim(),
      status: { $in: ['queued', 'processing'] },
      createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
    });
    if (existingActive) {
      return formatCampaignJobResponse(existingActive);
    }

    let storedFilePath: string;
    let fileType: 'csv' | 'xlsx';
    let totalRows: number;
    let totalRowsIsExact: boolean = true;
    let fileName: string;
    let resolvedUploadId: string | undefined = uploadId;

    if (uploadId) {
      const resolved = resolveUploadedFilePath(uploadId);
      if (!resolved) {
        throw new AppError('Uploaded file not found or expired. Please re-upload.', 400, 'FILE_NOT_FOUND');
      }
      storedFilePath = resolved.filePath;
      fileType = resolved.fileType;
      fileName = path.basename(storedFilePath);
      const inspection = await inspectSpreadsheetFile(storedFilePath, fileName, { maxPreviewRows: 1 });
      totalRows = inspection.totalRows;
      totalRowsIsExact = inspection.totalRowsIsExact;
    } else if (csvContent) {
      assertByteLimit(csvContent, env.IMPORT_MAX_FILE_BYTES);
      const temp = await writeCsvStringToTempFile(csvContent, 'upl_job_');
      storedFilePath = temp.filePath;
      fileType = 'csv';
      fileName = `${name.trim()}.csv`;
      resolvedUploadId = temp.uploadId;
      const inspection = await inspectSpreadsheetFile(storedFilePath, fileName, { maxPreviewRows: 1 });
      totalRows = inspection.totalRows;
      totalRowsIsExact = inspection.totalRowsIsExact;
    } else {
      throw new AppError('Either uploadId or csvContent must be provided', 400, 'NO_DATA_SOURCE');
    }

    assertRowLimit(totalRows, env.IMPORT_MAX_ROWS);
    if (totalRows === 0) {
      await safeUnlinkFile(storedFilePath);
      throw new AppError('No recipient data detected in the file', 400, 'EMPTY_FILE');
    }

    const campaign = await Campaign.create({
      organizationId,
      name: name.trim(),
      status: 'draft',
      mailboxId: mailboxId.toLowerCase(),
      tone,
      generationMode,
      targetService,
      steps: steps.map((s, i) => ({
        stepIndex: i,
        subject: s.subject,
        bodyText: s.bodyText,
        delayDays: s.delayDays ?? 0,
      })),
      customFieldMapping,
      columnMapping,
      createdBy: actorId,
      stats: { totalRecipients: 0, prepared: 0, sent: 0, failed: 0, skipped: 0 },
    });

    const fileStat = await fs.promises.stat(storedFilePath).catch(() => null);

    const job = await CampaignImportJob.create({
      organizationId,
      campaignId: campaign._id,
      campaignName: campaign.name,
      fileName,
      uploadId: resolvedUploadId,
      storedFilePath,
      fileType,
      status: 'queued',
      totalRows,
      totalRowsIsExact,
      processedRows: 0,
      committedRows: 0,
      checkpointRow: 0,
      importedCount: 0,
      skippedCount: 0,
      failedRows: 0,
      currentRow: 0,
      throughputRowsPerSecond: 0,
      estimatedTimeRemainingSeconds: 0,
      fileSizeBytes: fileStat?.size || 0,
      hasErrorReport: false,
    });

    campaign.importJobId = job._id as any;
    await campaign.save();

    // Attach the sender roster (multi-mailbox campaigns) before the import
    // starts so the recipients can be allocated right away.
    await this.applySenderRoster(campaign, organizationId, input.senderAccountIds);

    // Trigger async background execution
    setImmediate(() => {
      this.executeCampaignImport(job, campaign, input, storedFilePath, fileType, totalRows).catch((err) => {
        console.error(`[CampaignCreationJob] Background execution error on job ${job._id}:`, err);
      });
    });

    return formatCampaignJobResponse(job);
  }

  /**
   * Retrieves an import job by id and returns formatted progress counters.
   */
  async getCampaignCreationJob(jobId: string, organizationId: string): Promise<any> {
    const job = await CampaignImportJob.findOne({ _id: jobId, organizationId });
    if (!job) throw new AppError('Campaign creation job not found', 404, 'JOB_NOT_FOUND');
    return formatCampaignJobResponse(job);
  }

  /**
   * Checks for an active (queued/processing) campaign creation job for an organization.
   */
  async getActiveCampaignCreationJob(organizationId: string): Promise<any | null> {
    const job = await CampaignImportJob.findOne({
      organizationId,
      status: { $in: ['queued', 'processing', 'cancellation_requested', 'cancelling'] },
    }).sort({ createdAt: -1 });

    if (!job) return null;
    return formatCampaignJobResponse(job);
  }

  /**
   * Cancels an active campaign creation import job and safely cleans up partial records.
   */
  async cancelCampaignCreationJob(
    jobId: string,
    organizationId: string,
    actorId?: string
  ): Promise<any> {
    const job = await CampaignImportJob.findOne({ _id: jobId, organizationId });
    if (!job) {
      throw new AppError('Campaign creation job not found', 404, 'JOB_NOT_FOUND');
    }

    // Reject cancellation if the job already reached a terminal successful/failed state
    if (job.status === 'completed' || job.status === 'completed_with_errors') {
      throw new AppError('Cannot cancel an import that has already completed.', 409, 'JOB_ALREADY_COMPLETED');
    }
    if (job.status === 'failed') {
      throw new AppError('Cannot cancel an import that has already failed.', 409, 'JOB_ALREADY_FAILED');
    }

    // Idempotent: if already cancelled, return existing state
    if (job.status === 'cancelled') {
      return formatCampaignJobResponse(job);
    }

    // Idempotent: if cancellation is already requested/in progress, return current state
    if (job.status === 'cancellation_requested' || job.status === 'cancelling') {
      return formatCampaignJobResponse(job);
    }

    // Mark job in memory registry and DB
    cancelledCampaignJobIds.add(String(job._id));

    job.status = 'cancellation_requested';
    job.phase = 'cancellation_requested';
    job.cancellationRequestedAt = new Date();
    if (actorId) job.cancelledBy = actorId;
    await job.save();

    campaignJobEventEmitter.emit(`progress:${job._id}`, {
      jobId: String(job._id),
      campaignId: String(job.campaignId),
      campaignName: job.campaignName,
      status: 'cancellation_requested',
      phase: 'cancellation_requested',
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      committedRows: job.committedRows,
      importedCount: job.importedCount,
      skippedCount: job.skippedCount,
      failedRows: job.failedRows,
      percent: job.totalRows > 0 ? Math.round((job.processedRows / job.totalRows) * 100) : 0,
      message: 'Cancellation requested. Halting worker and rolling back partial data...',
    });

    // Execute safe rollback cleanup
    return await this.rollbackCancelledCampaignImport(String(job._id), String(job.campaignId), organizationId);
  }

  /**
   * Performs idempotent rollback of partial data created by a cancelled campaign creation job.
   */
  async rollbackCancelledCampaignImport(
    jobId: string,
    campaignId: string,
    organizationId: string
  ): Promise<any> {
    const job = await CampaignImportJob.findOne({ _id: jobId, organizationId });
    if (!job) return null;

    job.status = 'cancelling';
    job.phase = 'cancelling';
    await job.save();

    campaignJobEventEmitter.emit(`progress:${job._id}`, {
      jobId: String(job._id),
      campaignId,
      campaignName: job.campaignName,
      status: 'cancelling',
      phase: 'cancelling',
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      committedRows: job.committedRows,
      importedCount: job.importedCount,
      skippedCount: job.skippedCount,
      failedRows: job.failedRows,
      percent: job.totalRows > 0 ? Math.round((job.processedRows / job.totalRows) * 100) : 0,
      message: 'Rolling back uncommitted campaign data and partial records...',
    });

    // 1. Delete all recipient records created for this specific campaign
    await CampaignRecipient.deleteMany({ campaignId, organizationId });

    // 2. Delete any drafts and send attempts if created (preserving zero-dispatch guarantee)
    await EmailDraft.deleteMany({ campaignId, organizationId }).catch(() => {});
    await EmailSendAttempt.deleteMany({ campaignId, organizationId }).catch(() => {});

    // 3. Delete assessments created specifically by this campaign import
    await CompanyAssessment.deleteMany({
      organizationId,
      source: 'Campaign Import',
    }).catch(() => {});

    // 4. Clean up newly created contacts and companies ONLY if they are not referenced anywhere else
    const createdContactIds = (job.createdContactIds || []) as mongoose.Types.ObjectId[];
    const createdCompanyIds = (job.createdCompanyIds || []) as mongoose.Types.ObjectId[];

    if (createdContactIds.length > 0) {
      for (const contactId of createdContactIds) {
        // Check if contact is referenced in any other campaign recipient
        const referencedInOtherCampaign = await CampaignRecipient.exists({
          contactId,
          campaignId: { $ne: campaignId },
        });
        if (!referencedInOtherCampaign) {
          await CompanyContact.deleteOne({ _id: contactId, organizationId }).catch(() => {});
        }
      }
    }

    if (createdCompanyIds.length > 0) {
      for (const compId of createdCompanyIds) {
        // Check if company is referenced in any other campaign or contact
        const [otherRecipients, otherContacts] = await Promise.all([
          CampaignRecipient.exists({ companyId: compId, campaignId: { $ne: campaignId } }),
          CompanyContact.exists({ companyId: compId }),
        ]);
        if (!otherRecipients && !otherContacts) {
          await Company.deleteOne({ _id: compId, organizationId }).catch(() => {});
          await CompanyAssessment.deleteMany({ companyId: compId, organizationId }).catch(() => {});
        }
      }
    }

    // 5. Update the Campaign document: set status to 'cancelled' so scheduler never touches it
    await Campaign.updateOne(
      { _id: campaignId, organizationId },
      {
        $set: {
          status: 'cancelled',
          lastError: 'Import was cancelled by user.',
          'stats.totalRecipients': 0,
          'stats.prepared': 0,
          'stats.sent': 0,
          'stats.failed': 0,
        },
      }
    ).catch(() => {});

    // 6. Delete temporary files
    if (job.storedFilePath) {
      await safeUnlinkFile(job.storedFilePath);
    }
    if (job.uploadId) {
      await abortUploadSession(job.uploadId).catch(() => {});
    }

    // 7. Transition job to final 'cancelled' status
    job.status = 'cancelled';
    job.phase = 'cancelled';
    job.cancelledAt = new Date();
    job.finishedAt = new Date();
    job.errorMessage = 'Import cancelled by user. Partial campaign records were removed.';
    await job.save();

    campaignJobEventEmitter.emit(`progress:${job._id}`, {
      jobId: String(job._id),
      campaignId,
      campaignName: job.campaignName,
      status: 'cancelled',
      phase: 'cancelled',
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      committedRows: 0,
      importedCount: 0,
      skippedCount: job.skippedCount,
      failedRows: job.failedRows,
      percent: 0,
      message: 'Import cancelled by user. Partial campaign records were removed.',
      errorMessage: job.errorMessage,
    });

    return formatCampaignJobResponse(job);
  }

  /**
   * Recovers jobs that were interrupted by server restart or unexpected crash.
   */
  async recoverDanglingJobs(): Promise<number> {
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);
    const result = await CampaignImportJob.updateMany(
      {
        status: { $in: ['queued', 'processing'] },
        updatedAt: { $lt: staleThreshold },
      },
      {
        $set: {
          status: 'failed',
          errorMessage: 'Import process was interrupted or timed out. You may safely retry.',
          finishedAt: new Date(),
        },
      }
    );
    await cleanupStaleUploads(env.IMPORT_TEMP_TTL_HOURS).catch(() => {});
    return result.modifiedCount;
  }

  /**
   * Synchronously creates a campaign and waits for all recipients to be processed.
   * Fully backwards-compatible with existing API tests.
   */
  /**
   * Attaches a sender roster to a freshly created campaign.
   *
   * The roster is validated exactly like the "update roster" endpoint: an
   * account of another organization or an account that is not authorized to
   * send is rejected instead of being silently ignored. The legacy
   * `mailboxId` is kept in sync with the first roster entry.
   */
  private async applySenderRoster(
    campaign: any,
    organizationId: string,
    senderAccountIds?: string[]
  ): Promise<void> {
    if (!senderAccountIds || senderAccountIds.length === 0) return;

    const roster = await senderAccountService.buildRoster(
      organizationId,
      senderAccountIds.map((accountId) => ({ accountId })),
      []
    );

    campaign.senderAccounts = roster as any;
    if (roster.length > 0) campaign.mailboxId = roster[0].emailAddress;
    await campaign.save();
  }

  /**
   * Spreads the imported recipients over the campaign's sender roster.
   * Runs once the import finished so every recipient is assigned before the
   * scheduler can dispatch a message.
   */
  private async allocateRecipientsIfRostered(
    organizationId: string,
    campaignId: any,
    actorId: string
  ): Promise<void> {
    try {
      const campaign = await Campaign.findOne({ _id: campaignId, organizationId }).select('senderAccounts');
      if (!campaign || (campaign.senderAccounts || []).length === 0) return;

      await senderAllocationService.allocate(organizationId, String(campaignId), actorId);
    } catch {
      // A failed allocation must never fail the import: the user can always
      // re-run the allocation from the campaign page.
    }
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
    const {
      organizationId,
      actorId,
      name,
      mailboxId,
      tone = 'consultative',
      generationMode = 'template',
      targetService,
      steps,
      csvContent,
      uploadId,
      columnMapping,
      customFieldMapping = {},
    } = input;

    let storedFilePath: string;
    let fileType: 'csv' | 'xlsx';
    let totalRows: number;
    let totalRowsIsExact: boolean = true;
    let fileName: string;
    let resolvedUploadId: string | undefined = uploadId;

    if (uploadId) {
      const resolved = resolveUploadedFilePath(uploadId);
      if (!resolved) {
        throw new AppError('Uploaded file not found or expired. Please re-upload.', 400, 'FILE_NOT_FOUND');
      }
      storedFilePath = resolved.filePath;
      fileType = resolved.fileType;
      fileName = path.basename(storedFilePath);
      const inspection = await inspectSpreadsheetFile(storedFilePath, fileName, { maxPreviewRows: 1 });
      totalRows = inspection.totalRows;
      totalRowsIsExact = inspection.totalRowsIsExact;
    } else if (csvContent) {
      assertByteLimit(csvContent, env.IMPORT_MAX_FILE_BYTES);
      const temp = await writeCsvStringToTempFile(csvContent, 'upl_sync_');
      storedFilePath = temp.filePath;
      fileType = 'csv';
      fileName = `${name.trim()}.csv`;
      resolvedUploadId = temp.uploadId;
      const inspection = await inspectSpreadsheetFile(storedFilePath, fileName, { maxPreviewRows: 1 });
      totalRows = inspection.totalRows;
      totalRowsIsExact = inspection.totalRowsIsExact;
    } else {
      throw new AppError('Either uploadId or csvContent must be provided', 400, 'NO_DATA_SOURCE');
    }

    assertRowLimit(totalRows, env.IMPORT_MAX_ROWS);
    if (totalRows === 0) {
      await safeUnlinkFile(storedFilePath);
      throw new AppError('No recipient data detected in the file', 400, 'EMPTY_FILE');
    }

    const campaign = await Campaign.create({
      organizationId,
      name: name.trim(),
      status: 'draft',
      mailboxId: mailboxId.toLowerCase(),
      tone,
      generationMode,
      targetService,
      steps: steps.map((s, i) => ({
        stepIndex: i,
        subject: s.subject,
        bodyText: s.bodyText,
        delayDays: s.delayDays ?? 0,
      })),
      customFieldMapping,
      columnMapping,
      createdBy: actorId,
      stats: { totalRecipients: 0, prepared: 0, sent: 0, failed: 0, skipped: 0 },
    });

    const fileStat = await fs.promises.stat(storedFilePath).catch(() => null);

    const job = await CampaignImportJob.create({
      organizationId,
      campaignId: campaign._id,
      campaignName: campaign.name,
      fileName,
      uploadId: resolvedUploadId,
      storedFilePath,
      fileType,
      status: 'queued',
      totalRows,
      totalRowsIsExact,
      processedRows: 0,
      committedRows: 0,
      checkpointRow: 0,
      importedCount: 0,
      skippedCount: 0,
      failedRows: 0,
      currentRow: 0,
      throughputRowsPerSecond: 0,
      estimatedTimeRemainingSeconds: 0,
      fileSizeBytes: fileStat?.size || 0,
      hasErrorReport: false,
    });

    campaign.importJobId = job._id as any;
    await campaign.save();

    // Attach the sender roster (multi-mailbox campaigns) before the import
    // starts so the recipients can be allocated right away.
    await this.applySenderRoster(campaign, organizationId, input.senderAccountIds);

    return await this.executeCampaignImport(job, campaign, input, storedFilePath, fileType, totalRows);
  }

  /**
   * Internal streaming worker executing bounded chunk imports, targeted deduplication,
   * bulk database writes, and real-time progress events.
   */
  private async executeCampaignImport(
    job: ICampaignImportJob,
    campaign: any,
    input: CreateCampaignInput,
    storedFilePath: string,
    fileType: 'csv' | 'xlsx',
    totalRows: number
  ): Promise<CreateCampaignResult> {
    const {
      organizationId,
      name,
      steps,
      columnMapping,
      customFieldMapping = {},
      scaleType = 'standard',
    } = input;

    // Check if cancellation was already requested before worker picked up the job
    const preCheck = await CampaignImportJob.findById(job._id).select('status');
    if (
      cancelledCampaignJobIds.has(String(job._id)) ||
      (preCheck && ['cancellation_requested', 'cancelling', 'cancelled'].includes(preCheck.status))
    ) {
      await this.rollbackCancelledCampaignImport(String(job._id), String(campaign._id), organizationId);
      return {
        campaignId: campaign._id.toString(),
        importId: '',
        summary: { totalRows: 0, validRows: 0, errorRows: 0, duplicateRows: 0, recipientsCreated: 0 },
        warnings: ['Campaign import was cancelled before processing.'],
      };
    }

    try {
      job.status = 'processing';
      job.phase = 'processing';
      job.heartbeatAt = new Date();
      job.startedAt = new Date();
      await job.save();
    } catch (saveErr: any) {
      if (cancelledCampaignJobIds.has(String(job._id)) || saveErr?.name === 'DocumentNotFoundError') {
        return {
          campaignId: campaign._id.toString(),
          importId: '',
          summary: { totalRows: 0, validRows: 0, errorRows: 0, duplicateRows: 0, recipientsCreated: 0 },
          warnings: ['Campaign import was cancelled.'],
        };
      }
      throw saveErr;
    }

    // Emit initial 'Preparing campaign...' event
    campaignJobEventEmitter.emit(`progress:${job._id}`, {
      jobId: String(job._id),
      campaignId: String(campaign._id),
      campaignName: campaign.name,
      status: 'processing',
      phase: 'preparing',
      totalRows,
      processedRows: 0,
      importedCount: 0,
      skippedCount: 0,
      failedRows: 0,
      percent: 0,
      currentRow: 0,
      message: 'Preparing campaign...',
    });

    const BATCH_SIZE = Math.max(25, Math.min(env.IMPORT_BATCH_SIZE || 500, 1000));
    const duplicateSets = createDuplicateSets();
    const knownDomainToCompany = new Map<string, any>();
    const knownNameToCompany = new Map<string, any>();
    const knownEmailToContact = new Map<string, any>();
    const suppressionMap = new Map<string, string>();
    const seenCampaignEmails = new Set<string>();

    const createdCompanyIds: mongoose.Types.ObjectId[] = [];
    const createdContactIds: mongoose.Types.ObjectId[] = [];

    const checkpointRow = job.checkpointRow || 0;
    let committedRows = job.committedRows || 0;
    let effectiveTotalRows = totalRows;

    let recipientsCreated = 0;
    let skippedCount = 0;
    let failedRows = 0;
    const errors: { row: number; field: string; reason: string }[] = [];
    let currentBatch: { rowNumber: number; raw: Record<string, string> }[] = [];
    let processedRowCount = checkpointRow;

    const flushBatch = async (batch: { rowNumber: number; raw: Record<string, string> }[]) => {
      if (batch.length === 0) return;

      // Abort flush if cancellation was requested
      if (cancelledCampaignJobIds.has(String(job._id))) {
        return;
      }
      const liveStatusCheck = await CampaignImportJob.findById(job._id).select('status');
      if (liveStatusCheck && ['cancellation_requested', 'cancelling', 'cancelled'].includes(liveStatusCheck.status)) {
        cancelledCampaignJobIds.add(String(job._id));
        return;
      }

      // 1. Gather keys for targeted indexed DB queries
      const batchEmails: string[] = [];
      const batchDomains: string[] = [];
      const batchCompanyNames: string[] = [];

      for (const item of batch) {
        const emailVal = mappedValue(item.raw, columnMapping.contact_email, 'contact_email')?.toLowerCase()?.trim();
        if (emailVal) batchEmails.push(emailVal);

        let domVal = mappedValue(item.raw, columnMapping.domain, 'domain')?.toLowerCase()?.trim();
        if (!domVal) {
          const webVal = mappedValue(item.raw, columnMapping.website_url, 'website_url')?.trim();
          if (webVal) domVal = extractDomainFromUrl(webVal)?.toLowerCase() || undefined;
        }
        if (domVal) batchDomains.push(domVal);

        const compName = mappedValue(item.raw, columnMapping.company_name, 'company_name')?.trim();
        if (compName) batchCompanyNames.push(compName);
      }

      // 2. Fetch uncached items from MongoDB
      const uncachedEmails = [...new Set(batchEmails.filter((e) => !knownEmailToContact.has(e)))];
      const uncachedDomains = [...new Set(batchDomains.filter((d) => !knownDomainToCompany.has(d)))];
      const uncachedNames = [...new Set(batchCompanyNames.filter((n) => !knownNameToCompany.has(n.toLowerCase())))];

      const companyOrConditions: any[] = [];
      if (uncachedDomains.length > 0) companyOrConditions.push({ domain: { $in: uncachedDomains } });
      if (uncachedNames.length > 0) companyOrConditions.push({ name: { $in: uncachedNames } });

      const [dbCompanies, dbContacts, dbSuppressions] = await Promise.all([
        companyOrConditions.length > 0
          ? Company.find({ organizationId, isArchived: false, $or: companyOrConditions }).lean()
          : [],
        uncachedEmails.length > 0
          ? CompanyContact.find({ organizationId, email: { $in: uncachedEmails } }).lean()
          : [],
        uncachedEmails.length > 0
          ? Suppression.find({ organizationId, email: { $in: uncachedEmails } }).lean()
          : [],
      ]);

      for (const c of dbCompanies) {
        if (c.domain) knownDomainToCompany.set(c.domain.toLowerCase(), c);
        if (c.name) knownNameToCompany.set(c.name.toLowerCase(), c);
        if (c.domain) duplicateSets.existingDomains.add(c.domain.toLowerCase());
        if (c.name) duplicateSets.existingNames.add(c.name.toLowerCase());
      }
      for (const ct of dbContacts) {
        if (ct.email) {
          knownEmailToContact.set(ct.email.toLowerCase(), ct);
          duplicateSets.existingEmails.add(ct.email.toLowerCase());
        }
      }
      for (const s of dbSuppressions) {
        if (s.email) suppressionMap.set(s.email.toLowerCase(), s.reason || 'unsubscribed');
      }

      // 3. Process each row in the batch
      const recipientDocsToInsert: any[] = [];
      const assessmentDocsToInsert: any[] = [];

      for (const item of batch) {
        processedRowCount++;
        const parsedRow = normalizeParsedRow(
          item.raw,
          item.rowNumber,
          columnMapping as unknown as ColumnMapping,
          duplicateSets,
          scaleType
        );
        const { cleaned } = parsedRow;

        const rawCustom: Record<string, unknown> = {};
        if (cleaned.step_1_subject) rawCustom['step_1_subject'] = cleaned.step_1_subject;
        if (cleaned.step_1_body) rawCustom['step_1_body'] = cleaned.step_1_body;
        if (cleaned.step_2_subject) rawCustom['step_2_subject'] = cleaned.step_2_subject;
        if (cleaned.step_2_body) rawCustom['step_2_body'] = cleaned.step_2_body;
        if (cleaned.step_3_subject) rawCustom['step_3_subject'] = cleaned.step_3_subject;
        if (cleaned.step_3_body) rawCustom['step_3_body'] = cleaned.step_3_body;
        if (cleaned.sector) rawCustom['sector'] = cleaned.sector;
        if (cleaned.state_roc) rawCustom['state_roc'] = cleaned.state_roc;
        if (cleaned.proposed_deliverable) rawCustom['proposed_deliverable'] = cleaned.proposed_deliverable;
        if (cleaned.primary_tech_signal) rawCustom['primary_tech_signal'] = cleaned.primary_tech_signal;
        if (cleaned.authorized_capital) rawCustom['authorized_capital'] = cleaned.authorized_capital;
        if (cleaned.contact_confidence) rawCustom['contact_confidence'] = cleaned.contact_confidence;
        if (cleaned.direct_phone) rawCustom['direct_phone'] = cleaned.direct_phone;
        if (cleaned.director_full_name) rawCustom['director_full_name'] = cleaned.director_full_name;
        if (cleaned.website_status) rawCustom['website_status'] = cleaned.website_status;
        if (cleaned.site_audit_type) rawCustom['site_audit_type'] = cleaned.site_audit_type;
        if (cleaned.http_code) rawCustom['http_code'] = cleaned.http_code;
        if (cleaned.page_title) rawCustom['page_title'] = cleaned.page_title;
        if (cleaned.domain) rawCustom['domain'] = cleaned.domain;

        for (const [sourceHeader, targetKey] of Object.entries(customFieldMapping)) {
          if (sourceHeader in parsedRow.raw && parsedRow.raw[sourceHeader]) {
            rawCustom[targetKey] = parsedRow.raw[sourceHeader];
          }
        }
        const { customFields, truncatedKeys } = boundCustomFields(rawCustom);
        const truncatedCopyKeys = truncatedKeys.filter((key) => STEP_COPY_FIELD_KEYS.has(key));
        if (truncatedCopyKeys.length > 0) {
          parsedRow.errors.push({
            field: 'step_body',
            reason: `Imported copy for ${truncatedCopyKeys.join(', ')} exceeds the maximum supported length of ${MAX_TEMPLATE_LENGTH} characters. The row was skipped so a partial email is never generated or sent.`,
          });
        }

        const contactEmail = cleaned.contact_email?.trim().toLowerCase();
        const companyName = cleaned.company_name;

        const lastRecipientEmail = contactEmail || parsedRow.cleaned?.contact_email || undefined;
        const lastCompanyName = companyName || parsedRow.cleaned?.company_name || undefined;
        job.currentRecipientEmail = lastRecipientEmail;
        job.currentCompanyName = lastCompanyName;

        // Check 1: Row errors
        if (parsedRow.errors.length > 0) {
          const errorMsg = parsedRow.errors.map((e) => e.reason).join('; ');
          for (const err of parsedRow.errors) {
            appendRowErrorToDisk(String(job._id), { row: parsedRow.rowNumber, field: err.field, reason: err.reason }).catch(() => {});
          }
          if (errors.length < env.IMPORT_ERROR_SAMPLE_LIMIT) {
            errors.push(...parsedRow.errors.map((e) => ({ row: parsedRow.rowNumber, ...e })));
          }

          recipientDocsToInsert.push({
            organizationId,
            campaignId: campaign._id,
            rowNumber: parsedRow.rowNumber,
            email: parsedRow.cleaned?.contact_email || `unspecified-row${parsedRow.rowNumber}@invalid.local`,
            name:
              [parsedRow.cleaned?.contact_first_name, parsedRow.cleaned?.contact_last_name].filter(Boolean).join(' ') ||
              undefined,
            companyName: parsedRow.cleaned?.company_name || '(Missing company name)',
            customFields,
            status: 'skipped',
            skipReason: errorMsg,
            canRetry: true,
            lastError: errorMsg,
            completedSteps: 0,
            stepDrafts: steps.map((_s, i) => ({ stepIndex: i, status: 'skipped' as const, error: errorMsg })),
          });
          skippedCount++;
        } else if (!contactEmail) {
          // Check 2: Missing contact email
          const skipReason = 'Recipient contact email is missing';
          appendRowErrorToDisk(String(job._id), { row: parsedRow.rowNumber, field: 'contact_email', reason: skipReason }).catch(() => {});
          if (errors.length < env.IMPORT_ERROR_SAMPLE_LIMIT) {
            errors.push({ row: parsedRow.rowNumber, field: 'contact_email', reason: skipReason });
          }

          recipientDocsToInsert.push({
            organizationId,
            campaignId: campaign._id,
            rowNumber: parsedRow.rowNumber,
            email: `missing-email-row${parsedRow.rowNumber}@invalid.local`,
            name: [cleaned.contact_first_name, cleaned.contact_last_name].filter(Boolean).join(' ') || undefined,
            companyName: cleaned.company_name || '(Missing company name)',
            customFields,
            status: 'skipped',
            skipReason,
            canRetry: true,
            lastError: skipReason,
            completedSteps: 0,
            stepDrafts: steps.map((_s, i) => ({ stepIndex: i, status: 'skipped' as const, error: skipReason })),
          });
          skippedCount++;
        } else if (seenCampaignEmails.has(contactEmail)) {
          // Check 3: Duplicate recipient email within this campaign
          const skipReason = `Duplicate recipient email '${contactEmail}' within this campaign`;
          recipientDocsToInsert.push({
            organizationId,
            campaignId: campaign._id,
            rowNumber: parsedRow.rowNumber,
            email: contactEmail,
            name: [cleaned.contact_first_name, cleaned.contact_last_name].filter(Boolean).join(' ') || undefined,
            companyName: cleaned.company_name,
            customFields,
            status: 'skipped',
            skipReason,
            canRetry: false,
            lastError: skipReason,
            completedSteps: 0,
            stepDrafts: steps.map((_s, i) => ({ stepIndex: i, status: 'skipped' as const, error: skipReason })),
          });
          skippedCount++;
        } else if (suppressionMap.has(contactEmail)) {
          // Check 4: Recipient suppression verification
          seenCampaignEmails.add(contactEmail);
          const suppressionReason = suppressionMap.get(contactEmail);
          const skipReason = `Recipient '${contactEmail}' is on the suppression list (${suppressionReason})`;
          recipientDocsToInsert.push({
            organizationId,
            campaignId: campaign._id,
            rowNumber: parsedRow.rowNumber,
            email: contactEmail,
            name: [cleaned.contact_first_name, cleaned.contact_last_name].filter(Boolean).join(' ') || undefined,
            companyName: cleaned.company_name,
            customFields,
            status: 'suppressed',
            skipReason,
            canRetry: false,
            lastError: skipReason,
            completedSteps: 0,
            stepDrafts: steps.map((_s, i) => ({ stepIndex: i, status: 'skipped' as const, error: skipReason })),
          });
          skippedCount++;
        } else {
          // Eligible recipient: link/create CRM Company & Contact
          seenCampaignEmails.add(contactEmail);
          try {
            let company =
              (cleaned.domain ? knownDomainToCompany.get(cleaned.domain.toLowerCase()) : null) ||
              knownNameToCompany.get(cleaned.company_name.toLowerCase());

            if (!company) {
              company = await Company.create({
                organizationId,
                name: cleaned.company_name,
                domain: cleaned.domain || undefined,
                websiteUrl: cleaned.website_url || undefined,
                industry: cleaned.industry || undefined,
                city: cleaned.city || undefined,
                country: cleaned.country || undefined,
                overallRating: cleaned.rating || 'unrated',
                rawRating: cleaned.raw_rating || undefined,
                notes: cleaned.notes || undefined,
                services: cleaned.services || [],
                customFields,
              });
              createdCompanyIds.push(company._id);
              if (cleaned.domain) knownDomainToCompany.set(cleaned.domain.toLowerCase(), company);
              knownNameToCompany.set(cleaned.company_name.toLowerCase(), company);
            }

            let contact = knownEmailToContact.get(contactEmail);
            if (!contact) {
              contact = await CompanyContact.create({
                organizationId,
                companyId: company._id,
                firstName: cleaned.contact_first_name || undefined,
                lastName: cleaned.contact_last_name || undefined,
                fullName: [cleaned.contact_first_name, cleaned.contact_last_name].filter(Boolean).join(' ') || undefined,
                email: contactEmail,
                phone: cleaned.contact_phone || undefined,
                isPrimary: true,
              });
              createdContactIds.push(contact._id);
              knownEmailToContact.set(contactEmail, contact);
            }

            if (cleaned.rating && cleaned.rating !== 'unrated') {
              assessmentDocsToInsert.push({
                organizationId,
                companyId: company._id,
                normalizedRating: cleaned.rating,
                scaleUsed: 'csv_import',
                source: 'Campaign Import',
                notes: cleaned.notes || undefined,
              });
            }

            recipientDocsToInsert.push({
              organizationId,
              campaignId: campaign._id,
              rowNumber: parsedRow.rowNumber,
              companyId: company._id,
              contactId: contact._id,
              email: contactEmail,
              name: [cleaned.contact_first_name, cleaned.contact_last_name].filter(Boolean).join(' ') || undefined,
              companyName: cleaned.company_name,
              customFields,
              status: 'pending',
              completedSteps: 0,
              stepDrafts: steps.map((_s, i) => ({ stepIndex: i, status: 'pending' as const })),
            });

            recipientsCreated++;
          } catch (insertErr: any) {
            failedRows++;
            appendRowErrorToDisk(String(job._id), {
              row: parsedRow.rowNumber,
              field: 'db_insert',
              reason: insertErr.message || 'Database error',
            }).catch(() => {});
            if (errors.length < env.IMPORT_ERROR_SAMPLE_LIMIT) {
              errors.push({
                row: parsedRow.rowNumber,
                field: 'db_insert',
                reason: insertErr.message || 'Database error',
              });
            }
          }
        }

        // Live progress event emission with rolling throughput and ETA
        const startTime = job.startedAt ? job.startedAt.getTime() : Date.now();
        const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
        const throughput = Math.round(processedRowCount / elapsedSec);
        const remaining = Math.max(0, effectiveTotalRows - processedRowCount);
        const etaSeconds = throughput > 0 ? Math.ceil(remaining / throughput) : 0;

        const shouldEmit =
          effectiveTotalRows <= 200 ||
          processedRowCount <= 10 ||
          processedRowCount % 25 === 0 ||
          processedRowCount === effectiveTotalRows;

        if (shouldEmit) {
          const pct = Math.min(100, Math.round((processedRowCount / effectiveTotalRows) * 10000) / 100);
          campaignJobEventEmitter.emit(`progress:${job._id}`, {
            jobId: String(job._id),
            campaignId: String(campaign._id),
            campaignName: campaign.name,
            status: 'processing',
            totalRows: effectiveTotalRows,
            totalRowsIsExact: job.totalRowsIsExact ?? true,
            processedRows: processedRowCount,
            committedRows,
            checkpointRow: item.rowNumber,
            importedCount: recipientsCreated,
            skippedCount,
            failedRows,
            percent: pct,
            currentRow: processedRowCount,
            currentRecipientEmail: lastRecipientEmail,
            currentCompanyName: lastCompanyName,
            throughputRowsPerSecond: throughput,
            estimatedTimeRemainingSeconds: etaSeconds,
            hasErrorReport: errors.length > 0 || failedRows > 0,
            message: `Loading recipient ${processedRowCount} of ${effectiveTotalRows}${job.totalRowsIsExact ? '' : ' (est.)'}`,
          });
        }
      }

      // Bulk insert assessments and recipients for the batch
      if (assessmentDocsToInsert.length > 0) {
        await CompanyAssessment.insertMany(assessmentDocsToInsert, { ordered: false }).catch(() => {});
      }
      if (recipientDocsToInsert.length > 0) {
        await CampaignRecipient.insertMany(recipientDocsToInsert, { ordered: false });
        committedRows += recipientDocsToInsert.length;
      }

      const startTime = job.startedAt ? job.startedAt.getTime() : Date.now();
      const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
      const throughput = Math.round(processedRowCount / elapsedSec);
      const remaining = Math.max(0, effectiveTotalRows - processedRowCount);
      const etaSeconds = throughput > 0 ? Math.ceil(remaining / throughput) : 0;
      const now = new Date();

      // Atomically update progress in MongoDB
      job.processedRows = processedRowCount;
      job.currentRow = processedRowCount;
      job.committedRows = committedRows;
      job.checkpointRow = batch[batch.length - 1].rowNumber;
      job.importedCount = recipientsCreated;
      job.skippedCount = skippedCount;
      job.failedRows = failedRows;
      job.throughputRowsPerSecond = throughput;
      job.estimatedTimeRemainingSeconds = etaSeconds;
      job.heartbeatAt = now;
      job.phase = 'processing';
      job.createdCompanyIds = createdCompanyIds;
      job.createdContactIds = createdContactIds;

      await CampaignImportJob.updateOne(
        { _id: job._id },
        {
          $set: {
            processedRows: processedRowCount,
            currentRow: processedRowCount,
            committedRows,
            checkpointRow: job.checkpointRow,
            importedCount: recipientsCreated,
            skippedCount,
            failedRows,
            throughputRowsPerSecond: throughput,
            estimatedTimeRemainingSeconds: etaSeconds,
            currentRecipientEmail: job.currentRecipientEmail,
            currentCompanyName: job.currentCompanyName,
            heartbeatAt: now,
            phase: 'processing',
            createdCompanyIds,
            createdContactIds,
          },
        }
      );

      // Yield event loop
      await new Promise((r) => setImmediate(r));
    };

    try {
      let isCancelled = false;
      const stream = createSpreadsheetRowStream(storedFilePath, fileType, { highWaterMark: BATCH_SIZE });
      for await (const rowItem of stream.rows) {
        if (cancelledCampaignJobIds.has(String(job._id))) {
          isCancelled = true;
          break;
        }
        if (rowItem.rowNumber <= checkpointRow) {
          continue;
        }
        currentBatch.push(rowItem);
        if (currentBatch.length >= BATCH_SIZE) {
          await flushBatch(currentBatch);
          currentBatch = [];
          if (cancelledCampaignJobIds.has(String(job._id))) {
            isCancelled = true;
            break;
          }
        }
      }

      if (!isCancelled && currentBatch.length > 0) {
        await flushBatch(currentBatch);
        currentBatch = [];
      }

      // If cancellation was signalled, run rollback and exit immediately
      if (isCancelled || cancelledCampaignJobIds.has(String(job._id))) {
        await this.rollbackCancelledCampaignImport(String(job._id), String(campaign._id), organizationId);
        return {
          campaignId: campaign._id.toString(),
          importId: '',
          summary: { totalRows: 0, validRows: 0, errorRows: 0, duplicateRows: 0, recipientsCreated: 0 },
          warnings: ['Campaign creation import was cancelled.'],
        };
      }

      const finalTotalRows = job.totalRowsIsExact ? totalRows : processedRowCount;
      const totalRecipients = recipientsCreated + skippedCount;
      const errorReportPath =
        errors.length > 0 || failedRows > 0 ? getJobErrorReportPath(String(job._id)) || undefined : undefined;
      const hasErrorReport = Boolean(errorReportPath);

      const importLog = await CSVImport.create({
        organizationId,
        fileName: `${name}.csv`,
        totalRows: finalTotalRows,
        validRows: recipientsCreated,
        errorRows: errors.length,
        duplicateRows: duplicateSets.inFileEmails.size + duplicateSets.existingEmails.size,
        importedCount: recipientsCreated,
        status: errors.length > 0 && recipientsCreated === 0 ? 'failed' : 'completed',
        rowErrors: errors,
        mapping: { ...columnMapping, custom: customFieldMapping },
      });

      await Campaign.updateOne(
        { _id: campaign._id },
        {
          $set: {
            importId: importLog._id,
            importJobId: job._id,
            'stats.totalRecipients': totalRecipients,
            'stats.skipped': skippedCount,
            'stats.prepared': 0,
            'stats.sent': 0,
            'stats.failed': failedRows,
          },
        }
      ).catch(() => {});

      const finalStatus =
        errors.length > 0 && recipientsCreated === 0
          ? 'failed'
          : errors.length > 0
          ? 'completed_with_errors'
          : 'completed';

      job.status = finalStatus;
      job.totalRows = finalTotalRows;
      job.totalRowsIsExact = true;
      job.processedRows = finalTotalRows;
      job.committedRows = committedRows;
      job.checkpointRow = finalTotalRows;
      job.importedCount = recipientsCreated;
      job.skippedCount = skippedCount;
      job.failedRows = failedRows;
      job.finishedAt = new Date();
      job.rowErrors = errors;
      job.hasErrorReport = hasErrorReport;
      job.errorReportPath = errorReportPath;
      await CampaignImportJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: finalStatus,
            totalRows: finalTotalRows,
            totalRowsIsExact: true,
            processedRows: finalTotalRows,
            committedRows,
            checkpointRow: finalTotalRows,
            importedCount: recipientsCreated,
            skippedCount,
            failedRows,
            finishedAt: job.finishedAt,
            rowErrors: errors,
            hasErrorReport,
            errorReportPath,
          },
        }
      );

      campaignJobEventEmitter.emit(`progress:${job._id}`, {
        jobId: String(job._id),
        campaignId: String(campaign._id),
        campaignName: campaign.name,
        status: finalStatus,
        totalRows: finalTotalRows,
        totalRowsIsExact: true,
        processedRows: finalTotalRows,
        committedRows,
        checkpointRow: finalTotalRows,
        importedCount: recipientsCreated,
        skippedCount,
        failedRows,
        percent: 100,
        currentRow: finalTotalRows,
        message: 'Campaign Created Successfully',
        rowErrors: errors,
        hasErrorReport,
        throughputRowsPerSecond: 0,
        estimatedTimeRemainingSeconds: 0,
      });

      // Cleanup stored temporary file
      await safeUnlinkFile(storedFilePath);

      // Spread the imported recipients over the sender roster (multi-mailbox
      // campaigns). Runs after the import so every recipient exists.
      await this.allocateRecipientsIfRostered(organizationId, campaign._id, input.actorId);

      return {
        campaignId: campaign._id.toString(),
        importId: importLog._id.toString(),
        summary: {
          totalRows: finalTotalRows,
          validRows: recipientsCreated,
          errorRows: errors.length,
          duplicateRows: skippedCount,
          recipientsCreated,
        },
        warnings: errors.length ? ['Some rows were skipped. Review the recipients table or import log for details.'] : [],
      };
    } catch (err: any) {
      // Check if failure was caused by cancellation or if cancellation was requested
      const currentJobStatus = job.status as string;
      if (
        cancelledCampaignJobIds.has(String(job._id)) ||
        currentJobStatus === 'cancellation_requested' ||
        currentJobStatus === 'cancelling' ||
        currentJobStatus === 'cancelled' ||
        err?.name === 'DocumentNotFoundError'
      ) {
        await this.rollbackCancelledCampaignImport(String(job._id), String(campaign._id), organizationId);
        return {
          campaignId: campaign._id.toString(),
          importId: '',
          summary: { totalRows: 0, validRows: 0, errorRows: 0, duplicateRows: 0, recipientsCreated: 0 },
          warnings: ['Campaign creation import was cancelled.'],
        };
      }

      // Cleanup stored temporary file
      await safeUnlinkFile(storedFilePath);

      job.status = 'failed';
      job.errorMessage = err.message || 'Campaign creation failed';
      job.finishedAt = new Date();
      await CampaignImportJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'failed',
            errorMessage: job.errorMessage,
            finishedAt: job.finishedAt,
          },
        }
      ).catch(() => {});

      campaignJobEventEmitter.emit(`progress:${job._id}`, {
        jobId: String(job._id),
        campaignId: String(campaign._id),
        campaignName: campaign.name,
        status: 'failed',
        totalRows,
        processedRows: job.processedRows,
        importedCount: job.importedCount,
        skippedCount: job.skippedCount,
        failedRows: job.failedRows,
        percent: 0,
        currentRow: job.currentRow,
        message: err.message || 'Campaign creation failed',
        errorMessage: err.message,
      });

      throw err;
    }
  }

  /** Generates personalized EmailDraft documents for a bounded batch of recipients. */
  async generateDraftsBatch(
    organizationId: string,
    campaignId: string,
    batchSize: number | undefined,
    senderName?: string
  ): Promise<BatchResult> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');
    if (campaign.steps.length === 0) throw new AppError('Campaign has no email steps', 400, 'NO_STEPS');

    const limit = clampBatch(batchSize);
    const senderSettings = await WorkspaceSettings.findOne({ organizationId }).lean();
    const recipients = await CampaignRecipient.find({
      organizationId,
      campaignId: campaign._id,
      status: { $in: ['pending', 'prepared', 'approved'] },
      $or: [
        { 'stepDrafts.draftId': { $exists: false } },
        { stepDrafts: { $size: 0 } },
        { 'stepDrafts.status': { $in: ['pending', 'failed'] } },
      ],
    })
      .sort({ rowNumber: 1 })
      .limit(limit);

    let processed = 0;

    const useAi = campaign.generationMode === 'ai';
    const effectiveSender = senderName || senderSettings?.senderDisplayName || 'Vansh Aggarwal';

    for (const recipient of recipients) {
      let customObj: Record<string, string> =
        recipient.customFields instanceof Map
          ? Object.fromEntries(recipient.customFields)
          : (recipient.customFields as any) || {};

      // If recipient customFields is missing or sparse, hydrate from Company.customFields
      if (recipient.companyId && (!customObj['step_1_subject'] || Object.keys(customObj).length < 5)) {
        const comp = await Company.findById(recipient.companyId).lean();
        if (comp && comp.customFields) {
          customObj = { ...comp.customFields, ...customObj };
          recipient.customFields = customObj;
        }
      }

      const values = buildInterpolationValues({
        companyName: recipient.companyName,
        contactName: recipient.name,
        email: recipient.email,
        domain: customObj['domain'],
        sector: customObj['sector'],
        proposedDeliverable: customObj['proposed_deliverable'],
        senderName: effectiveSender,
        senderBusiness: senderSettings?.businessName || 'Swaniki New Business Radar',
        signOff: senderSettings?.defaultSignOff || 'Best regards,',
        signature: senderSettings?.emailSignature || effectiveSender,
        contactDetails: senderSettings?.contactDetails || '',
        greetingFormat: senderSettings?.defaultGreeting,
        missingNameFallback: senderSettings?.missingNameFallback || 'Hello,',
        customFields: customObj,
      });

      const hasZeroIndex = campaign.steps.some((s) => s.stepIndex === 0);
      for (const step of campaign.steps) {
        let slot = recipient.stepDrafts.find((d) => d.stepIndex === step.stepIndex);
        if (!slot) {
          slot = { stepIndex: step.stepIndex, status: 'pending' };
          recipient.stepDrafts.push(slot);
        }

        if (slot.draftId) {
          const existing = await EmailDraft.findById(slot.draftId);
          if (existing) continue; // Already generated
        }

        const stepNum = hasZeroIndex ? step.stepIndex + 1 : step.stepIndex;
        const { subject: importedSubject, body: importedBody } = getImportedStepCopy(
          customObj,
          step.stepIndex,
          hasZeroIndex
        );

        let draft;
        if (useAi) {
          draft = await this.createAiStepDraft(campaign, recipient, step, effectiveSender);
        } else {
          let templateSubject = step.subject || '';
          let templateBody = step.bodyText || '';

          if (importedSubject && importedSubject.trim().length > 0) {
            if (
              !templateSubject ||
              templateSubject.includes(`step_${stepNum}_subject`) ||
              templateSubject.includes(`step_${step.stepIndex}_subject`)
            ) {
              templateSubject = importedSubject;
            }
          }
          if (importedBody && importedBody.trim().length > 0) {
            if (
              !templateBody ||
              templateBody.includes(`step_${stepNum}_body`) ||
              templateBody.includes(`step_${step.stepIndex}_body`)
            ) {
              templateBody = importedBody;
            }
          }

          const subjectResult = interpolateTemplate(templateSubject, values);
          const bodyResult = interpolateTemplate(templateBody, values);

          const finalSubject =
            sanitizeHeaderValue(subjectResult.output) ||
            (importedSubject ? sanitizeHeaderValue(importedSubject) : `Outreach for ${recipient.companyName || recipient.email}`);
          const finalBody = bodyResult.output || (importedBody ? importedBody : '');

          if (!finalSubject.trim() || !finalBody.trim()) {
            slot.status = 'failed';
            slot.error = `Step ${stepNum} requires a subject and body. CSV copy was missing and step template was blank.`;
            recipient.lastError = slot.error;
            continue;
          }

          const missing = [...new Set([...subjectResult.missingTokens, ...bodyResult.missingTokens])];
          const validation = validateEmailCopy({
            subject: finalSubject,
            bodyText: finalBody,
            companyName: recipient.companyName,
            recipientName: recipient.name,
            recipientEmail: recipient.email,
            proposedDeliverable: customObj['proposed_deliverable'],
            domain: customObj['domain'],
            sector: customObj['sector'],
            websiteStatus: customObj['website_status'],
            httpCode: customObj['http_code'],
            customFields: customObj,
          });

          const warnings: string[] = [...validation.warnings];
          if (missing.length) warnings.push('Some merge fields were empty for this recipient.');
          const claimKeywords = /\b(guarantee|guaranteed|100%|free trial|zero risk|exclusive partnership)\b/i;
          if (claimKeywords.test(finalBody) && !warnings.some((w) => w.includes('promotional claims'))) {
            warnings.push('Imported email copy contains assertive promotional claims. Review before approval.');
          }

          draft = await EmailDraft.create({
            organizationId,
            campaignId: campaign._id,
            recipientId: recipient._id,
            stepIndex: step.stepIndex,
            companyId: recipient.companyId,
            companyName: recipient.companyName,
            contactId: recipient.contactId,
            recipientEmail: recipient.email,
            recipientName: recipient.name,
            subject: finalSubject,
            bodyText: finalBody,
            tone: campaign.tone,
            status: 'draft',
            originalSubject: importedSubject || undefined,
            originalBodyText: importedBody || undefined,
            isManualEdit: false,
            generationSource: 'personalized_template',
            factsUsed: bodyResult.usedTokens.map((t) => `CSV column: ${t}`),
            missingInformation: missing,
            warnings,
            companyNameMismatch: validation.companyNameMismatch || undefined,
            unsupportedClaims: validation.unsupportedClaims,
          });
        }

        slot.draftId = draft._id as any;
        slot.status = 'draft';
        slot.error = undefined;
      }

      const allDraftsGenerated =
        campaign.steps.length > 0 &&
        campaign.steps.every((st) => {
          const sl = recipient.stepDrafts.find((d) => d.stepIndex === st.stepIndex);
          return sl && sl.draftId;
        });
      const allApproved =
        allDraftsGenerated &&
        recipient.stepDrafts.every((s) => s.status === 'approved');

      recipient.status = allApproved ? 'approved' : allDraftsGenerated ? 'prepared' : 'pending';
      recipient.lastError = undefined;
      await recipient.save();
      processed++;
    }

    const [preparedCount, pendingCount] = await Promise.all([
      CampaignRecipient.countDocuments({
        organizationId,
        campaignId: campaign._id,
        status: { $in: ['prepared', 'approved'] },
      }),
      CampaignRecipient.countDocuments({
        organizationId,
        campaignId: campaign._id,
        status: { $in: ['pending', 'prepared', 'approved'] },
        $or: [
          { 'stepDrafts.draftId': { $exists: false } },
          { stepDrafts: { $size: 0 } },
          { 'stepDrafts.status': { $in: ['pending', 'failed'] } },
        ],
      }),
    ]);

    campaign.stats.prepared = preparedCount;
    campaign.status = 'ready_for_review';
    if (recipients.length) campaign.generationCursor = recipients[recipients.length - 1].rowNumber;
    await campaign.save();

    return {
      processed,
      remaining: pendingCount,
      status: campaign.status,
      stats: this.publicStats(campaign),
    };
  }

  /**
   * Generates one AI-personalized step draft for a recipient. Falls back to the
   * deterministic engine automatically inside AiGroundingService on failure.
   */
  private async createAiStepDraft(
    campaign: any,
    recipient: any,
    step: { stepIndex: number },
    senderName?: string
  ) {
    const customFields: Record<string, string> =
      recipient.customFields instanceof Map
        ? Object.fromEntries(recipient.customFields)
        : (recipient.customFields as any) || {};

    const hasZeroIndex = campaign.steps?.some((s: any) => s.stepIndex === 0) ?? true;
    const { subject: importedSubject, body: importedBody } = getImportedStepCopy(
      customFields,
      step.stepIndex,
      hasZeroIndex
    );

    const aiResult = await aiGroundingService.generateEmailDraft({
      companyName: recipient.companyName || recipient.email,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      targetService: resolveTargetService(campaign.targetService, customFields),
      tone: coerceTone(campaign.tone),
      objective:
        campaign.steps.length > 1
          ? `This is follow-up step ${step.stepIndex + 1} of ${campaign.steps.length}.`
          : undefined,
      explicitNeeds: extractDeclaredNeeds(customFields),
      customFieldContext: customFields,
      senderName,
    });

    const aiSubject =
      sanitizeHeaderValue(aiResult.output.subject) || `Outreach for ${recipient.companyName || recipient.email}`;
    const aiBody = aiResult.output.bodyText || '';

    const validation = validateEmailCopy({
      subject: aiSubject,
      bodyText: aiBody,
      companyName: recipient.companyName,
      recipientName: recipient.name,
      recipientEmail: recipient.email,
      proposedDeliverable: customFields['proposed_deliverable'],
      domain: customFields['domain'],
      sector: customFields['sector'],
      websiteStatus: customFields['website_status'],
      httpCode: customFields['http_code'],
      customFields,
    });

    const aiWarnings = [...(aiResult.output.warnings || []), ...validation.warnings];

    return EmailDraft.create({
      organizationId: campaign.organizationId,
      campaignId: campaign._id,
      recipientId: recipient._id,
      stepIndex: step.stepIndex,
      companyId: recipient.companyId,
      companyName: recipient.companyName,
      contactId: recipient.contactId,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      subject: aiSubject,
      bodyText: aiBody,
      tone: campaign.tone,
      status: 'draft',
      originalSubject: importedSubject || undefined,
      originalBodyText: importedBody || undefined,
      isManualEdit: false,
      generationSource: aiResult.isFallback ? 'personalized_template' : 'ai_grounded',
      recommendedServiceName: aiResult.output.recommendedService,
      recommendationExplanation: aiResult.output.explanation,
      factsUsed: aiResult.output.factsUsed,
      missingInformation: aiResult.output.missingInformation,
      warnings: aiWarnings,
      companyNameMismatch: validation.companyNameMismatch || undefined,
      unsupportedClaims: validation.unsupportedClaims,
      estimatedCostUsd: aiResult.costUsd,
      isFallbackTemplate: aiResult.isFallback,
    });
  }

  /** Approves generated drafts (all recipients, or a subset) so they may be sent. */
  async approveRecipients(
    organizationId: string,
    campaignId: string,
    recipientIds?: string[]
  ): Promise<{ approved: number; excluded: number; reasons: string[] }> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const query: any = { organizationId, campaignId: campaign._id };
    if (recipientIds && recipientIds.length) {
      query._id = { $in: recipientIds };
    } else {
      query.status = { $in: ['prepared', 'pending', 'approved'] };
    }

    const recipients = await CampaignRecipient.find(query);
    let approved = 0;
    let excluded = 0;
    const reasons: string[] = [];

    for (const recipient of recipients) {
      const validSlots = recipient.stepDrafts.filter((s) => !!s.draftId);
      if (validSlots.length === 0) {
        excluded++;
        reasons.push(`${recipient.email}: No drafts generated yet. Generate drafts before approving.`);
        recipient.status = 'pending'; // Ensure not falsely approved without drafts
        await recipient.save();
        continue;
      }

      // Check for blocking company name mismatches that strictly require individual review
      const draftDocs = await EmailDraft.find({
        _id: { $in: validSlots.map((s) => s.draftId) },
        organizationId,
      });
      const blockingDraft = draftDocs.find((d) => Boolean(d.companyNameMismatch));
      if (blockingDraft && (!recipientIds || recipientIds.length > 1)) {
        excluded++;
        reasons.push(
          `${recipient.email}: Contains company name mismatch ("${blockingDraft.companyNameMismatch}"). Individual review required before approval.`
        );
        recipient.status = 'prepared';
        await recipient.save();
        continue;
      }

      for (const slot of validSlots) {
        await EmailDraft.updateOne(
          { _id: slot.draftId, organizationId, campaignId: campaign._id },
          { $set: { status: 'approved' } }
        );
        slot.status = 'approved';
      }

      recipient.status = 'approved';
      await recipient.save();
      approved++;
    }

    if (approved === 0) {
      const msg = reasons.length
        ? `No drafts could be approved. ${reasons[0]}`
        : 'No generated drafts found in this campaign. Please click "Generate drafts" first before approving.';
      throw new AppError(msg, 400, 'NO_DRAFTS_TO_APPROVE');
    }

    return { approved, excluded, reasons };
  }

  /** Edits a single step draft for a recipient prior to send. */
  async editStepDraft(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    stepIndex: number,
    subject: string,
    bodyText: string
  ): Promise<{ updated: boolean; recipient?: any }> {
    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    const slot = recipient.stepDrafts.find((d) => d.stepIndex === stepIndex);
    if (!slot || !slot.draftId) throw new AppError('Step draft not generated yet', 404, 'DRAFT_NOT_FOUND');
    if (slot.status === 'sent') throw new AppError('Cannot edit an already-sent step', 400, 'STEP_ALREADY_SENT');

    const customObj: Record<string, string> =
      recipient.customFields instanceof Map
        ? Object.fromEntries(recipient.customFields)
        : (recipient.customFields as any) || {};

    const validation = validateEmailCopy({
      subject,
      bodyText,
      companyName: recipient.companyName,
      recipientName: recipient.name,
      recipientEmail: recipient.email,
      proposedDeliverable: customObj['proposed_deliverable'],
      domain: customObj['domain'],
      sector: customObj['sector'],
      websiteStatus: customObj['website_status'],
      httpCode: customObj['http_code'],
      customFields: customObj,
    });

    await EmailDraft.updateOne(
      { _id: slot.draftId, organizationId },
      {
        $set: {
          subject: sanitizeHeaderValue(subject),
          bodyText,
          isManualEdit: true,
          generationSource: 'manual_edit',
          warnings: validation.warnings,
          unsupportedClaims: validation.unsupportedClaims,
          companyNameMismatch: validation.companyNameMismatch || undefined,
        },
      }
    );

    const enriched = await this.getEnrichedRecipient(organizationId, campaignId, recipientId);
    return { updated: true, recipient: enriched };
  }

  /** Repairs unsupported factual claims in a draft using verified company data and neutral wording. */
  async repairStepDraft(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    stepIndex: number
  ): Promise<{ repaired: boolean; recipient?: any }> {
    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    const slot = recipient.stepDrafts.find((d) => d.stepIndex === stepIndex);
    if (!slot || !slot.draftId) throw new AppError('Step draft not generated yet', 404, 'DRAFT_NOT_FOUND');
    if (slot.status === 'sent') throw new AppError('Cannot repair an already-sent step', 400, 'STEP_ALREADY_SENT');

    const draft = await EmailDraft.findOne({ _id: slot.draftId, organizationId });
    if (!draft) throw new AppError('Draft not found', 404, 'DRAFT_NOT_FOUND');

    const customObj: Record<string, string> =
      recipient.customFields instanceof Map
        ? Object.fromEntries(recipient.customFields)
        : (recipient.customFields as any) || {};

    const repairedBody = repairUnsupportedClaims(draft.bodyText, {
      companyName: recipient.companyName || 'your company',
      sector: customObj['sector'],
      domain: customObj['domain'],
      proposedDeliverable: customObj['proposed_deliverable'],
      websiteStatus: customObj['website_status'],
      httpCode: customObj['http_code'],
    });

    const validation = validateEmailCopy({
      subject: draft.subject,
      bodyText: repairedBody,
      companyName: recipient.companyName,
      recipientName: recipient.name,
      recipientEmail: recipient.email,
      proposedDeliverable: customObj['proposed_deliverable'],
      domain: customObj['domain'],
      sector: customObj['sector'],
      websiteStatus: customObj['website_status'],
      httpCode: customObj['http_code'],
      customFields: customObj,
    });

    draft.bodyText = repairedBody;
    draft.isManualEdit = true;
    draft.generationSource = 'manual_edit';
    draft.warnings = validation.warnings;
    draft.unsupportedClaims = validation.unsupportedClaims;
    draft.companyNameMismatch = validation.companyNameMismatch || undefined;
    await draft.save();

    const enriched = await this.getEnrichedRecipient(organizationId, campaignId, recipientId);
    return { repaired: true, recipient: enriched };
  }

  /** Restores a single step draft back to the original CSV template. */
  async restoreOriginalStepDraft(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    stepIndex: number
  ): Promise<any> {
    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    const slot = recipient.stepDrafts.find((d) => d.stepIndex === stepIndex);
    if (!slot || !slot.draftId) throw new AppError('Step draft not generated yet', 404, 'DRAFT_NOT_FOUND');
    if (slot.status === 'sent') throw new AppError('Cannot edit an already-sent step', 400, 'STEP_ALREADY_SENT');

    const draft = await EmailDraft.findOne({ _id: slot.draftId, organizationId });
    if (!draft) throw new AppError('Draft not found', 404, 'DRAFT_NOT_FOUND');

    let origSubject = draft.originalSubject;
    let origBody = draft.originalBodyText;

    if (!origSubject || !origBody) {
      const customObj: Record<string, string> =
        recipient.customFields instanceof Map
          ? Object.fromEntries(recipient.customFields)
          : (recipient.customFields as any) || {};
      const copy = getImportedStepCopy(customObj, stepIndex, true);
      origSubject = origSubject || copy.subject;
      origBody = origBody || copy.body;
    }

    if (!origSubject && !origBody) {
      throw new AppError('No original CSV template found for this step', 400, 'ORIGINAL_TEMPLATE_NOT_FOUND');
    }

    draft.subject = sanitizeHeaderValue(origSubject || draft.subject);
    draft.bodyText = origBody || draft.bodyText;
    draft.isManualEdit = false;
    draft.generationSource = 'csv_template';
    await draft.save();

    return this.getEnrichedRecipient(organizationId, campaignId, recipientId);
  }

  /** Regenerates a single step draft with personalized values from the CSV. */
  async regenerateStepDraft(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    stepIndex: number,
    mode?: 'personalized' | 'ai'
  ): Promise<any> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    let slot = recipient.stepDrafts.find((d) => d.stepIndex === stepIndex);
    if (slot && slot.status === 'sent') {
      throw new AppError('Cannot regenerate an already-sent step', 400, 'STEP_ALREADY_SENT');
    }

    const senderSettings = await WorkspaceSettings.findOne({ organizationId }).lean();
    const effectiveSender = senderSettings?.senderDisplayName || 'Vansh Aggarwal';

    let customObj: Record<string, string> =
      recipient.customFields instanceof Map
        ? Object.fromEntries(recipient.customFields)
        : (recipient.customFields as any) || {};

    if (recipient.companyId && (!customObj['step_1_subject'] || Object.keys(customObj).length < 5)) {
      const comp = await Company.findById(recipient.companyId).lean();
      if (comp && comp.customFields) {
        customObj = { ...comp.customFields, ...customObj };
        recipient.customFields = customObj;
      }
    }

    const step = campaign.steps.find((s) => s.stepIndex === stepIndex) || {
      stepIndex,
      subject: '',
      bodyText: '',
      delayDays: 0,
    };
    const hasZeroIndex = campaign.steps.some((s) => s.stepIndex === 0);
    const stepNum = hasZeroIndex ? step.stepIndex + 1 : step.stepIndex;

    const { subject: importedSubject, body: importedBody } = getImportedStepCopy(
      customObj,
      step.stepIndex,
      hasZeroIndex
    );

    const values = buildInterpolationValues({
      companyName: recipient.companyName,
      contactName: recipient.name,
      email: recipient.email,
      domain: customObj['domain'],
      sector: customObj['sector'],
      proposedDeliverable: customObj['proposed_deliverable'],
      senderName: effectiveSender,
      senderBusiness: senderSettings?.businessName || 'Swaniki New Business Radar',
      signOff: senderSettings?.defaultSignOff || 'Best regards,',
      signature: senderSettings?.emailSignature || effectiveSender,
      contactDetails: senderSettings?.contactDetails || '',
      greetingFormat: senderSettings?.defaultGreeting,
      missingNameFallback: senderSettings?.missingNameFallback || 'Hello,',
      customFields: customObj,
    });

    let renderedSubject = '';
    let renderedBody = '';
    let usedTokens: string[] = [];
    let missingTokens: string[] = [];
    let warnings: string[] = [];
    const isAi = mode === 'ai' || (campaign.generationMode === 'ai' && mode !== 'personalized');

    if (isAi) {
      const aiResult = await aiGroundingService.generateEmailDraft({
        companyName: recipient.companyName || recipient.email,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        targetService: resolveTargetService(campaign.targetService, customObj),
        tone: coerceTone(campaign.tone),
        objective:
          campaign.steps.length > 1
            ? `This is follow-up step ${step.stepIndex + 1} of ${campaign.steps.length}.`
            : undefined,
        explicitNeeds: extractDeclaredNeeds(customObj),
        customFieldContext: customObj,
        senderName: effectiveSender,
      });
      renderedSubject =
        sanitizeHeaderValue(aiResult.output.subject) ||
        (importedSubject ? sanitizeHeaderValue(importedSubject) : `Outreach for ${recipient.companyName || recipient.email}`);
      renderedBody = aiResult.output.bodyText;
      usedTokens = aiResult.output.factsUsed;
      missingTokens = aiResult.output.missingInformation;
      warnings = aiResult.output.warnings;
    } else {
      let templateSubject = step.subject || '';
      let templateBody = step.bodyText || '';

      if (importedSubject && importedSubject.trim().length > 0) {
        if (
          !templateSubject ||
          templateSubject.includes(`step_${stepNum}_subject`) ||
          templateSubject.includes(`step_${step.stepIndex}_subject`)
        ) {
          templateSubject = importedSubject;
        }
      }
      if (importedBody && importedBody.trim().length > 0) {
        if (
          !templateBody ||
          templateBody.includes(`step_${stepNum}_body`) ||
          templateBody.includes(`step_${step.stepIndex}_body`)
        ) {
          templateBody = importedBody;
        }
      }

      const subjectResult = interpolateTemplate(templateSubject, values);
      const bodyResult = interpolateTemplate(templateBody, values);

      renderedSubject =
        sanitizeHeaderValue(subjectResult.output) ||
        (importedSubject ? sanitizeHeaderValue(importedSubject) : `Outreach for ${recipient.companyName || recipient.email}`);
      renderedBody = bodyResult.output || (importedBody ? importedBody : '');
      usedTokens = bodyResult.usedTokens.map((t) => `CSV column: ${t}`);
      missingTokens = [...new Set([...subjectResult.missingTokens, ...bodyResult.missingTokens])];
      if (missingTokens.length) warnings.push('Some merge fields were empty for this recipient.');
    }

    const validation = validateEmailCopy({
      subject: renderedSubject,
      bodyText: renderedBody,
      companyName: recipient.companyName,
      recipientName: recipient.name,
      recipientEmail: recipient.email,
      proposedDeliverable: customObj['proposed_deliverable'],
      domain: customObj['domain'],
      sector: customObj['sector'],
      websiteStatus: customObj['website_status'],
      httpCode: customObj['http_code'],
      customFields: customObj,
    });

    warnings = [...new Set([...warnings, ...validation.warnings])];

    if (!renderedSubject.trim() || !renderedBody.trim()) {
      throw new AppError(`Step ${stepNum} requires a subject and body. CSV copy was missing.`, 400, 'STEP_COPY_MISSING');
    }

    if (!slot) {
      slot = { stepIndex, status: 'pending' };
      recipient.stepDrafts.push(slot);
    }

    if (slot.draftId) {
      await EmailDraft.findByIdAndUpdate(slot.draftId, {
        subject: renderedSubject,
        bodyText: renderedBody,
        isManualEdit: false,
        generationSource: isAi ? 'ai_grounded' : 'personalized_template',
        originalSubject: importedSubject || undefined,
        originalBodyText: importedBody || undefined,
        factsUsed: usedTokens,
        missingInformation: missingTokens,
        warnings,
        companyNameMismatch: validation.companyNameMismatch || undefined,
        unsupportedClaims: validation.unsupportedClaims,
      });
    } else {
      const newDraft = await EmailDraft.create({
        organizationId,
        campaignId: campaign._id,
        recipientId: recipient._id,
        stepIndex,
        companyId: recipient.companyId,
        companyName: recipient.companyName || recipient.email,
        contactId: recipient.contactId,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        subject: renderedSubject,
        bodyText: renderedBody,
        tone: campaign.tone,
        status: 'draft',
        originalSubject: importedSubject || undefined,
        originalBodyText: importedBody || undefined,
        isManualEdit: false,
        generationSource: isAi ? 'ai_grounded' : 'personalized_template',
        factsUsed: usedTokens,
        missingInformation: missingTokens,
        warnings,
        companyNameMismatch: validation.companyNameMismatch || undefined,
        unsupportedClaims: validation.unsupportedClaims,
      });
      slot.draftId = newDraft._id as any;
    }

    slot.status = 'draft';
    slot.error = undefined;
    await recipient.save();

    return this.getEnrichedRecipient(organizationId, campaignId, recipientId);
  }

  /** Retrieves a recipient with its step drafts and full draft contents enriched. */
  async getEnrichedRecipient(organizationId: string, campaignId: string, recipientId: string): Promise<any> {
    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId }).lean();
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    const draftIds = (recipient.stepDrafts || []).map((d: any) => d.draftId).filter(Boolean);
    const drafts = draftIds.length
      ? await EmailDraft.find({ _id: { $in: draftIds }, organizationId }).lean()
      : [];
    const draftMap = new Map(drafts.map((d: any) => [String(d._id), d]));

    return {
      ...recipient,
      stepDrafts: (recipient.stepDrafts || []).map((d: any) => ({
        ...d,
        draft: d.draftId ? draftMap.get(String(d.draftId)) || null : null,
      })),
    };
  }

  /** Generates or regenerates drafts for a single recipient across all campaign steps. */
  async generateRecipientDrafts(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    senderName?: string
  ): Promise<any> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    const senderSettings = await WorkspaceSettings.findOne({ organizationId }).lean();
    const effectiveSender = senderName || senderSettings?.senderDisplayName || 'Vansh Aggarwal';
    const useAi = campaign.generationMode === 'ai';

    let customObj: Record<string, string> =
      recipient.customFields instanceof Map
        ? Object.fromEntries(recipient.customFields)
        : (recipient.customFields as any) || {};

    if (recipient.companyId && (!customObj['step_1_subject'] || Object.keys(customObj).length < 5)) {
      const comp = await Company.findById(recipient.companyId).lean();
      if (comp && comp.customFields) {
        customObj = { ...comp.customFields, ...customObj };
        recipient.customFields = customObj;
      }
    }

    const values = buildInterpolationValues({
      companyName: recipient.companyName,
      contactName: recipient.name,
      email: recipient.email,
      domain: customObj['domain'],
      sector: customObj['sector'],
      proposedDeliverable: customObj['proposed_deliverable'],
      senderName: effectiveSender,
      senderBusiness: senderSettings?.businessName || 'Swaniki New Business Radar',
      signOff: senderSettings?.defaultSignOff || 'Best regards,',
      signature: senderSettings?.emailSignature || effectiveSender,
      contactDetails: senderSettings?.contactDetails || '',
      greetingFormat: senderSettings?.defaultGreeting,
      missingNameFallback: senderSettings?.missingNameFallback || 'Hello,',
      customFields: customObj,
    });

    const hasZeroIndex = campaign.steps.some((s) => s.stepIndex === 0);
    for (const step of campaign.steps) {
      let slot = recipient.stepDrafts.find((d) => d.stepIndex === step.stepIndex);
      if (!slot) {
        slot = { stepIndex: step.stepIndex, status: 'pending' };
        recipient.stepDrafts.push(slot);
      }

      if (slot.draftId) {
        const existing = await EmailDraft.findById(slot.draftId);
        if (existing) continue; // Keep existing draft
      }

      const stepNum = hasZeroIndex ? step.stepIndex + 1 : step.stepIndex;
      const { subject: importedSubject, body: importedBody } = getImportedStepCopy(
        customObj,
        step.stepIndex,
        hasZeroIndex
      );

      let draft;
      if (useAi) {
        draft = await this.createAiStepDraft(campaign, recipient, step, effectiveSender);
      } else {
        let templateSubject = step.subject || '';
        let templateBody = step.bodyText || '';

        if (importedSubject && importedSubject.trim().length > 0) {
          if (
            !templateSubject ||
            templateSubject.includes(`step_${stepNum}_subject`) ||
            templateSubject.includes(`step_${step.stepIndex}_subject`)
          ) {
            templateSubject = importedSubject;
          }
        }
        if (importedBody && importedBody.trim().length > 0) {
          if (
            !templateBody ||
            templateBody.includes(`step_${stepNum}_body`) ||
            templateBody.includes(`step_${step.stepIndex}_body`)
          ) {
            templateBody = importedBody;
          }
        }

        const subjectResult = interpolateTemplate(templateSubject, values);
        const bodyResult = interpolateTemplate(templateBody, values);

        const renderedSubject =
          sanitizeHeaderValue(subjectResult.output) ||
          (importedSubject ? sanitizeHeaderValue(importedSubject) : `Outreach for ${recipient.companyName || recipient.email}`);
        const renderedBody = bodyResult.output || (importedBody ? importedBody : '');

        if (!renderedSubject.trim() || !renderedBody.trim()) {
          slot.status = 'failed';
          slot.error = `Missing Step ${stepNum} copy in imported CSV or template`;
          continue;
        }

        const validation = validateEmailCopy({
          subject: renderedSubject,
          bodyText: renderedBody,
          companyName: recipient.companyName,
          recipientName: recipient.name,
          recipientEmail: recipient.email,
          proposedDeliverable: customObj['proposed_deliverable'],
          sector: customObj['sector'],
          customFields: customObj,
          domain: customObj['domain'],
          websiteStatus: customObj['website_status'],
          httpCode: customObj['http_code'],
        });

        draft = await EmailDraft.create({
          organizationId: campaign.organizationId,
          campaignId: campaign._id,
          recipientId: recipient._id,
          stepIndex: step.stepIndex,
          companyId: recipient.companyId,
          companyName: recipient.companyName || recipient.email,
          contactId: recipient.contactId,
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          subject: renderedSubject,
          bodyText: renderedBody,
          tone: campaign.tone,
          status: 'draft',
          originalSubject: importedSubject || undefined,
          originalBodyText: importedBody || undefined,
          isManualEdit: false,
          generationSource: 'personalized_template',
          factsUsed: [...subjectResult.usedTokens, ...bodyResult.usedTokens],
          missingInformation: [...subjectResult.missingTokens, ...bodyResult.missingTokens],
          warnings: validation.warnings,
          companyNameMismatch: validation.companyNameMismatch || undefined,
          unsupportedClaims: validation.unsupportedClaims,
          isFallbackTemplate: true,
        });
      }

      slot.draftId = draft._id as any;
      slot.status = 'draft';
      slot.error = undefined;
    }

    if (recipient.status === 'pending') recipient.status = 'prepared';
    await recipient.save();

    return this.getEnrichedRecipient(organizationId, campaignId, recipientId);
  }

  /** Approves a specific step draft for a single recipient. */
  async approveRecipientStepDraft(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    stepIndex: number
  ): Promise<any> {
    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    const slot = recipient.stepDrafts.find((d) => d.stepIndex === stepIndex);
    if (!slot || !slot.draftId) {
      throw new AppError('Draft has not been generated for this step yet', 400, 'DRAFT_NOT_GENERATED');
    }

    await EmailDraft.updateOne(
      { _id: slot.draftId, organizationId },
      { $set: { status: 'approved' } }
    );
    slot.status = 'approved';
    slot.error = undefined;

    if (['pending', 'prepared'].includes(recipient.status)) {
      recipient.status = 'approved';
    }
    await recipient.save();

    return this.getEnrichedRecipient(organizationId, campaignId, recipientId);
  }

  /** Dispatches an individual recipient step immediately through the pre-flight pipeline. */
  async sendRecipientStepDraft(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    stepIndex: number,
    actorId: string
  ): Promise<any> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    const slot = recipient.stepDrafts.find((d) => d.stepIndex === stepIndex);
    if (!slot || !slot.draftId) {
      throw new AppError('Draft has not been generated for this step yet', 400, 'DRAFT_NOT_GENERATED');
    }
    if (slot.status !== 'approved') {
      throw new AppError('Draft must be approved before sending', 400, 'DRAFT_NOT_APPROVED');
    }

    // Deterministic key: the same campaign/recipient/step always maps to the
    // same idempotency key, so a double click or a retry can never deliver
    // the same message twice.
    const idempotencyKey = `campaign_${campaign._id}_${recipient._id}_step${stepIndex}_manual`;
    // A recipient is always contacted from its assigned mailbox so the thread
    // stays in one inbox. Fall back to the campaign's legacy single mailbox.
    const mailboxEmail = recipient.assignedAccountEmail || campaign.mailboxId;
    recipient.status = 'sending';
    await recipient.save();

    const result = await emailSendPipelineService.executeSend({
      draftId: String(slot.draftId),
      mailboxId: mailboxEmail,
      organizationId,
      actorId,
      idempotencyKey,
      campaignId: String(campaign._id),
      recipientId: String(recipient._id),
      stepIndex,
    });

    if (result.status === 'accepted') {
      slot.status = 'sent';
      slot.providerMessageId = result.providerMessageId;
      slot.providerThreadId = result.providerThreadId;
      slot.sentAt = new Date();
      recipient.lastSentAt = slot.sentAt;
      if (result.providerThreadId) {
        recipient.replyThreadId = result.providerThreadId;
      }
      recipient.completedSteps = Math.max(recipient.completedSteps, stepIndex + 1);
      recipient.status = recipient.completedSteps >= campaign.steps.length ? 'sent' : 'approved';
      recipient.lastError = undefined;

      // Persist scheduledAt for subsequent step if exists
      const nextStepObj = campaign.steps.find((s) => s.stepIndex === stepIndex + 1);
      if (nextStepObj) {
        let nextSlot = recipient.stepDrafts.find((d) => d.stepIndex === nextStepObj.stepIndex);
        if (!nextSlot) {
          nextSlot = { stepIndex: nextStepObj.stepIndex, status: 'pending' };
          recipient.stepDrafts.push(nextSlot);
        }
        const delayDays = nextStepObj.delayDays || 0;
        nextSlot.scheduledAt = new Date(slot.sentAt.getTime() + delayDays * 24 * 60 * 60 * 1000);
      }

      await recipient.save();
      await this.reconcileSendStats(campaign);
      await campaign.save();
    } else if (result.status === 'deferred') {
      // Quota limited: keep the step approved so it is retried automatically
      // once the mailbox's Gmail API budget refills.
      slot.status = 'approved';
      slot.error = result.errorMessage;
      recipient.status = 'approved';
      recipient.lastError = result.errorMessage;
      recipient.canRetry = true;
      await recipient.save();
      await this.reconcileSendStats(campaign);
      await campaign.save();
      throw new AppError(
        result.errorMessage || 'Gmail API quota exhausted. The send was deferred and will be retried automatically.',
        429,
        'GMAIL_QUOTA_EXCEEDED',
        { deferred: true, deferredUntil: result.deferredUntil }
      );
    } else {
      slot.status = 'failed';
      slot.error = result.errorMessage;
      recipient.status = 'failed';
      recipient.lastError = result.errorMessage;
      await recipient.save();
      await this.reconcileSendStats(campaign);
      await campaign.save();
      throw new AppError(result.errorMessage || 'Send failed', 400, 'SEND_FAILED');
    }

    return this.getEnrichedRecipient(organizationId, campaignId, recipientId);
  }

  /** Sends a test email copy of a draft to the designated test inbox. */
  async sendTestEmail(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    stepIndex: number,
    targetEmail: string,
    actorId: string
  ): Promise<{ success: boolean; messageId?: string }> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    const slot = recipient.stepDrafts.find((d) => d.stepIndex === stepIndex);
    if (!slot || !slot.draftId) {
      throw new AppError('Draft has not been generated for this step yet', 400, 'DRAFT_NOT_GENERATED');
    }

    const draft = await EmailDraft.findById(slot.draftId);
    if (!draft) throw new AppError('Draft not found', 404, 'DRAFT_NOT_FOUND');

    const testDraft = await EmailDraft.create({
      organizationId,
      campaignId: campaign._id,
      companyName: recipient.companyName,
      recipientEmail: targetEmail.toLowerCase().trim(),
      recipientName: 'Test Recipient',
      subject: `[TEST PREVIEW] ${draft.subject}`,
      bodyText: draft.bodyText,
      tone: draft.tone,
      status: 'approved',
    });

    const result = await emailSendPipelineService.executeSend({
      draftId: String(testDraft._id),
      mailboxId: campaign.mailboxId,
      organizationId,
      actorId,
      idempotencyKey: `test_send_${testDraft._id}_${Date.now()}`,
    });

    return { success: result.status === 'accepted', messageId: result.providerMessageId };
  }

  /** Cancels follow-up steps for an individual recipient. */
  async cancelRecipientFollowups(
    organizationId: string,
    campaignId: string,
    recipientId: string
  ): Promise<any> {
    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    for (const slot of recipient.stepDrafts) {
      if (['pending', 'draft', 'approved'].includes(slot.status)) {
        slot.status = 'skipped';
        slot.error = 'Follow-up cancelled by user.';
      }
    }
    await recipient.save();
    return this.getEnrichedRecipient(organizationId, campaignId, recipientId);
  }

  /** Updates campaign step delay days and durable scheduler settings. */
  async updateScheduleSettings(
    organizationId: string,
    campaignId: string,
    input: {
      stepDelays?: Array<{ stepIndex: number; delayDays: number }>;
      schedule?: {
        startAt?: string | Date;
        timezone?: string;
        batchSize?: number;
        paceMinutes?: number;
        windowStartHour?: number;
        windowEndHour?: number;
        allowedWeekdays?: number[];
        minIntervalSeconds?: number;
        jitterSeconds?: number;
        maxPerHour?: number;
        dailySendCap?: number;
      };
    }
  ): Promise<any> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    if (input.stepDelays && input.stepDelays.length) {
      for (const sd of input.stepDelays) {
        const step = campaign.steps.find((s) => s.stepIndex === sd.stepIndex);
        if (step) {
          step.delayDays = Math.max(0, Math.min(90, sd.delayDays));
        }
      }
    }

    if (input.schedule) {
      if (!campaign.schedule) {
        campaign.schedule = {
          startAt: input.schedule.startAt ? new Date(input.schedule.startAt) : new Date(),
          timezone: input.schedule.timezone || 'UTC',
          batchSize: input.schedule.batchSize || 25,
          paceMinutes: input.schedule.paceMinutes || 0,
          windowStartHour: input.schedule.windowStartHour,
          windowEndHour: input.schedule.windowEndHour,
          allowedWeekdays: input.schedule.allowedWeekdays,
          minIntervalSeconds: input.schedule.minIntervalSeconds,
          jitterSeconds: input.schedule.jitterSeconds,
          maxPerHour: input.schedule.maxPerHour,
          dailySendCap: input.schedule.dailySendCap,
          scheduledBy: 'user',
          scheduledAt: new Date(),
        } as any;
      } else {
        if (input.schedule.startAt) campaign.schedule.startAt = new Date(input.schedule.startAt);
        if (input.schedule.timezone) campaign.schedule.timezone = input.schedule.timezone;
        if (input.schedule.batchSize !== undefined) campaign.schedule.batchSize = input.schedule.batchSize;
        if (input.schedule.paceMinutes !== undefined) campaign.schedule.paceMinutes = input.schedule.paceMinutes;
        if (input.schedule.windowStartHour !== undefined) campaign.schedule.windowStartHour = input.schedule.windowStartHour;
        if (input.schedule.windowEndHour !== undefined) campaign.schedule.windowEndHour = input.schedule.windowEndHour;
        if (input.schedule.allowedWeekdays !== undefined) {
          campaign.schedule.allowedWeekdays = input.schedule.allowedWeekdays;
        }
        if (input.schedule.minIntervalSeconds !== undefined) {
          campaign.schedule.minIntervalSeconds = input.schedule.minIntervalSeconds;
        }
        if (input.schedule.jitterSeconds !== undefined) {
          campaign.schedule.jitterSeconds = input.schedule.jitterSeconds;
        }
        if (input.schedule.maxPerHour !== undefined) campaign.schedule.maxPerHour = input.schedule.maxPerHour;
        if (input.schedule.dailySendCap !== undefined) campaign.schedule.dailySendCap = input.schedule.dailySendCap;
      }
    }

    await campaign.save();

    // Recalculate scheduledAt for recipients who have sent Step 1 and have pending follow-up steps
    const sentRecipients = await CampaignRecipient.find({
      organizationId,
      campaignId: campaign._id,
      completedSteps: { $gt: 0 },
    });

    for (const rec of sentRecipients) {
      const lastSent = rec.lastSentAt || rec.stepDrafts.find((s) => s.sentAt)?.sentAt;
      if (!lastSent) continue;

      for (let i = rec.completedSteps; i < campaign.steps.length; i++) {
        const stepObj = campaign.steps[i];
        const slot = rec.stepDrafts.find((s) => s.stepIndex === stepObj.stepIndex);
        if (slot && ['pending', 'draft', 'approved'].includes(slot.status)) {
          slot.scheduledAt = new Date(new Date(lastSent).getTime() + (stepObj.delayDays || 0) * 24 * 60 * 60 * 1000);
        }
      }
      await rec.save();
    }

    return campaign;
  }

  /**
   * Dispatches one recipient step through the pre-flight pipeline.
   *
   * Extracted from `sendBatch` so the drip scheduler and the manual batch
   * sender share exactly the same rules (approval gate, company-name guard,
   * step delay, deterministic idempotency key, deferral handling).
   */
  async sendRecipientStep(
    campaign: SendableCampaign,
    recipient: SendableRecipient,
    mailboxEmail: string,
    actorId: string,
    options: { maxQuotaWaitMs?: number; idempotencySuffix?: string } = {}
  ): Promise<RecipientStepOutcome> {
    // Check if recipient has replied (cancel follow-ups)
    if (recipient.replied) {
      recipient.status = 'replied';
      for (const s of recipient.stepDrafts) {
        if (s.status !== 'sent') {
          s.status = 'skipped';
          s.error = 'Follow-up stopped because recipient replied.';
        }
      }
      await recipient.save();
      return { status: 'replied', counted: false, stopForLimit: false, quotaDeferred: false };
    }

    const nextStepIndex = recipient.completedSteps;
    if (nextStepIndex >= campaign.steps.length) {
      recipient.status = 'sent';
      await recipient.save();
      return { status: 'complete', counted: false, stopForLimit: false, quotaDeferred: false };
    }

    const step = campaign.steps.find((s) => s.stepIndex === nextStepIndex);
    if (!step) {
      recipient.status = 'sent';
      await recipient.save();
      return { status: 'complete', counted: false, stopForLimit: false, quotaDeferred: false };
    }

    const slot = recipient.stepDrafts.find((d) => d.stepIndex === nextStepIndex);
    if (!slot || !slot.draftId) {
      recipient.lastError = `Step ${nextStepIndex + 1} draft has not been generated yet.`;
      recipient.status = 'prepared';
      if (slot) slot.error = recipient.lastError;
      await recipient.save();
      return { status: 'not_ready', counted: false, stopForLimit: false, quotaDeferred: false };
    }

    if (slot.status !== 'approved') {
      recipient.lastError = `Step ${nextStepIndex + 1} draft is awaiting approval.`;
      recipient.status = 'prepared';
      await recipient.save();
      return { status: 'not_ready', counted: false, stopForLimit: false, quotaDeferred: false };
    }

    const draftDoc = await EmailDraft.findById(slot.draftId);
    if (draftDoc?.companyNameMismatch) {
      recipient.lastError = `Send blocked: copy references "${draftDoc.companyNameMismatch}" which does not match recipient "${recipient.companyName}". Review and approve before sending.`;
      recipient.status = 'prepared';
      slot.status = 'draft';
      await recipient.save();
      return { status: 'not_ready', counted: false, stopForLimit: false, quotaDeferred: false };
    }

    const lastSent = recipient.stepDrafts
      .filter((d) => d.sentAt)
      .sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime())
      .at(-1)?.sentAt as Date | undefined;
    if (nextStepIndex > 0 && !isStepDue(lastSent, step.delayDays)) {
      // not due yet; leave for a later batch/scheduler tick
      return { status: 'not_due', counted: false, stopForLimit: false, quotaDeferred: false };
    }

    const idempotencyKey = `campaign_${campaign._id}_${recipient._id}_step${nextStepIndex}${
      options.idempotencySuffix || ''
    }`;

    recipient.status = 'sending';
    await recipient.save();

    try {
      const result = await emailSendPipelineService.executeSend({
        draftId: String(slot.draftId),
        mailboxId: mailboxEmail,
        organizationId: campaign.organizationId,
        actorId,
        idempotencyKey,
        campaignId: String(campaign._id),
        recipientId: String(recipient._id),
        stepIndex: nextStepIndex,
        // Fail fast on quota exhaustion: the recipient stays approved and the
        // batch yields instead of stalling on every recipient.
        maxQuotaWaitMs: options.maxQuotaWaitMs ?? 2000,
      });

      if (result.status === 'accepted') {
        slot.status = 'sent';
        slot.providerMessageId = result.providerMessageId;
        slot.providerThreadId = result.providerThreadId;
        slot.sentAt = new Date();
        recipient.lastSentAt = slot.sentAt;
        if (result.providerThreadId) {
          recipient.replyThreadId = result.providerThreadId;
        }
        recipient.completedSteps = nextStepIndex + 1;
        recipient.status = recipient.completedSteps >= campaign.steps.length ? 'sent' : 'approved';
        recipient.lastError = undefined;
        // The account that actually sent the message is now locked to this
        // recipient: it can never be migrated to another mailbox.
        recipient.assignmentLocked = true;

        // Persist scheduledAt for subsequent step
        const nextStepObj = campaign.steps.find((s) => s.stepIndex === nextStepIndex + 1);
        if (nextStepObj) {
          let nextSlot = recipient.stepDrafts.find((d) => d.stepIndex === nextStepObj.stepIndex);
          if (!nextSlot) {
            nextSlot = { stepIndex: nextStepObj.stepIndex, status: 'pending' };
            recipient.stepDrafts.push(nextSlot);
          }
          const delayDays = nextStepObj.delayDays || 0;
          nextSlot.scheduledAt = new Date(slot.sentAt.getTime() + delayDays * 24 * 60 * 60 * 1000);
        }

        await recipient.save();
        return {
          status: 'sent',
          counted: true,
          stopForLimit: false,
          quotaDeferred: false,
          providerMessageId: result.providerMessageId,
          providerThreadId: result.providerThreadId,
        };
      }

      if (result.status === 'deferred') {
        // Quota limited: leave the step approved so the next batch retries it
        // once the mailbox's Gmail API budget refills. The campaign is not
        // paused — it stays in a resumable state for the scheduler.
        slot.status = 'approved';
        slot.error = result.errorMessage;
        recipient.status = 'approved';
        recipient.lastError = result.errorMessage;
        recipient.canRetry = true;
        await recipient.save();
        return {
          status: 'deferred',
          counted: true,
          stopForLimit: false,
          quotaDeferred: true,
          errorMessage: result.errorMessage,
        };
      }

      slot.status = 'failed';
      slot.error = result.errorMessage;
      recipient.status = 'failed';
      recipient.lastError = result.errorMessage;
      await recipient.save();
      return {
        status: 'failed',
        counted: true,
        stopForLimit: false,
        quotaDeferred: false,
        errorMessage: result.errorMessage,
      };
    } catch (err: any) {
      const code = err?.code;
      if (code === 'RECIPIENT_SUPPRESSED') {
        recipient.status = 'suppressed';
        slot.status = 'skipped';
        recipient.skipReason = 'Recipient is on the suppression list.';
        recipient.lastError = recipient.skipReason;
        recipient.canRetry = false;
        for (const s of recipient.stepDrafts) {
          if (['pending', 'draft', 'approved'].includes(s.status)) {
            s.status = 'skipped';
            s.error = 'Follow-up cancelled: recipient suppressed.';
          }
        }
        campaign.stats.skipped++;
        await recipient.save();
        return {
          status: 'suppressed',
          counted: true,
          stopForLimit: false,
          quotaDeferred: false,
          errorMessage: recipient.lastError,
        };
      }

      if (code === 'LIMIT_EXCEEDED') {
        recipient.status = 'approved';
        await recipient.save();
        return {
          status: 'deferred',
          counted: true,
          stopForLimit: true,
          quotaDeferred: false,
          errorMessage: err?.message,
        };
      }

      if (code === 'GMAIL_QUOTA_EXCEEDED' || code === 'GMAIL_QUOTA_EXHAUSTED') {
        // Quota limited: leave the step approved so the next batch retries it
        // once the mailbox's Gmail API budget refills. The campaign is not
        // paused — it stays in a resumable state for the scheduler.
        slot.status = 'approved';
        slot.error = err?.message;
        recipient.status = 'approved';
        recipient.lastError = err?.message;
        recipient.canRetry = true;
        await recipient.save();
        return {
          status: 'deferred',
          counted: true,
          stopForLimit: false,
          quotaDeferred: true,
          errorMessage: err?.message,
        };
      }

      slot.status = 'failed';
      recipient.status = 'failed';
      recipient.lastError = err?.message || 'Send failed';
      await recipient.save();
      return {
        status: 'failed',
        counted: true,
        stopForLimit: false,
        quotaDeferred: false,
        errorMessage: recipient.lastError,
      };
    }
  }

  /** Sends a bounded batch through the mandatory pre-flight pipeline, resumable. */
  /**
   * How many messages a sender account may still send right now.
   *
   * A manual batch skips the drip *interval* on purpose (the operator asked
   * for a batch), but the daily and hourly caps are a hard protection of the
   * mailbox: without them a single click could send hundreds of messages in a
   * second and get the Gmail account throttled. The counters of the account
   * are global, so the roster limits also apply to the other campaigns of
   * the same mailbox.
   */
  private async remainingSenderBudget(
    organizationId: string,
    entry: any
  ): Promise<{ remaining: number; dailyCap: number; maxPerHour: number }> {
    const account = await EmailAccount.findOne({ _id: entry.accountId, organizationId }).lean();
    if (!account) return { remaining: 0, dailyCap: 0, maxPerHour: 0 };

    await senderAccountService.rollOverCounters(String(account._id));

    const counters = await EmailAccount.findOne({ _id: account._id })
      .select('sendsToday sendsThisHour reservedSends dailySendLimit')
      .lean();

    const dailyCap = Math.min(
      entry.dailySendCap ?? env.CAMPAIGN_SENDER_DAILY_CAP_DEFAULT,
      env.CAMPAIGN_SENDER_DAILY_CAP_MAX,
      account.dailySendLimit ?? env.CAMPAIGN_SENDER_DAILY_CAP_DEFAULT
    );
    const maxPerHour = Math.min(
      entry.maxPerHour ?? env.CAMPAIGN_SENDER_MAX_PER_HOUR_DEFAULT,
      env.CAMPAIGN_SENDER_MAX_PER_HOUR_MAX
    );

    const usedToday = (counters?.sendsToday ?? 0) + (counters?.reservedSends ?? 0);
    const usedThisHour = (counters?.sendsThisHour ?? 0) + (counters?.reservedSends ?? 0);

    return {
      remaining: Math.max(0, Math.min(dailyCap - usedToday, maxPerHour - usedThisHour)),
      dailyCap,
      maxPerHour,
    };
  }

  async sendBatch(
    organizationId: string,
    campaignId: string,
    mailboxId: string,
    batchSize: number | undefined,
    actorId: string
  ): Promise<BatchResult> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    if (campaign.status === 'paused') throw new AppError('Campaign is paused', 400, 'CAMPAIGN_PAUSED');
    if (campaign.status === 'cancelled') {
      throw new AppError('Campaign is cancelled', 400, 'CAMPAIGN_CANCELLED');
    }
    if (campaign.status === 'completed') {
      const eligible = await CampaignRecipient.countDocuments({
        organizationId,
        campaignId: campaign._id,
        status: { $in: ['approved', 'sending'] },
      });
      if (eligible === 0) {
        return { processed: 0, remaining: 0, status: campaign.status, stats: this.publicStats(campaign) };
      }
      campaign.status = 'sending';
      await campaign.save();
    }

    campaign.status = 'sending';
    await campaign.save();

    const limit = clampBatch(batchSize);
    const roster = (campaign.senderAccounts || []).filter((entry: any) => entry.enabled);

    let processed = 0;
    let stopForLimit = false;
    let quotaDeferred = false;
    const throttledAccounts: { accountId: string; emailAddress: string; reason: string }[] = [];

    // Multi-account campaigns send every recipient from its own assigned
    // account. The batch budget is split deterministically over the enabled
    // accounts so the total number of sends per batch stays bounded.
    if (roster.length > 0) {
      const base = Math.floor(limit / roster.length);
      const remainder = limit % roster.length;

      for (let index = 0; index < roster.length; index++) {
        if (stopForLimit || quotaDeferred) break;
        const entry = roster[index];
        let accountLimit = base + (index < remainder ? 1 : 0);
        if (accountLimit <= 0) continue;

        // The roster caps are a hard limit for the mailbox and therefore also
        // apply to a manual batch (the drip interval is the only thing that is
        // deliberately skipped here).
        const budget = await this.remainingSenderBudget(organizationId, entry);
        if (budget.remaining <= 0) {
          throttledAccounts.push({
            accountId: entry.accountId,
            emailAddress: entry.emailAddress,
            reason:
              budget.dailyCap <= 0
                ? 'The daily cap of this mailbox is reached.'
                : 'The hourly cap of this mailbox is reached.',
          });
          continue;
        }
        accountLimit = Math.min(accountLimit, budget.remaining);

        const recipients = await CampaignRecipient.find({
          organizationId,
          campaignId: campaign._id,
          assignedAccountId: entry.accountId,
          status: { $in: ['approved', 'sending'] },
        })
          .sort({ rowNumber: 1 })
          .limit(accountLimit);

        for (const recipient of recipients) {
          if (stopForLimit || quotaDeferred) break;
          const outcome = await this.sendRecipientStep(campaign, recipient, entry.emailAddress, actorId, {
            maxQuotaWaitMs: 2000,
          });
          if (outcome.counted) processed++;
          if (outcome.stopForLimit) stopForLimit = true;
          if (outcome.quotaDeferred) quotaDeferred = true;
        }
      }
    } else {
      const recipients = await CampaignRecipient.find({
        organizationId,
        campaignId: campaign._id,
        status: { $in: ['approved', 'sending'] },
      })
        .sort({ rowNumber: 1 })
        .limit(limit);

      for (const recipient of recipients) {
        if (stopForLimit || quotaDeferred) break;
        const outcome = await this.sendRecipientStep(campaign, recipient, mailboxId, actorId, {
          maxQuotaWaitMs: 2000,
        });
        if (outcome.counted) processed++;
        if (outcome.stopForLimit) stopForLimit = true;
        if (outcome.quotaDeferred) quotaDeferred = true;
      }
    }

    const remaining = await CampaignRecipient.countDocuments({
      organizationId,
      campaignId: campaign._id,
      status: { $in: ['approved', 'sending'] },
    });

    if (remaining === 0 && !stopForLimit) {
      const pendingOrPrepared = await CampaignRecipient.countDocuments({
        organizationId,
        campaignId: campaign._id,
        status: { $in: ['pending', 'prepared'] },
      });
      campaign.status = pendingOrPrepared > 0 ? 'ready_for_review' : 'completed';
    } else if (stopForLimit) {
      campaign.status = 'paused';
    } else {
      campaign.status = 'sending';
    }
    // Derive Sent from durable accepted send attempts so it never drifts from reality.
    await this.reconcileSendStats(campaign);
    await campaign.save();

    return {
      processed,
      remaining,
      status: campaign.status,
      stats: this.publicStats(campaign),
      throttledAccounts,
    };
  }

  /** Lightweight progress view for monitoring, computed dynamically from persisted recipient records. */
  async getProgress(organizationId: string, campaignId: string) {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const grouped = await CampaignRecipient.aggregate([
      { $match: { organizationId, campaignId: campaign._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[g._id] = g.count;

    const totalRecipients = await CampaignRecipient.countDocuments({ organizationId, campaignId: campaign._id });
    // "Sent" counts successful message sends (one per accepted step send), NOT unique
    // recipients. Derived from durable accepted send attempts so it never drifts and is
    // dedupe-safe across retries/refreshes.
    const sentCount = await EmailSendAttempt.countDocuments({
      organizationId,
      campaignId: campaign._id,
      status: 'accepted',
    });
    const failedCount = byStatus['failed'] ?? 0;
    const skippedCount = (byStatus['skipped'] ?? 0) + (byStatus['suppressed'] ?? 0);
    const preparedCount = byStatus['prepared'] ?? 0;
    const approvedCount = byStatus['approved'] ?? 0;
    const pendingCount = byStatus['pending'] ?? 0;
    const sendingCount = byStatus['sending'] ?? 0;

    const ungeneratedCount = await CampaignRecipient.countDocuments({
      organizationId,
      campaignId: campaign._id,
      status: { $nin: ['skipped', 'suppressed'] },
      $or: [
        { 'stepDrafts.draftId': { $exists: false } },
        { stepDrafts: { $size: 0 } },
        { 'stepDrafts.status': { $in: ['pending', 'failed'] } },
      ],
    });

    campaign.stats.totalRecipients = totalRecipients;
    campaign.stats.prepared = preparedCount;
    campaign.stats.sent = sentCount;
    campaign.stats.failed = failedCount;
    campaign.stats.skipped = skippedCount;
    await campaign.save();

    return {
      campaignId: campaign._id.toString(),
      name: campaign.name,
      status: campaign.status,
      totalRecipients,
      byStatus,
      sent: sentCount,
      failed: failedCount,
      skipped: skippedCount,
      prepared: preparedCount,
      approved: approvedCount,
      pending: pendingCount,
      sending: sendingCount,
      hasUngeneratedDrafts: ungeneratedCount > 0,
      repliesReceived: campaign.repliesReceived || 0,
      schedule: campaign.schedule || null,
      lastError: campaign.lastError,
    };
  }

  /** Re-validates and requeues a skipped or failed recipient. */
  async retryRecipient(
    organizationId: string,
    campaignId: string,
    recipientId: string
  ): Promise<ICampaignRecipient> {
    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    // Prevent resending already sent recipients
    if (recipient.status === 'sent' || recipient.stepDrafts.some((s) => s.status === 'sent' && s.providerMessageId)) {
      throw new AppError('Recipient has already been sent and cannot be retried', 400, 'ALREADY_SENT');
    }

    const email = recipient.email?.trim().toLowerCase();
    if (!email || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
      throw new AppError(
        `Cannot retry: recipient email '${recipient.email}' is invalid. Please update the email address first.`,
        400,
        'INVALID_EMAIL'
      );
    }

    // Check suppression
    const isSuppressed = await Suppression.findOne({ organizationId, email });
    if (isSuppressed) {
      recipient.status = 'suppressed';
      recipient.skipReason = `Recipient is on the suppression list (${isSuppressed.reason})`;
      recipient.lastError = recipient.skipReason;
      recipient.canRetry = false;
      await recipient.save();
      throw new AppError(`Cannot retry: recipient is suppressed (${isSuppressed.reason})`, 400, 'RECIPIENT_SUPPRESSED');
    }

    // Check if drafts already exist
    const hasApprovedDrafts = recipient.stepDrafts.length > 0 && recipient.stepDrafts.every((s) => s.status === 'approved');
    const hasDrafts = recipient.stepDrafts.length > 0 && recipient.stepDrafts.some((s) => !!s.draftId);

    recipient.status = hasApprovedDrafts ? 'approved' : hasDrafts ? 'prepared' : 'pending';
    recipient.skipReason = undefined;
    recipient.lastError = undefined;
    recipient.canRetry = false;

    // Reset step drafts that were failed or skipped (unless already sent)
    for (const slot of recipient.stepDrafts) {
      if (slot.status === 'failed' || slot.status === 'skipped') {
        slot.status = slot.draftId ? 'draft' : 'pending';
        slot.error = undefined;
      }
    }

    await recipient.save();
    return recipient;
  }

  /** Updates recipient details (e.g. corrected email or company name) on editable recipients. */
  async updateRecipient(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    updates: { email?: string; name?: string; companyName?: string }
  ): Promise<ICampaignRecipient> {
    const recipient = await CampaignRecipient.findOne({ _id: recipientId, campaignId, organizationId });
    if (!recipient) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');

    if (recipient.status === 'sent') {
      throw new AppError('Cannot update an already sent recipient', 400, 'ALREADY_SENT');
    }

    if (updates.email) {
      recipient.email = updates.email.trim().toLowerCase();
    }
    if (updates.name !== undefined) {
      recipient.name = updates.name.trim();
    }
    if (updates.companyName !== undefined) {
      recipient.companyName = updates.companyName.trim();
    }

    const isValidEmail = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(recipient.email);
    recipient.canRetry = isValidEmail;

    await recipient.save();
    return recipient;
  }

  /**
   * Recomputes durable campaign counters from persisted records. Sent is the number of
   * accepted provider sends for THIS campaign (dedupe-safe via the unique idempotency
   * key), so retries, webhook replays, and page refreshes cannot inflate or reset it.
   */
  private async reconcileSendStats(campaign: any): Promise<void> {
    const [sent, failed, replied] = await Promise.all([
      EmailSendAttempt.countDocuments({
        organizationId: campaign.organizationId,
        campaignId: campaign._id,
        status: 'accepted',
      }),
      CampaignRecipient.countDocuments({
        organizationId: campaign.organizationId,
        campaignId: campaign._id,
        status: 'failed',
      }),
      CampaignRecipient.countDocuments({
        organizationId: campaign.organizationId,
        campaignId: campaign._id,
        replied: true,
      }),
    ]);
    campaign.stats.sent = sent;
    campaign.stats.failed = failed;
    campaign.stats.replied = replied;
    campaign.repliesReceived = replied;
  }

  /**
   * Retrieves the path to the disk-persisted error report for an import job,
   * verifying tenant authorization.
   */
  async getJobErrorReport(jobId: string, organizationId: string): Promise<{ filePath: string; fileName: string }> {
    const job = await CampaignImportJob.findOne({ _id: jobId, organizationId });
    if (!job) {
      throw new AppError('Import job not found', 404, 'JOB_NOT_FOUND');
    }
    const reportPath = getJobErrorReportPath(jobId);
    if (!reportPath) {
      throw new AppError('No error report exists for this import job', 404, 'REPORT_NOT_FOUND');
    }
    const safeName = (job.campaignName || 'campaign').replace(/[^a-zA-Z0-9_-]/g, '_');
    return {
      filePath: reportPath,
      fileName: `${safeName}-import-errors.csv`,
    };
  }

  private publicStats(campaign: any) {
    return {
      totalRecipients: campaign.stats.totalRecipients,
      prepared: campaign.stats.prepared,
      sent: campaign.stats.sent,
      failed: campaign.stats.failed,
      skipped: campaign.stats.skipped,
      replied: campaign.stats.replied ?? campaign.repliesReceived ?? 0,
    };
  }
}

export const campaignService = new CampaignService();


import mongoose from 'mongoose';
import fs from 'node:fs';
import { Campaign, ICampaignSenderAccount } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { CampaignStagingContact } from '../models/CampaignStagingContact.js';
import {
  CampaignSplitJob,
  ICampaignSplitJob,
  ICampaignSplitStep,
} from '../models/CampaignSplitJob.js';
import { Company } from '../models/Company.js';
import { CompanyContact } from '../models/CompanyContact.js';
import { CompanyAssessment } from '../models/CompanyAssessment.js';
import { Suppression } from '../models/Suppression.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  ColumnMapping,
  assertRowLimit,
  createDuplicateSets,
  normalizeParsedRow,
} from './csv-parser.service.js';
import {
  appendRowErrorsToDisk,
  createSpreadsheetRowStream,
  detectSpreadsheetType,
  getJobErrorReportPath,
  inspectSpreadsheetFile,
  resolveUploadedFilePath,
} from './spreadsheet-stream.service.js';
import {
  MAX_TEMPLATE_LENGTH,
  STEP_COPY_FIELD_KEYS,
  boundCustomFields,
} from './template-interpolation.service.js';
import { senderAccountService } from './sender-account.service.js';
import { senderAllocationService } from './sender-allocation.service.js';
import { env } from '../config/env.js';

const ANALYSIS_PAGE_SIZE = 2000;
const ALLOCATION_PAGE_SIZE = 2000;
/** Rows / recipients persisted per bulk write while generating one campaign. */
const RECIPIENT_BATCH_SIZE = Math.max(50, Math.min(env.IMPORT_BATCH_SIZE || 500, 1000));
const CAMPAIGN_CREATION_BATCH_SIZE = Math.max(1, Math.min(env.CAMPAIGN_CREATION_BATCH_SIZE || 10, 500));
const CAMPAIGN_CREATION_CONCURRENCY = Math.max(1, Math.min(env.CAMPAIGN_CREATION_CONCURRENCY || 1, 10));
const CAMPAIGN_CREATION_MAX_RETRIES = Math.max(0, Math.min(env.CAMPAIGN_CREATION_MAX_RETRIES ?? 3, 10));
const STALE_JOB_MS = 5 * 60 * 1000;

export interface CampaignSplitStepInput {
  subject: string;
  bodyText: string;
  delayDays?: number;
}

export interface CreateSplitJobInput {
  organizationId: string;
  actorId: string;
  groupName: string;
  campaignNamePattern?: string;
  fileName: string;
  uploadId: string;
  contactsPerCampaign?: number;
  mailboxId: string;
  senderAccountIds?: string[];
  tone?: string;
  generationMode?: 'template' | 'ai';
  targetService?: string;
  steps: CampaignSplitStepInput[];
  columnMapping: Record<string, string>;
  customFieldMapping?: Record<string, string>;
  scaleType?: 'standard' | 'five_star' | 'ten_point';
}

export interface SplitPlan {
  validContacts: number;
  contactsPerCampaign: number;
  expectedCampaigns: number;
  lastCampaignContacts: number;
}

/** Deterministic split arithmetic shared with the UI preview. */
export function computeSplitPlan(validContacts: number, contactsPerCampaign: number): SplitPlan {
  const cpc = Math.max(1, Math.floor(contactsPerCampaign));
  const valid = Math.max(0, Math.floor(validContacts));
  if (valid === 0) {
    return { validContacts: 0, contactsPerCampaign: cpc, expectedCampaigns: 0, lastCampaignContacts: 0 };
  }
  const expectedCampaigns = Math.ceil(valid / cpc);
  const lastCampaignContacts = valid - (expectedCampaigns - 1) * cpc;
  return { validContacts: valid, contactsPerCampaign: cpc, expectedCampaigns, lastCampaignContacts };
}

/**
 * Builds a child campaign name from the user's pattern. `{number}` is padded to
 * at least three digits so names stay sortable ("Campaign 001").
 */
export function buildChildCampaignName(
  pattern: string,
  groupName: string,
  campaignNumber: number,
  expectedCampaigns: number
): string {
  const width = Math.max(3, String(Math.max(1, expectedCampaigns)).length);
  const template = pattern.includes('{number}') ? pattern : '{group} – Campaign {number}';
  return template
    .replace(/\{group\}/g, groupName)
    .replace(/\{number\}/g, String(campaignNumber).padStart(width, '0'))
    .trim()
    .slice(0, 200);
}

function clampBatch(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `worker` over `items` with a bounded number of concurrent promises. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(null)
    .map(async () => {
      while (true) {
        const current = index++;
        if (current >= items.length) return;
        await worker(items[current]);
      }
    });
  await Promise.all(runners);
}

/**
 * Serializes lookups + inserts of CRM companies/contacts across concurrent
 * campaign workers. Without a unique index on these collections, two parallel
 * batches could otherwise insert the same company twice.
 */
let crmQueue: Promise<unknown> = Promise.resolve();
function withCrmLock<T>(task: () => Promise<T>): Promise<T> {
  const run = crmQueue.then(task, task);
  crmQueue = run.catch(() => undefined);
  return run;
}

function compactStagingData(cleaned: Record<string, any>): Record<string, unknown> {
  const keys = [
    'company_name',
    'domain',
    'website_url',
    'industry',
    'city',
    'country',
    'contact_first_name',
    'contact_last_name',
    'contact_full_name',
    'contact_role',
    'contact_phone',
    'services',
    'rating',
    'raw_rating',
    'notes',
    'sector',
    'state_roc',
    'contact_confidence',
    'website_status',
    'site_audit_type',
    'http_code',
    'page_title',
    'proposed_deliverable',
    'primary_tech_signal',
    'authorized_capital',
    'direct_phone',
    'director_full_name',
  ];
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    if (cleaned[key] !== undefined && cleaned[key] !== null) data[key] = cleaned[key];
  }
  return data;
}

function extractStagingCustomFields(
  cleaned: Record<string, any>,
  raw: Record<string, string>,
  customFieldMapping: Record<string, string>
): { customFields: Record<string, string>; truncatedCopyKeys: string[] } {
  const rawCustom: Record<string, unknown> = {};
  if (cleaned.step_1_subject) rawCustom.step_1_subject = cleaned.step_1_subject;
  if (cleaned.step_1_body) rawCustom.step_1_body = cleaned.step_1_body;
  if (cleaned.step_2_subject) rawCustom.step_2_subject = cleaned.step_2_subject;
  if (cleaned.step_2_body) rawCustom.step_2_body = cleaned.step_2_body;
  if (cleaned.step_3_subject) rawCustom.step_3_subject = cleaned.step_3_subject;
  if (cleaned.step_3_body) rawCustom.step_3_body = cleaned.step_3_body;
  for (const key of [
    'sector',
    'state_roc',
    'proposed_deliverable',
    'primary_tech_signal',
    'authorized_capital',
    'contact_confidence',
    'direct_phone',
    'director_full_name',
    'website_status',
    'site_audit_type',
    'http_code',
    'page_title',
    'domain',
  ]) {
    if (cleaned[key]) rawCustom[key] = cleaned[key];
  }
  for (const [sourceHeader, targetKey] of Object.entries(customFieldMapping || {})) {
    if (sourceHeader in raw && raw[sourceHeader]) rawCustom[targetKey] = raw[sourceHeader];
  }
  const { customFields, truncatedKeys } = boundCustomFields(rawCustom);
  return {
    customFields,
    truncatedCopyKeys: truncatedKeys.filter((key) => STEP_COPY_FIELD_KEYS.has(key)),
  };
}

function isCancellationRequested(status: string | undefined): boolean {
  return status === 'cancellation_requested' || status === 'cancelling';
}

function applyPercent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((part / total) * 10000) / 100);
}

/** One child campaign's recipient counts compared with its staging rows. */
export interface RecipientIntegrityCampaign {
  campaignId: string;
  campaignNumber: number;
  name: string;
  status: string;
  expectedRecipients: number;
  actualRecipients: number;
  missingRecipients: number;
  /** Recipients that exist but were never assigned to this campaign. */
  extraRecipients: number;
  recordedTotalRecipients: number;
  statsOutOfSync: boolean;
  repairedRecipients: number;
}

/**
 * Operator-facing reconciliation report. `expectedRecipients` is derived from
 * the durable staging rows written during analysis, so it stays correct even
 * when campaign recipients or counters were lost.
 */
export interface RecipientIntegrityReport {
  jobId: string;
  jobStatus: string;
  checkedAt: Date;
  campaignCount: number;
  plannedCampaigns: number;
  expectedRecipients: number;
  actualRecipients: number;
  missingRecipients: number;
  extraRecipients: number;
  campaignsWithDrift: number;
  campaignsWithStatsDrift: number;
  /** Planned campaign numbers that no longer have a campaign document. */
  absentCampaignNumbers: number[];
  repaired: boolean;
  repairedCampaigns: number;
  repairedRecipients: number;
  campaigns: RecipientIntegrityCampaign[];
}

export interface CampaignSplitProgress {
  analysis: {
    totalRows: number;
    totalRowsIsExact: boolean;
    processedRows: number;
    validContacts: number;
    invalidContacts: number;
    duplicateContacts: number;
    suppressedContacts: number;
    percent: number;
    throughputRowsPerSecond: number;
    estimatedSecondsRemaining: number;
  };
  split: SplitPlan & { groupName: string; campaignNamePattern: string };
  generation: {
    expectedCampaigns: number;
    campaignsCreated: number;
    contactsAssigned: number;
    failedCampaigns: number;
    failedCampaignNumbers: number[];
    currentCampaignNumber: number;
    currentCampaignName?: string;
    allocationComplete: boolean;
    percent: number;
  };
  message: string;
  hasErrorReport: boolean;
}

export function formatSplitJobResponse(job: ICampaignSplitJob) {
  const throughput = job.analysisThroughputRowsPerSecond || 0;
  const analysisPercent =
    job.status === 'ready' || job.status === 'generating' || job.status === 'completed' || job.status === 'completed_with_errors'
      ? 100
      : applyPercent(job.processedRows, job.totalRows);
  const generationPercent = job.allocationComplete
    ? applyPercent(job.campaignsCreated + job.failedCampaigns, job.expectedCampaigns)
    : 0;

  let message = 'Waiting to start…';
  if (job.phase === 'analysis') {
    message = job.status === 'analyzing' ? 'Reading and validating contacts…' : 'Preparing analysis…';
  } else if (job.phase === 'ready') {
    message = 'Analysis complete. Review the proposed split.';
  } else if (job.phase === 'generation') {
    message = job.allocationComplete
      ? `Creating campaign ${job.currentCampaignNumber || 1} of ${job.expectedCampaigns}…`
      : 'Reserving contacts for each campaign…';
  } else if (job.phase === 'done') {
    if (job.status === 'completed_with_errors') message = 'Finished with some failed campaigns.';
    else if (job.status === 'cancelled') message = 'Cancelled.';
    else message = 'All campaigns created.';
  } else if (job.status === 'failed') {
    message = 'Import failed.';
  }

  const progress: CampaignSplitProgress = {
    analysis: {
      totalRows: job.totalRows,
      totalRowsIsExact: job.totalRowsIsExact,
      processedRows: job.processedRows,
      validContacts: job.validContacts,
      invalidContacts: job.invalidContacts,
      duplicateContacts: job.duplicateContacts,
      suppressedContacts: job.suppressedContacts,
      percent: analysisPercent,
      throughputRowsPerSecond: throughput,
      estimatedSecondsRemaining:
        throughput > 0 ? Math.max(0, Math.ceil((job.totalRows - job.processedRows) / throughput)) : 0,
    },
    split: {
      ...computeSplitPlan(job.validContacts, job.contactsPerCampaign),
      groupName: job.groupName,
      campaignNamePattern: job.campaignNamePattern,
    },
    generation: {
      expectedCampaigns: job.expectedCampaigns,
      campaignsCreated: job.campaignsCreated,
      contactsAssigned: job.contactsAssigned,
      failedCampaigns: job.failedCampaigns,
      failedCampaignNumbers: job.failedCampaignNumbers || [],
      currentCampaignNumber: job.currentCampaignNumber,
      currentCampaignName: job.currentCampaignName,
      allocationComplete: job.allocationComplete,
      percent: generationPercent,
    },
    message,
    hasErrorReport: job.hasErrorReport,
  };

  return {
    id: String(job._id),
    organizationId: job.organizationId,
    createdBy: job.createdBy,
    groupName: job.groupName,
    campaignNamePattern: job.campaignNamePattern,
    fileName: job.fileName,
    fileSizeBytes: job.fileSizeBytes,
    fileType: job.fileType,
    uploadId: job.uploadId,
    contactsPerCampaign: job.contactsPerCampaign,
    mailboxId: job.mailboxId,
    senderAccountIds: job.senderAccountIds,
    status: job.status,
    phase: job.phase,
    errorMessage: job.errorMessage,
    hasErrorReport: job.hasErrorReport,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    analyzedAt: job.analyzedAt,
    generationStartedAt: job.generationStartedAt,
    completedAt: job.completedAt,
    cancellationRequestedAt: job.cancellationRequestedAt,
    progress,
  };
}

export class CampaignSplitService {
  /** In-process guard so one job never runs twice concurrently. */
  private readonly activeJobs = new Set<string>();

  async createJob(input: CreateSplitJobInput): Promise<ICampaignSplitJob> {
    const resolved = resolveUploadedFilePath(input.uploadId);
    if (!resolved) {
      throw new AppError('Uploaded file not found or expired. Please re-upload.', 400, 'FILE_NOT_FOUND');
    }

    const inspection = await inspectSpreadsheetFile(resolved.filePath, input.fileName, {
      maxPreviewRows: 1,
    });
    assertRowLimit(inspection.totalRows, env.IMPORT_MAX_ROWS);
    if (inspection.totalRows === 0) {
      throw new AppError('No contacts detected in the uploaded file.', 400, 'EMPTY_FILE');
    }

    const contactsPerCampaign = clampBatch(
      input.contactsPerCampaign ?? env.CAMPAIGN_SPLIT_DEFAULT_CONTACTS_PER_CAMPAIGN,
      env.CAMPAIGN_SPLIT_DEFAULT_CONTACTS_PER_CAMPAIGN,
      10000
    );
    const plan = computeSplitPlan(0, contactsPerCampaign);
    const fileSizeBytes = await fs.promises
      .stat(resolved.filePath)
      .then((stats) => stats.size)
      .catch(() => 0);

    const job = await CampaignSplitJob.create({
      organizationId: input.organizationId,
      createdBy: input.actorId,
      groupName: input.groupName.trim(),
      campaignNamePattern: input.campaignNamePattern || '{group} – Campaign {number}',
      fileName: input.fileName,
      fileSizeBytes,
      uploadId: input.uploadId,
      storedFilePath: resolved.filePath,
      fileType: inspection.fileType,
      totalRows: inspection.totalRows,
      totalRowsIsExact: inspection.totalRowsIsExact,
      status: 'queued',
      phase: 'analysis',
      contactsPerCampaign,
      expectedCampaigns: plan.expectedCampaigns,
      lastCampaignContacts: plan.lastCampaignContacts,
      mailboxId: input.mailboxId.toLowerCase(),
      senderAccountIds: input.senderAccountIds || [],
      tone: input.tone || 'consultative',
      generationMode: input.generationMode || 'template',
      targetService: input.targetService,
      steps: (input.steps || []).map((step, index) => ({
        stepIndex: index,
        subject: step.subject,
        bodyText: step.bodyText,
        delayDays: step.delayDays ?? 0,
      })),
      columnMapping: input.columnMapping,
      customFieldMapping: input.customFieldMapping || {},
      scaleType: input.scaleType || 'standard',
    });

    this.kickOffAnalysis(String(job._id));
    return job;
  }

  private kickOffAnalysis(jobId: string): void {
    const run = () => {
      void this.runAnalysis(jobId).catch((err) => {
        console.error(`[campaign-split] analysis failed for ${jobId}:`, err);
      });
    };
    if (typeof setImmediate === 'function') setImmediate(run);
    else setTimeout(run, 0);
  }

  private kickOffGeneration(jobId: string): void {
    const run = () => {
      void this.runGeneration(jobId).catch((err) => {
        console.error(`[campaign-split] generation failed for ${jobId}:`, err);
      });
    };
    if (typeof setImmediate === 'function') setImmediate(run);
    else setTimeout(run, 0);
  }

  async getJob(organizationId: string, jobId: string): Promise<ICampaignSplitJob> {
    if (!mongoose.isValidObjectId(jobId)) {
      throw new AppError('Import job not found.', 404, 'JOB_NOT_FOUND');
    }
    const job = await CampaignSplitJob.findOne({ _id: jobId, organizationId });
    if (!job) throw new AppError('Import job not found.', 404, 'JOB_NOT_FOUND');
    return job;
  }

  /**
   * Saves the confirmed split plan (contacts per campaign, group name, naming
   * pattern) after analysis. Generation is a separate call so the operator can
   * review the exact preview first.
   */
  async confirmPlan(
    organizationId: string,
    jobId: string,
    input: { contactsPerCampaign: number; groupName?: string; campaignNamePattern?: string }
  ): Promise<ICampaignSplitJob> {
    const job = await this.getJob(organizationId, jobId);
    if (job.status !== 'ready' && job.status !== 'completed_with_errors') {
      throw new AppError('Wait for contact analysis to finish before confirming the split.', 409, 'ANALYSIS_NOT_READY');
    }
    if (!job.validContacts) {
      throw new AppError('This file has no eligible contacts to split.', 400, 'NO_VALID_CONTACTS');
    }
    const contactsPerCampaign = clampBatch(input.contactsPerCampaign, job.contactsPerCampaign, 10000);

    // Once any child campaign exists, contacts are already reserved against the
    // original batch size. Changing it would renumber assignments and could put a
    // contact in a different campaign than the one it was created in.
    if (job.status === 'completed_with_errors' && contactsPerCampaign !== job.contactsPerCampaign) {
      throw new AppError(
        'The split size cannot change after campaign generation has started. Retry the failed campaigns instead.',
        409,
        'SPLIT_LOCKED'
      );
    }

    const plan = computeSplitPlan(job.validContacts, contactsPerCampaign);

    job.contactsPerCampaign = contactsPerCampaign;
    job.expectedCampaigns = plan.expectedCampaigns;
    job.lastCampaignContacts = plan.lastCampaignContacts;
    if (input.groupName && input.groupName.trim()) job.groupName = input.groupName.trim();
    if (input.campaignNamePattern && input.campaignNamePattern.includes('{number}')) {
      job.campaignNamePattern = input.campaignNamePattern;
    }
    await job.save();
    return job;
  }

  async startGeneration(organizationId: string, jobId: string): Promise<ICampaignSplitJob> {
    const job = await this.getJob(organizationId, jobId);
    if (!job.validContacts) {
      throw new AppError('This file has no eligible contacts to split.', 400, 'NO_VALID_CONTACTS');
    }
    if (!['ready', 'completed_with_errors', 'failed'].includes(job.status)) {
      throw new AppError(
        job.status === 'generating'
          ? 'Campaign generation is already running.'
          : 'Campaign generation cannot start from the current state.',
        409,
        'INVALID_JOB_STATE'
      );
    }
    if (job.status === 'failed' && job.phase === 'analysis') {
      throw new AppError('Analysis failed. Retry the analysis first.', 409, 'ANALYSIS_FAILED');
    }

    const plan = computeSplitPlan(job.validContacts, job.contactsPerCampaign);
    job.expectedCampaigns = plan.expectedCampaigns;
    job.lastCampaignContacts = plan.lastCampaignContacts;
    job.status = 'generating';
    job.phase = 'generation';
    job.errorMessage = undefined;
    job.generationStartedAt = job.generationStartedAt || new Date();
    job.completedAt = undefined;
    job.failedCampaigns = 0;
    job.failedCampaignNumbers = [];
    job.heartbeatAt = new Date();
    await job.save();

    this.kickOffGeneration(String(job._id));
    return job;
  }

  async requestCancellation(
    organizationId: string,
    jobId: string,
    actorId: string
  ): Promise<ICampaignSplitJob> {
    const job = await this.getJob(organizationId, jobId);
    if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status)) {
      return job;
    }
    job.status = 'cancellation_requested';
    job.cancellationRequestedAt = new Date();
    job.cancelledBy = actorId;
    job.heartbeatAt = new Date();
    await job.save();
    return job;
  }

  /**
   * Retries a failed or partially failed import. Analysis is restarted from its
   * durable checkpoint; generation is restarted idempotently (existing child
   * campaigns and recipients are reused, never duplicated).
   */
  async retry(organizationId: string, jobId: string): Promise<ICampaignSplitJob> {
    const job = await this.getJob(organizationId, jobId);
    if (job.status === 'cancelled') {
      throw new AppError('Cancelled imports cannot be retried. Start a new import.', 409, 'JOB_CANCELLED');
    }
    if (job.phase === 'analysis' && job.status === 'failed') {
      job.status = 'queued';
      job.phase = 'analysis';
      job.errorMessage = undefined;
      job.heartbeatAt = new Date();
      await job.save();
      this.kickOffAnalysis(String(job._id));
      return job;
    }
    if (
      job.phase === 'generation' &&
      ['failed', 'completed_with_errors'].includes(job.status)
    ) {
      return this.startGeneration(organizationId, jobId);
    }
    throw new AppError('This import does not need a retry.', 409, 'RETRY_NOT_APPLICABLE');
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  async runAnalysis(jobId: string): Promise<void> {
    if (this.activeJobs.has(jobId)) return;
    this.activeJobs.add(jobId);
    try {
      const job = await CampaignSplitJob.findById(jobId);
      if (!job) return;
      if (!['queued', 'analyzing'].includes(job.status)) return;

      job.status = 'analyzing';
      job.phase = 'analysis';
      job.startedAt = job.startedAt || new Date();
      job.errorMessage = undefined;
      job.heartbeatAt = new Date();
      await job.save();

      let filePath = job.storedFilePath;
      let fileType: 'csv' | 'xlsx' =
        job.fileType || detectSpreadsheetType(job.fileName || job.storedFilePath || '');
      if (!filePath || !fs.existsSync(filePath)) {
        const resolved = job.uploadId ? resolveUploadedFilePath(job.uploadId) : null;
        if (!resolved) {
          throw new AppError('The uploaded file is no longer available. Please re-upload.', 410, 'FILE_EXPIRED');
        }
        filePath = resolved.filePath;
        fileType = resolved.fileType;
        job.storedFilePath = filePath;
        job.fileType = fileType;
        await job.save();
      }

      const batchSize = clampBatch(env.CSV_IMPORT_BATCH_SIZE, ANALYSIS_PAGE_SIZE, 10000);
      const mapping = job.columnMapping as unknown as ColumnMapping;
      const customFieldMapping = (job.customFieldMapping || {}) as Record<string, string>;
      const scaleType = job.scaleType || 'standard';

      let processedRows = job.processedRows || 0;
      let checkpoint = job.lastProcessedRow || 0;
      let validContacts = job.validContacts || 0;
      let invalidContacts = job.invalidContacts || 0;
      let duplicateContacts = job.duplicateContacts || 0;
      let suppressedContacts = job.suppressedContacts || 0;
      let batch: { rowNumber: number; raw: Record<string, string> }[] = [];
      let cancelled = false;
      const startedAtMs = Date.now();

      const flush = async () => {
        if (batch.length === 0) return;

        const pendingErrors: { row: number; field: string; reason: string }[] = [];
        const candidates: {
          rowNumber: number;
          raw: Record<string, string>;
          cleaned: Record<string, any>;
          email: string;
          customFields: Record<string, string>;
        }[] = [];
        const batchSeenEmails = new Set<string>();
        const batchValidEmails = new Set<string>();

        for (const item of batch) {
          const parsed = normalizeParsedRow(
            item.raw,
            item.rowNumber,
            mapping,
            createDuplicateSets(),
            scaleType
          );
          const cleaned = parsed.cleaned as unknown as Record<string, any>;
          const email = (cleaned.contact_email || '').trim().toLowerCase();

          if (parsed.errors.length > 0) {
            for (const error of parsed.errors) {
              pendingErrors.push({ row: item.rowNumber, field: error.field, reason: error.reason });
            }
            continue;
          }
          if (!email) {
            pendingErrors.push({
              row: item.rowNumber,
              field: 'contact_email',
              reason: 'Recipient contact email is missing',
            });
            continue;
          }

          const { customFields, truncatedCopyKeys } =
            extractStagingCustomFields(cleaned, item.raw, customFieldMapping);
          if (truncatedCopyKeys.length > 0) {
            pendingErrors.push({
              row: item.rowNumber,
              field: 'step_body',
              reason: `Imported copy for ${truncatedCopyKeys.join(', ')} exceeds the supported limit of ${MAX_TEMPLATE_LENGTH} characters.`,
            });
            continue;
          }

          if (batchSeenEmails.has(email)) {
            duplicateContacts++;
            continue;
          }
          batchSeenEmails.add(email);
          candidates.push({ rowNumber: item.rowNumber, raw: item.raw, cleaned, email, customFields });
          batchValidEmails.add(email);
        }

        if (pendingErrors.length > 0) {
          invalidContacts += pendingErrors.length;
          await appendRowErrorsToDisk(jobId, pendingErrors).catch(() => {});
        }

        // Cross-batch duplicates: an e-mail already staged from an earlier row.
        const emailList = Array.from(batchValidEmails);
        const existingByEmail = new Map<string, number>();
        const suppressionEmails = new Set<string>();
        if (emailList.length > 0) {
          const pageSize = 500;
          for (let i = 0; i < emailList.length; i += pageSize) {
            const slice = emailList.slice(i, i + pageSize);
            const [existing, suppressed] = await Promise.all([
              CampaignStagingContact.find({ jobId: job._id, email: { $in: slice } })
                .select('email rowNumber')
                .lean(),
              Suppression.find({ organizationId: job.organizationId, email: { $in: slice } })
                .select('email')
                .lean(),
            ]);
            for (const doc of existing) {
              const current = existingByEmail.get(doc.email);
              if (current === undefined || doc.rowNumber < current) {
                existingByEmail.set(doc.email, doc.rowNumber);
              }
            }
            for (const doc of suppressed) suppressionEmails.add(doc.email);
          }
        }

        const stagingDocs: Record<string, unknown>[] = [];
        for (const candidate of candidates) {
          const earlierRow = existingByEmail.get(candidate.email);
          if (earlierRow !== undefined && earlierRow < candidate.rowNumber) {
            duplicateContacts++;
            continue;
          }
          if (suppressionEmails.has(candidate.email)) {
            suppressedContacts++;
            continue;
          }

          const cleaned = candidate.cleaned;
          const fullName =
            cleaned.contact_full_name ||
            [cleaned.contact_first_name, cleaned.contact_last_name].filter(Boolean).join(' ') ||
            undefined;

          stagingDocs.push({
            organizationId: job.organizationId,
            jobId: job._id,
            rowNumber: candidate.rowNumber,
            email: candidate.email,
            name: fullName,
            companyName: cleaned.company_name,
            data: compactStagingData(cleaned),
            customFields: candidate.customFields,
            status: 'staged',
          });
          validContacts++;
        }

        if (stagingDocs.length > 0) {
          // Upsert rather than insert so a crash-replayed batch is a no-op and
          // never fails the whole run with duplicate-key errors.
          await CampaignStagingContact.bulkWrite(
            stagingDocs.map((doc) => ({
              updateOne: {
                filter: { jobId: job._id, rowNumber: doc.rowNumber as number },
                update: { $setOnInsert: doc },
                upsert: true,
              },
            })),
            { ordered: false }
          );
        }

        const lastRow = batch[batch.length - 1].rowNumber;
        processedRows = lastRow;
        checkpoint = lastRow;
        batch = [];

        const elapsedSec = Math.max(0.1, (Date.now() - startedAtMs) / 1000);
        const throughput = Math.round(processedRows / elapsedSec);

        const live = await CampaignSplitJob.findById(job._id).select('status').lean();
        if (!live || isCancellationRequested(live.status)) {
          cancelled = true;
          return;
        }

        await CampaignSplitJob.updateOne(
          { _id: job._id },
          {
            $set: {
              processedRows,
              lastProcessedRow: checkpoint,
              validContacts,
              invalidContacts,
              duplicateContacts,
              suppressedContacts,
              analysisThroughputRowsPerSecond: throughput,
              heartbeatAt: new Date(),
            },
          }
        );
      };

      const stream = createSpreadsheetRowStream(filePath, fileType, {
        highWaterMark: Math.min(1000, batchSize),
      });

      for await (const row of stream.rows) {
        if (row.rowNumber <= checkpoint) continue;
        batch.push(row);
        if (batch.length >= batchSize) {
          await flush();
          if (cancelled) break;
        }
      }
      if (!cancelled) await flush();

      if (cancelled) {
        await CampaignSplitJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'cancelled',
              phase: 'done',
              cancelledAt: new Date(),
              heartbeatAt: new Date(),
            },
          }
        );
        return;
      }

      if (processedRows === 0) {
        await CampaignSplitJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'failed',
              phase: 'analysis',
              errorMessage: 'No contact rows were found in this file.',
              heartbeatAt: new Date(),
            },
          }
        );
        return;
      }

      const errorReport = getJobErrorReportPath(jobId);
      const plan = computeSplitPlan(validContacts, job.contactsPerCampaign);
      await CampaignSplitJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'ready',
            phase: 'ready',
            totalRows: processedRows,
            totalRowsIsExact: true,
            processedRows,
            lastProcessedRow: checkpoint,
            validContacts,
            invalidContacts,
            duplicateContacts,
            suppressedContacts,
            expectedCampaigns: plan.expectedCampaigns,
            lastCampaignContacts: plan.lastCampaignContacts,
            analyzedAt: new Date(),
            hasErrorReport: Boolean(errorReport),
            errorReportPath: errorReport || undefined,
            heartbeatAt: new Date(),
          },
        }
      );
    } catch (err: any) {
      await CampaignSplitJob.updateOne(
        { _id: jobId },
        {
          $set: {
            status: 'failed',
            phase: 'analysis',
            errorMessage: err?.message || 'Contact analysis failed.',
            heartbeatAt: new Date(),
          },
        }
      ).catch(() => {});
      throw err;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  private async assignCampaignNumbers(job: ICampaignSplitJob): Promise<boolean> {
    const cpc = job.contactsPerCampaign;
    const expectedCampaigns = job.expectedCampaigns;
    let assignedBefore = await CampaignStagingContact.countDocuments({
      jobId: job._id,
      assignedCampaignNumber: { $ne: null },
    });
    let campaignNumber = Math.floor(assignedBefore / cpc) + 1;
    let positionInCampaign = assignedBefore % cpc;
    let cursor = job.allocationCheckpointRow || 0;

    const flushGroup = async (group: { number: number; ids: mongoose.Types.ObjectId[] } | null) => {
      if (!group || group.ids.length === 0) return;
      await CampaignStagingContact.updateMany(
        { _id: { $in: group.ids }, assignedCampaignNumber: null },
        { $set: { assignedCampaignNumber: group.number } }
      );
    };

    while (true) {
      const page = await CampaignStagingContact.find({
        jobId: job._id,
        rowNumber: { $gt: cursor },
      })
        .sort({ rowNumber: 1 })
        .limit(ALLOCATION_PAGE_SIZE)
        .select('_id rowNumber assignedCampaignNumber')
        .lean();
      if (page.length === 0) break;

      let group: { number: number; ids: mongoose.Types.ObjectId[] } | null = null;
      for (const doc of page) {
        cursor = doc.rowNumber;
        if (doc.assignedCampaignNumber !== undefined && doc.assignedCampaignNumber !== null) continue;
        if (campaignNumber > expectedCampaigns) break;

        if (!group || group.number !== campaignNumber) {
          await flushGroup(group);
          group = { number: campaignNumber, ids: [] };
        }
        group.ids.push(doc._id as mongoose.Types.ObjectId);
        positionInCampaign++;
        if (positionInCampaign >= cpc) {
          await flushGroup(group);
          group = null;
          campaignNumber++;
          positionInCampaign = 0;
        }
      }
      await flushGroup(group);

      await CampaignSplitJob.updateOne(
        { _id: job._id },
        { $set: { allocationCheckpointRow: cursor, heartbeatAt: new Date() } }
      );

      const live = await CampaignSplitJob.findById(job._id).select('status').lean();
      if (!live || isCancellationRequested(live.status)) return false;
      if (page.length < ALLOCATION_PAGE_SIZE) break;
    }

    // Re-count rather than trusting the in-memory cursor: a stale checkpoint
    // can re-scan already assigned rows, and that is harmless by design.
    assignedBefore = await CampaignStagingContact.countDocuments({
      jobId: job._id,
      assignedCampaignNumber: { $ne: null },
    });
    await CampaignSplitJob.updateOne(
      { _id: job._id },
      {
        $set: {
          allocationComplete: true,
          allocationCheckpointRow: cursor,
          heartbeatAt: new Date(),
        },
      }
    );
    if (assignedBefore !== job.validContacts) {
      console.warn(
        `[campaign-split] ${job._id}: allocated ${assignedBefore} contacts but analysis counted ${job.validContacts}`
      );
    }
    return true;
  }

  private async generateOneCampaign(
    job: ICampaignSplitJob,
    campaignNumber: number,
    roster: ICampaignSenderAccount[]
  ): Promise<{ createdNow: boolean; newRecipients: number; totalRecipients: number }> {
    const plan = computeSplitPlan(job.validContacts, job.contactsPerCampaign);
    const expectedForCampaign = Math.min(
      job.contactsPerCampaign,
      Math.max(0, job.validContacts - (campaignNumber - 1) * job.contactsPerCampaign)
    );
    if (expectedForCampaign <= 0) {
      return { createdNow: false, newRecipients: 0, totalRecipients: 0 };
    }

    const name = buildChildCampaignName(
      job.campaignNamePattern,
      job.groupName,
      campaignNumber,
      plan.expectedCampaigns
    );

    let campaign = await Campaign.findOne({
      organizationId: job.organizationId,
      parentImportId: job._id,
      campaignNumber,
    });
    let createdNow = false;
    if (!campaign) {
      try {
        campaign = await Campaign.create({
          organizationId: job.organizationId,
          name,
          status: 'draft',
          mailboxId: job.mailboxId,
          senderAccounts: roster,
          tone: job.tone,
          generationMode: job.generationMode,
          targetService: job.targetService,
          steps: job.steps.map((step, index) => ({
            stepIndex: index,
            subject: step.subject,
            bodyText: step.bodyText,
            delayDays: step.delayDays ?? 0,
          })),
          customFieldMapping: job.customFieldMapping,
          columnMapping: job.columnMapping,
          parentImportId: job._id,
          campaignNumber,
          groupName: job.groupName,
          createdBy: job.createdBy,
          stats: {
            totalRecipients: 0,
            prepared: 0,
            sent: 0,
            failed: 0,
            skipped: 0,
            replied: 0,
          },
          generationCursor: 0,
          sendCursor: 0,
        });
        createdNow = true;
      } catch (err: any) {
        if (err?.code === 11000) {
          campaign = await Campaign.findOne({
            organizationId: job.organizationId,
            parentImportId: job._id,
            campaignNumber,
          });
        } else {
          throw err;
        }
      }
    }
    if (!campaign) throw new AppError('Failed to create child campaign.', 500, 'CAMPAIGN_CREATE_FAILED');

    const { newRecipients, totalRecipients } = await this.backfillCampaignRecipients(
      job,
      campaign,
      campaignNumber,
      expectedForCampaign
    );

    if (
      roster.length > 0 &&
      campaign.status === 'draft' &&
      totalRecipients > 0 &&
      newRecipients > 0
    ) {
      try {
        await senderAllocationService.allocate(
          job.organizationId,
          String(campaign._id),
          job.createdBy
        );
      } catch (err: any) {
        // Roster allocation is retryable from the campaign page and must never
        // block or duplicate campaign/contact creation.
        console.warn(
          `[campaign-split] roster allocation failed for campaign ${campaign.campaignNumber}:`,
          err?.message || err
        );
      }
    }

    return { createdNow, newRecipients, totalRecipients };
  }

  /**
   * Idempotently writes the staging rows assigned to one campaign as
   * recipients. Generation and the operator-initiated repair share this path so
   * a partial or lost recipient set is always recoverable from the import.
   */
  private async backfillCampaignRecipients(
    job: ICampaignSplitJob,
    campaign: { _id: mongoose.Types.ObjectId; stats?: { totalRecipients?: number } },
    campaignNumber: number,
    expectedForCampaign: number
  ): Promise<{ newRecipients: number; totalRecipients: number }> {
    const existingRowNumbers = new Set<number>(
      (await CampaignRecipient.distinct('rowNumber', {
        organizationId: job.organizationId,
        campaignId: campaign._id,
      })) as number[]
    );

    let newRecipients = 0;
    let cursor = 0;

    while (existingRowNumbers.size < expectedForCampaign) {
      const contacts = await CampaignStagingContact.find({
        jobId: job._id,
        assignedCampaignNumber: campaignNumber,
        rowNumber: { $gt: cursor },
      })
        .sort({ rowNumber: 1 })
        .limit(RECIPIENT_BATCH_SIZE)
        .lean();
      if (contacts.length === 0) break;
      cursor = contacts[contacts.length - 1].rowNumber;

      const pending = contacts.filter((contact) => !existingRowNumbers.has(contact.rowNumber));
      const recipientDocs: Record<string, unknown>[] = [];
      const stagingIds: mongoose.Types.ObjectId[] = [];
      const crmByEmail = await this.ensureCrmRecordsBatch(job, pending);

      for (const contact of pending) {
        const resolved = crmByEmail.get(contact.email);
        if (!resolved) continue;
        recipientDocs.push({
          organizationId: job.organizationId,
          campaignId: campaign._id,
          rowNumber: contact.rowNumber,
          addedBy: job.createdBy,
          addedAt: new Date(),
          companyId: resolved.companyId,
          contactId: resolved.contactId,
          email: contact.email,
          name: contact.name,
          companyName: contact.companyName,
          customFields: contact.customFields || {},
          status: 'pending',
          completedSteps: 0,
          stepDrafts: (job.steps || []).map((_step, index) => ({
            stepIndex: index,
            status: 'pending',
          })),
        });
        stagingIds.push(contact._id as mongoose.Types.ObjectId);
        existingRowNumbers.add(contact.rowNumber);
      }

      if (recipientDocs.length > 0) {
        const result = await CampaignRecipient.bulkWrite(
          recipientDocs.map((doc) => ({
            updateOne: {
              filter: {
                organizationId: job.organizationId,
                campaignId: campaign._id,
                rowNumber: doc.rowNumber as number,
              },
              update: { $setOnInsert: doc },
              upsert: true,
            },
          })),
          { ordered: false }
        );
        newRecipients += result.upsertedCount || 0;
      }

      if (stagingIds.length > 0) {
        await CampaignStagingContact.updateMany(
          { _id: { $in: stagingIds } },
          { $set: { status: 'assigned', campaignId: campaign._id } }
        );
      }

      const live = await CampaignSplitJob.findById(job._id).select('status').lean();
      if (!live || isCancellationRequested(live.status)) break;
      if (contacts.length < RECIPIENT_BATCH_SIZE) break;
    }

    const totalRecipients = await CampaignRecipient.countDocuments({
      organizationId: job.organizationId,
      campaignId: campaign._id,
    });
    if ((campaign.stats?.totalRecipients ?? 0) !== totalRecipients) {
      await Campaign.updateOne(
        { _id: campaign._id },
        { $set: { 'stats.totalRecipients': totalRecipients } }
      );
    }

    return { newRecipients, totalRecipients };
  }

  /**
   * Reconciliation is only meaningful once every staging row has been assigned
   * to a campaign, and it must never race a running generation.
   */
  private assertRecipientIntegrityAvailable(job: ICampaignSplitJob, jobId: string): void {
    if (
      ['queued', 'analyzing', 'generating', 'cancellation_requested'].includes(job.status) ||
      this.activeJobs.has(jobId)
    ) {
      throw new AppError(
        'Wait for this import to finish before checking recipients.',
        409,
        'JOB_ACTIVE'
      );
    }
    if (!job.allocationComplete) {
      throw new AppError(
        'Recipients can be checked and repaired only after contacts have been assigned to campaigns.',
        409,
        'RECIPIENTS_NOT_ALLOCATED'
      );
    }
  }

  private async countStagingByCampaign(
    organizationId: string,
    jobId: mongoose.Types.ObjectId
  ): Promise<Map<number, number>> {
    const rows = await CampaignStagingContact.aggregate([
      { $match: { organizationId, jobId, assignedCampaignNumber: { $ne: null } } },
      { $group: { _id: '$assignedCampaignNumber', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map((row) => [Number(row._id), Number(row.count)]));
  }

  /**
   * Compares each child campaign's recipients with its durable staging rows.
   * Read-only: safe to run at any time the import is not active.
   */
  async auditRecipients(organizationId: string, jobId: string): Promise<RecipientIntegrityReport> {
    const job = await this.getJob(organizationId, jobId);
    this.assertRecipientIntegrityAvailable(job, String(job._id));
    return this.buildRecipientIntegrityReport(job);
  }

  /**
   * Restores recipients that are missing from child campaigns, using the
   * staging rows retained from the split analysis. Never deletes recipients and
   * never recreates deleted campaigns, so an operator's later edits survive.
   */
  async repairRecipients(organizationId: string, jobId: string): Promise<RecipientIntegrityReport> {
    const job = await this.getJob(organizationId, jobId);
    this.assertRecipientIntegrityAvailable(job, String(job._id));

    const campaigns = await Campaign.find({
      organizationId: job.organizationId,
      parentImportId: job._id,
    })
      .select('_id campaignNumber name status stats')
      .sort({ campaignNumber: 1 })
      .lean();

    const expectedByNumber = await this.countStagingByCampaign(job.organizationId, job._id);
    const repairedByCampaign = new Map<string, number>();
    let repairedCampaigns = 0;

    for (const campaign of campaigns) {
      const campaignNumber = campaign.campaignNumber;
      if (!campaignNumber) continue;
      const expected = expectedByNumber.get(campaignNumber) || 0;
      if (expected <= 0) continue;

      const actualBefore = await CampaignRecipient.countDocuments({
        organizationId: job.organizationId,
        campaignId: campaign._id,
      });
      const statsBefore = campaign.stats?.totalRecipients || 0;

      let newRecipients = 0;
      if (actualBefore < expected) {
        const result = await this.backfillCampaignRecipients(
          job,
          campaign,
          campaignNumber,
          expected
        );
        newRecipients = result.newRecipients;
      } else if (statsBefore !== actualBefore) {
        await Campaign.updateOne(
          { _id: campaign._id },
          { $set: { 'stats.totalRecipients': actualBefore } }
        );
      }

      if (newRecipients > 0) repairedByCampaign.set(String(campaign._id), newRecipients);
      if (newRecipients > 0 || statsBefore !== actualBefore) repairedCampaigns++;
    }

    const report = await this.buildRecipientIntegrityReport(job, { repairedByCampaign });
    report.repaired = repairedCampaigns > 0;
    report.repairedCampaigns = repairedCampaigns;
    report.repairedRecipients = Array.from(repairedByCampaign.values()).reduce(
      (sum, count) => sum + count,
      0
    );
    return report;
  }

  private async buildRecipientIntegrityReport(
    job: ICampaignSplitJob,
    options: { repairedByCampaign?: Map<string, number> } = {}
  ): Promise<RecipientIntegrityReport> {
    const campaigns = await Campaign.find({
      organizationId: job.organizationId,
      parentImportId: job._id,
    })
      .select('_id campaignNumber name status stats')
      .sort({ campaignNumber: 1 })
      .lean();

    const campaignIds = campaigns.map((campaign) => campaign._id);
    const recipientCounts =
      campaignIds.length > 0
        ? await CampaignRecipient.aggregate([
            {
              $match: {
                organizationId: job.organizationId,
                campaignId: { $in: campaignIds },
              },
            },
            { $group: { _id: '$campaignId', count: { $sum: 1 } } },
          ])
        : [];
    const actualById = new Map(
      recipientCounts.map((row) => [String(row._id), Number(row.count)])
    );
    const expectedByNumber = await this.countStagingByCampaign(job.organizationId, job._id);

    const rows: RecipientIntegrityCampaign[] = campaigns.map((campaign) => {
      const campaignNumber = campaign.campaignNumber || 0;
      const expected = expectedByNumber.get(campaignNumber) || 0;
      const actual = actualById.get(String(campaign._id)) || 0;
      const recorded = campaign.stats?.totalRecipients || 0;
      return {
        campaignId: String(campaign._id),
        campaignNumber,
        name: campaign.name,
        status: campaign.status,
        expectedRecipients: expected,
        actualRecipients: actual,
        missingRecipients: Math.max(0, expected - actual),
        extraRecipients: Math.max(0, actual - expected),
        recordedTotalRecipients: recorded,
        statsOutOfSync: recorded !== actual,
        repairedRecipients: options.repairedByCampaign?.get(String(campaign._id)) || 0,
      };
    });

    const existingNumbers = new Set(
      campaigns
        .map((campaign) => campaign.campaignNumber)
        .filter((value): value is number => typeof value === 'number')
    );
    const plannedCampaigns = Math.max(job.expectedCampaigns || 0, ...existingNumbers, 0);
    const absentCampaignNumbers: number[] = [];
    for (let number = 1; number <= plannedCampaigns; number++) {
      if (!existingNumbers.has(number)) absentCampaignNumbers.push(number);
    }

    return {
      jobId: String(job._id),
      jobStatus: job.status,
      checkedAt: new Date(),
      campaignCount: rows.length,
      plannedCampaigns,
      expectedRecipients: rows.reduce((sum, row) => sum + row.expectedRecipients, 0),
      actualRecipients: rows.reduce((sum, row) => sum + row.actualRecipients, 0),
      missingRecipients: rows.reduce((sum, row) => sum + row.missingRecipients, 0),
      extraRecipients: rows.reduce((sum, row) => sum + row.extraRecipients, 0),
      campaignsWithDrift: rows.filter(
        (row) => row.missingRecipients > 0 || row.extraRecipients > 0
      ).length,
      campaignsWithStatsDrift: rows.filter((row) => row.statsOutOfSync).length,
      absentCampaignNumbers,
      repaired: false,
      repairedCampaigns: 0,
      repairedRecipients: 0,
      campaigns: rows,
    };
  }

  /**
   * Resolves (and creates when missing) the CRM company/contact for a whole
   * recipient batch with two lookups and at most two bulk inserts. Doing this
   * per contact is what made large splits round-trip-bound.
   */
  private async ensureCrmRecordsBatch(
    job: ICampaignSplitJob,
    contacts: any[]
  ): Promise<Map<string, { companyId: mongoose.Types.ObjectId; contactId: mongoose.Types.ObjectId }>> {
    const resolved = new Map<
      string,
      { companyId: mongoose.Types.ObjectId; contactId: mongoose.Types.ObjectId }
    >();
    if (contacts.length === 0) return resolved;

    const emails = Array.from(new Set(contacts.map((contact) => String(contact.email).toLowerCase())));
    const domains = Array.from(
      new Set(
        contacts
          .map((contact) => (contact.data?.domain ? String(contact.data.domain).toLowerCase() : ''))
          .filter(Boolean)
      )
    );
    const names = Array.from(new Set(contacts.map((contact) => String(contact.companyName))));

    return withCrmLock(async () => {
      const companyOr: Record<string, unknown>[] = [];
      if (domains.length > 0) companyOr.push({ domain: { $in: domains } });
      if (names.length > 0) companyOr.push({ name: { $in: names } });

      const [existingCompanies, existingContacts] = await Promise.all([
        companyOr.length > 0
          ? Company.find({
              organizationId: job.organizationId,
              isArchived: false,
              $or: companyOr,
            }).lean()
          : Promise.resolve([] as any[]),
        CompanyContact.find({
          organizationId: job.organizationId,
          email: { $in: emails },
        }).lean(),
      ]);

      const companyByKey = new Map<string, any>();
      for (const company of existingCompanies) {
        if (company.domain) companyByKey.set(`domain:${company.domain.toLowerCase()}`, company);
        if (company.name) companyByKey.set(`name:${company.name.toLowerCase()}`, company);
      }
      const contactByEmail = new Map<string, any>(
        existingContacts.map((contact) => [contact.email, contact])
      );

      const missingCompanies = new Map<string, any>();
      const companyForContact = new Map<string, any>();

      for (const contact of contacts) {
        const data = (contact.data || {}) as Record<string, any>;
        const companyName = String(contact.companyName || 'Unknown company');
        const domain = data.domain ? String(data.domain).toLowerCase() : undefined;
        const nameKey = `name:${companyName.toLowerCase()}`;
        const domainKey = domain ? `domain:${domain}` : undefined;

        let company = (domainKey ? companyByKey.get(domainKey) : undefined) || companyByKey.get(nameKey);
        if (!company) {
          const creationKey = domainKey || nameKey;
          company = missingCompanies.get(creationKey);
          if (!company) {
            company = {
              _id: new mongoose.Types.ObjectId(),
              organizationId: job.organizationId,
              name: companyName,
              createdBy: job.createdBy,
              createdVia: 'csv_import',
              domain,
              websiteUrl: data.website_url,
              industry: data.industry,
              city: data.city,
              country: data.country,
              overallRating: data.rating || 'unrated',
              rawRating: data.raw_rating,
              notes: data.notes,
              services: Array.isArray(data.services) ? data.services : [],
              customFields: contact.customFields || {},
            };
            missingCompanies.set(creationKey, company);
            companyByKey.set(creationKey, company);
            companyByKey.set(nameKey, company);
            if (domainKey) companyByKey.set(domainKey, company);
          }
        }
        companyForContact.set(contact.email, company);
      }

      if (missingCompanies.size > 0) {
        await Company.insertMany(Array.from(missingCompanies.values()), { ordered: false });
      }

      const missingContacts: any[] = [];
      for (const contact of contacts) {
        const email = String(contact.email).toLowerCase();
        let companyContact = contactByEmail.get(email);
        if (!companyContact) {
          const data = (contact.data || {}) as Record<string, any>;
          const company = companyForContact.get(contact.email);
          companyContact = {
            _id: new mongoose.Types.ObjectId(),
            organizationId: job.organizationId,
            companyId: company._id,
            firstName: data.contact_first_name || undefined,
            lastName: data.contact_last_name || undefined,
            fullName: contact.name || data.contact_full_name || undefined,
            email,
            phone: data.contact_phone || undefined,
            role: data.contact_role || undefined,
            isPrimary: true,
          };
          missingContacts.push(companyContact);
          contactByEmail.set(email, companyContact);
        }
        resolved.set(email, {
          companyId: companyForContact.get(contact.email)._id,
          contactId: companyContact._id,
        });
      }

      if (missingContacts.length > 0) {
        await CompanyContact.insertMany(missingContacts, { ordered: false });
      }

      const assessmentOps: any[] = [];
      for (const contact of contacts) {
        const data = (contact.data || {}) as Record<string, any>;
        if (!data.rating || data.rating === 'unrated') continue;
        const companyId = companyForContact.get(contact.email)._id;
        assessmentOps.push({
          updateOne: {
            filter: {
              organizationId: job.organizationId,
              companyId,
              source: 'Campaign Import',
              normalizedRating: data.rating,
              notes: data.notes || null,
            },
            update: {
              $setOnInsert: {
                organizationId: job.organizationId,
                companyId,
                normalizedRating: data.rating,
                scaleUsed: 'csv_import',
                source: 'Campaign Import',
                notes: data.notes || undefined,
                assessmentDate: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
      if (assessmentOps.length > 0) {
        await CompanyAssessment.bulkWrite(assessmentOps, { ordered: false }).catch(() => {});
      }

      return resolved;
    });
  }

  private async syncGenerationCounters(
    job: ICampaignSplitJob,
    failedNumbers: Set<number>,
    currentCampaignNumber: number,
    currentCampaignName?: string
  ): Promise<void> {
    const [campaignsCreated, contactsAssigned] = await Promise.all([
      Campaign.countDocuments({
        organizationId: job.organizationId,
        parentImportId: job._id,
      }),
      CampaignStagingContact.countDocuments({ jobId: job._id, status: 'assigned' }),
    ]);
    await CampaignSplitJob.updateOne(
      { _id: job._id },
      {
        $set: {
          campaignsCreated,
          contactsAssigned,
          failedCampaigns: failedNumbers.size,
          failedCampaignNumbers: Array.from(failedNumbers).sort((a, b) => a - b).slice(0, 10000),
          currentCampaignNumber,
          currentCampaignName,
          heartbeatAt: new Date(),
        },
      }
    );
  }

  async runGeneration(jobId: string): Promise<void> {
    if (this.activeJobs.has(jobId)) return;
    this.activeJobs.add(jobId);
    try {
      const job = await CampaignSplitJob.findById(jobId);
      if (!job) return;
      if (!['generating', 'completed_with_errors', 'failed'].includes(job.status)) return;

      const plan = computeSplitPlan(job.validContacts, job.contactsPerCampaign);
      if (plan.expectedCampaigns === 0) {
        throw new AppError('No eligible contacts to split.', 400, 'NO_VALID_CONTACTS');
      }

      const roster =
        job.senderAccountIds && job.senderAccountIds.length > 0
          ? await senderAccountService.buildRoster(
              job.organizationId,
              job.senderAccountIds.map((accountId) => ({ accountId })),
              []
            )
          : [];

      if (!job.allocationComplete) {
        const completed = await this.assignCampaignNumbers(job);
        if (!completed) {
          await this.finalizeCancelled(job);
          return;
        }
        job.allocationComplete = true;
      }

      const failedNumbers = new Set<number>();
      let lastNumber = 0;
      let lastName: string | undefined;

      // Start from DB truth so a retried run never double-counts work.
      await this.syncGenerationCounters(job, failedNumbers, 0);

      for (
        let batchStart = 1;
        batchStart <= plan.expectedCampaigns;
        batchStart += CAMPAIGN_CREATION_BATCH_SIZE
      ) {
        const live = await CampaignSplitJob.findById(job._id).select('status').lean();
        if (!live || isCancellationRequested(live.status)) {
          await this.finalizeCancelled(job);
          return;
        }

        const batchNumbers: number[] = [];
        for (
          let n = batchStart;
          n < batchStart + CAMPAIGN_CREATION_BATCH_SIZE && n <= plan.expectedCampaigns;
          n++
        ) {
          batchNumbers.push(n);
        }

        await runWithConcurrency(batchNumbers, CAMPAIGN_CREATION_CONCURRENCY, async (number) => {
          const name = buildChildCampaignName(
            job.campaignNamePattern,
            job.groupName,
            number,
            plan.expectedCampaigns
          );
          let attempt = 0;
          while (true) {
            try {
              const result = await this.generateOneCampaign(job, number, roster);
              lastNumber = Math.max(lastNumber, number);
              lastName = name;
              if (result.createdNow || result.newRecipients > 0) {
                await CampaignSplitJob.updateOne(
                  { _id: job._id },
                  {
                    $inc: {
                      campaignsCreated: result.createdNow ? 1 : 0,
                      contactsAssigned: result.newRecipients,
                    },
                    $set: {
                      currentCampaignNumber: number,
                      currentCampaignName: name,
                      heartbeatAt: new Date(),
                    },
                  }
                );
              }
              return;
            } catch (err: any) {
              attempt++;
              if (attempt > CAMPAIGN_CREATION_MAX_RETRIES) {
                console.error(
                  `[campaign-split] campaign ${number} failed after ${attempt} attempts:`,
                  err?.message || err
                );
                failedNumbers.add(number);
                await CampaignSplitJob.updateOne(
                  { _id: job._id },
                  {
                    $set: {
                      failedCampaignNumbers: Array.from(failedNumbers).sort((a, b) => a - b),
                      failedCampaigns: failedNumbers.size,
                    },
                  }
                );
                return;
              }
              await sleep(Math.min(5000, 500 * 2 ** (attempt - 1)));
            }
          }
        });

        await this.syncGenerationCounters(job, failedNumbers, lastNumber, lastName);
      }

      const finalStatus = failedNumbers.size > 0 ? 'completed_with_errors' : 'completed';
      await this.syncGenerationCounters(job, failedNumbers, lastNumber, lastName);
      await CampaignSplitJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: finalStatus,
            phase: 'done',
            completedAt: new Date(),
            heartbeatAt: new Date(),
            allocationComplete: true,
          },
        }
      );
    } catch (err: any) {
      await CampaignSplitJob.updateOne(
        { _id: jobId },
        {
          $set: {
            status: 'failed',
            phase: 'generation',
            errorMessage: err?.message || 'Campaign generation failed.',
            heartbeatAt: new Date(),
          },
        }
      ).catch(() => {});
      throw err;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  private async finalizeCancelled(job: ICampaignSplitJob): Promise<void> {
    await this.syncGenerationCounters(job, new Set(), 0);
    await CampaignSplitJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'cancelled',
          phase: 'done',
          cancelledAt: new Date(),
          heartbeatAt: new Date(),
        },
      }
    );
  }

  /**
   * Resumes imports interrupted by a restart or crash. Pass `force` on boot
   * (this process cannot have a live worker yet); otherwise only jobs with a
   * stale heartbeat are resumed.
   */
  async recoverInterruptedJobs(options: { force?: boolean } = {}): Promise<number> {
    const staleBefore = new Date(Date.now() - STALE_JOB_MS);
    const jobs = await CampaignSplitJob.find({
      status: { $in: ['queued', 'analyzing', 'generating'] },
      ...(options.force
        ? {}
        : {
            $or: [{ heartbeatAt: { $lt: staleBefore } }, { heartbeatAt: { $exists: false } }],
          }),
    })
      .limit(25)
      .select('_id status')
      .lean();

    let resumed = 0;
    for (const job of jobs) {
      if (this.activeJobs.has(String(job._id))) continue;
      if (job.status === 'generating') {
        this.kickOffGeneration(String(job._id));
      } else {
        this.kickOffAnalysis(String(job._id));
      }
      resumed++;
    }
    return resumed;
  }
}

export const campaignSplitService = new CampaignSplitService();

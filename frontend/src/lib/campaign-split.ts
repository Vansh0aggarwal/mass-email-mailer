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

export interface CampaignSplitPlan {
  validContacts: number;
  contactsPerCampaign: number;
  expectedCampaigns: number;
  lastCampaignContacts: number;
}

export interface CampaignSplitAnalysisProgress {
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
}

export interface CampaignSplitGenerationProgress {
  expectedCampaigns: number;
  campaignsCreated: number;
  contactsAssigned: number;
  failedCampaigns: number;
  failedCampaignNumbers: number[];
  currentCampaignNumber?: number;
  currentCampaignName?: string;
  allocationComplete: boolean;
  percent: number;
}

export interface CampaignSplitProgress {
  analysis: CampaignSplitAnalysisProgress;
  split: CampaignSplitPlan & { groupName: string; campaignNamePattern: string };
  generation: CampaignSplitGenerationProgress;
  message: string;
  hasErrorReport: boolean;
}

export interface CampaignSplitJob {
  id: string;
  organizationId: string;
  createdBy: string;
  groupName: string;
  campaignNamePattern: string;
  fileName: string;
  fileSizeBytes: number;
  fileType?: 'csv' | 'xlsx';
  uploadId: string;
  contactsPerCampaign: number;
  mailboxId: string;
  senderAccountIds?: string[];
  status: CampaignSplitStatus;
  phase: CampaignSplitPhase;
  errorMessage?: string;
  hasErrorReport: boolean;
  createdAt: string;
  startedAt?: string;
  analyzedAt?: string;
  generationStartedAt?: string;
  completedAt?: string;
  cancellationRequestedAt?: string;
  progress: CampaignSplitProgress;
}

export interface SplitUploadResult {
  uploadId: string;
  fileName: string;
  fileSize: number;
  fileType: 'csv' | 'xlsx';
  headers: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  totalRowsIsExact: boolean;
  delimiter?: string;
}

export interface SplitChildCampaign {
  id: string;
  name: string;
  campaignNumber?: number;
  status: string;
  stats?: { totalRecipients?: number; sent?: number; replied?: number };
  createdAt: string;
  updatedAt?: string;
  schedule?: { startAt?: string; timezone?: string };
}

export interface SplitChildCampaignPage {
  campaigns: SplitChildCampaign[];
  total: number;
  page: number;
  limit: number;
  expectedCampaigns?: number;
  failedCampaignNumbers?: number[];
}

/** One child campaign compared with the contacts reserved for it. */
export interface SplitRecipientIntegrityCampaign {
  campaignId: string;
  campaignNumber: number;
  name: string;
  status: string;
  expectedRecipients: number;
  actualRecipients: number;
  missingRecipients: number;
  extraRecipients: number;
  recordedTotalRecipients: number;
  statsOutOfSync: boolean;
  repairedRecipients: number;
}

/** Operator-facing reconciliation report for one split import. */
export interface SplitRecipientIntegrity {
  jobId: string;
  jobStatus: CampaignSplitStatus;
  checkedAt: string;
  campaignCount: number;
  plannedCampaigns: number;
  expectedRecipients: number;
  actualRecipients: number;
  missingRecipients: number;
  extraRecipients: number;
  campaignsWithDrift: number;
  campaignsWithStatsDrift: number;
  absentCampaignNumbers: number[];
  repaired: boolean;
  repairedCampaigns: number;
  repairedRecipients: number;
  campaigns: SplitRecipientIntegrityCampaign[];
}

/** Presets offered on the split configuration screen. */
export const SPLIT_PRESETS = [100, 200, 500, 1000] as const;

export const DEFAULT_SPLIT_PATTERN = '{group} – Campaign {number}';

/**
 * Mirrors the backend split arithmetic exactly: campaignCount =
 * ceil(validContacts / contactsPerCampaign). Contacts are never confused with
 * campaigns.
 */
export function computeSplitPlan(validContacts: number, contactsPerCampaign: number): CampaignSplitPlan {
  const cpc = Math.max(1, Math.floor(Number(contactsPerCampaign) || 0));
  const valid = Math.max(0, Math.floor(Number(validContacts) || 0));
  if (valid === 0) {
    return { validContacts: 0, contactsPerCampaign: cpc, expectedCampaigns: 0, lastCampaignContacts: 0 };
  }
  const expectedCampaigns = Math.ceil(valid / cpc);
  return {
    validContacts: valid,
    contactsPerCampaign: cpc,
    expectedCampaigns,
    lastCampaignContacts: valid - (expectedCampaigns - 1) * cpc,
  };
}

/** Mirrors the backend child-campaign naming so the preview matches creation. */
export function buildChildCampaignName(
  pattern: string,
  groupName: string,
  campaignNumber: number,
  expectedCampaigns: number
): string {
  const width = Math.max(3, String(Math.max(1, expectedCampaigns)).length);
  const template = pattern.includes('{number}') ? pattern : DEFAULT_SPLIT_PATTERN;
  return template
    .replace(/\{group\}/g, groupName || '')
    .replace(/\{number\}/g, String(campaignNumber).padStart(width, '0'))
    .trim()
    .slice(0, 200);
}

export function isSplitJobActive(status: CampaignSplitStatus | undefined): boolean {
  return status === 'queued' || status === 'analyzing' || status === 'generating' || status === 'cancellation_requested';
}

export function isSplitJobTerminal(status: CampaignSplitStatus | undefined): boolean {
  return status === 'completed' || status === 'completed_with_errors' || status === 'failed' || status === 'cancelled';
}

export function splitStatusMeta(status: CampaignSplitStatus): { label: string; className: string } {
  switch (status) {
    case 'queued':
      return { label: 'Queued', className: 'badge-neutral' };
    case 'analyzing':
      return { label: 'Analyzing', className: 'badge-info' };
    case 'ready':
      return { label: 'Ready to split', className: 'badge-info' };
    case 'generating':
      return { label: 'Creating campaigns', className: 'badge-info' };
    case 'completed':
      return { label: 'Completed', className: 'badge-success' };
    case 'completed_with_errors':
      return { label: 'Completed with errors', className: 'badge-warning' };
    case 'failed':
      return { label: 'Failed', className: 'badge-danger' };
    case 'cancellation_requested':
      return { label: 'Cancelling', className: 'badge-warning' };
    case 'cancelled':
      return { label: 'Cancelled', className: 'badge-danger' };
    default:
      return { label: status, className: 'badge-neutral' };
  }
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const display =
    value >= 10 || exponent === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${display} ${units[exponent]}`;
}

export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Formats the contiguous row ranges assigned to campaign 1..N, used in previews. */
export function describeCampaignRange(
  campaignNumber: number,
  contactsPerCampaign: number,
  lastCampaignContacts: number,
  expectedCampaigns: number
): string {
  if (campaignNumber < 1 || campaignNumber > expectedCampaigns) return '—';
  const size = campaignNumber === expectedCampaigns ? lastCampaignContacts : contactsPerCampaign;
  const start = (campaignNumber - 1) * contactsPerCampaign + 1;
  const end = start + size - 1;
  return `Contacts ${start.toLocaleString()}–${end.toLocaleString()}`;
}

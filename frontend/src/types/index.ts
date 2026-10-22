export type AssessmentRating = 'A' | 'B' | 'C' | 'D' | 'F' | 'unrated';

export interface Company {
  _id: string;
  organizationId: string;
  name: string;
  domain?: string;
  websiteUrl?: string;
  industry?: string;
  city?: string;
  country?: string;
  overallRating: AssessmentRating;
  notes?: string;
  services: string[];
  customFields?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  _id: string;
  organizationId: string;
  companyId: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email: string;
  phone?: string;
  role?: string;
  isPrimary: boolean;
  isSuppressed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceItem {
  _id: string;
  organizationId: string;
  name: string;
  code: string;
  description: string;
  valueProposition: string;
  triggerKeywords: string[];
  isActive: boolean;
  defaultPriceRange?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationEvidence {
  type: 'explicit_need' | 'assessment' | 'keyword_match';
  reference: string;
  detail: string;
}

export interface OpportunityRecommendation {
  companyId: string;
  companyName: string;
  score: number;
  confidence: number;
  isQualified: boolean;
  recommendedServices: {
    serviceId: string;
    serviceName: string;
    reason: string;
  }[];
  ruleExplanations: string[];
  evidence: RecommendationEvidence[];
  missingDataWarnings: string[];
  pitchSummary: string;
}

export interface EmailTemplate {
  _id: string;
  organizationId: string;
  name: string;
  category: 'first_contact' | 'website_redesign' | 'social_media' | 'follow_up' | 'general';
  tone: 'professional' | 'friendly' | 'concise' | 'consultative' | 'urgent';
  subject: string;
  body: string;
  variables: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailDraft {
  _id: string;
  organizationId: string;
  companyId?: string;
  companyName?: string;
  contactId?: string;
  recipientEmail: string;
  recipientName?: string;
  subject: string;
  bodyText: string;
  tone: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'queued' | 'sending' | 'accepted' | 'failed' | 'unknown_outcome' | 'archived';
  recommendedServiceId?: string;
  recommendedServiceName?: string;
  recommendationExplanation?: string;
  factsUsed?: string[];
  missingInformation?: string[];
  warnings?: string[];
  companyNameMismatch?: string;
  unsupportedClaims?: string[];
  estimatedCostUsd?: number;
  isFallbackTemplate?: boolean;
  originalSubject?: string;
  originalBodyText?: string;
  isManualEdit?: boolean;
  generationSource?: 'csv_template' | 'personalized_template' | 'ai_grounded' | 'manual_edit';
  createdAt: string;
  updatedAt: string;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  mailboxId: string;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  subject: string;
  bodyText: string;
  snippet: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  companyId?: string;
  companyName?: string;
}

export interface EmailThread {
  id: string;
  mailboxId: string;
  subject: string;
  snippet: string;
  lastMessageDate: string;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  companyId?: string;
  companyName?: string;
  messages: EmailMessage[];
}

export interface FollowUpTask {
  _id: string;
  organizationId: string;
  companyId?: string;
  companyName?: string;
  contactEmail: string;
  threadId?: string;
  dueDate: string;
  notes: string;
  status: 'pending' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  createdAt: string;
  updatedAt: string;
}

export type ImportJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'pending'
  | 'validated'
  | 'cancellation_requested'
  | 'cancelling'
  | 'cancelled';

export interface ImportSummary {
  _id: string;
  organizationId: string;
  fileName: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  duplicateRows: number;
  importedCount: number;
  status: ImportJobStatus;
  createdAt: string;
  // Streaming job fields (present on jobs created via /imports/jobs)
  updatedCount?: number;
  processedRows?: number;
  invalidRows?: number;
  failedRows?: number;
  lastProcessedRow?: number;
  rowErrorCount?: number;
  fileBytes?: number;
  errorReportPath?: string;
  finishedAt?: string;
  cancellationRequestedAt?: string;
  cancelledAt?: string;
}

export interface CampaignImportJobProgressData {
  jobId: string;
  campaignId: string;
  campaignName: string;
  fileName?: string;
  status:
    | 'queued'
    | 'processing'
    | 'completed'
    | 'completed_with_errors'
    | 'failed'
    | 'cancellation_requested'
    | 'cancelling'
    | 'cancelled';
  phase?: string;
  isStalled?: boolean;
  stallSeconds?: number;
  totalRows: number;
  totalRowsIsExact?: boolean;
  processedRows: number;
  committedRows?: number;
  checkpointRow?: number;
  importedCount: number;
  skippedCount: number;
  failedRows: number;
  percent: number;
  currentRow?: number;
  currentRecipientEmail?: string;
  currentCompanyName?: string;
  throughputRowsPerSecond?: number;
  estimatedTimeRemainingSeconds?: number;
  fileSizeBytes?: number;
  uploadedBytes?: number;
  hasErrorReport?: boolean;
  message?: string;
  rowErrors?: Array<{ row: number; field: string; reason: string }>;
  errorMessage?: string;
  heartbeatAt?: string;
  cancellationRequestedAt?: string;
  cancelledAt?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface EmailAccount {
  _id: string;
  organizationId: string;
  userId?: string;
  emailAddress: string;
  displayName: string;
  provider: 'mock' | 'gmail' | 'smtp';
  status: 'connected' | 'paused' | 'error' | 'disconnected';
  googleSub?: string;
  grantedScopes?: string[];
  dailySendLimit: number;
  sendsToday: number;
  isPaused: boolean;
  pausedReason?: string;
  lastSyncedAt?: string;
  initialSyncCompleted?: boolean;
  historyId?: string;
  syncStatus?: 'idle' | 'syncing' | 'error';
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  avatarUrl?: string | null;
  googleSub?: string;
  isDevMock?: boolean;
}

export interface Organization {
  _id: string;
  name: string;
  slug: string;
  createdBy: string;
}

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

export interface CampaignStep {
  stepIndex: number;
  subject: string;
  bodyText: string;
  delayDays: number;
}

export interface CampaignStats {
  totalRecipients: number;
  prepared: number;
  sent: number;
  failed: number;
  skipped: number;
  replied?: number;
}

/** A connected Gmail account that may send a campaign. */
export interface SenderAccount {
  accountId: string;
  emailAddress: string;
  displayName: string;
  provider: string;
  status: string;
  isPaused: boolean;
  pausedReason?: string;
  /** True when the account may be used for outbound sends right now. */
  authorized: boolean;
  authorization: {
    authorized: boolean;
    reason?: string;
    reasonCode?: string;
  };
  dailySendLimit: number;
  sendsToday: number;
  reservedSends: number;
  remainingDailyAllowance: number;
  sendsThisHour: number;
  lastSendAt?: string;
  grantedScopes: string[];
  tokenExpiryDate?: string;
  lastSyncedAt?: string;
  connectedBy?: string;
  quota: {
    tokens: number;
    capacity: number;
    refillPerSecond: number;
    rateFactor: number;
    totalUnitsReserved: number;
  } | null;
}

/** One entry of a campaign's sender roster. */
export interface CampaignSenderAccount {
  accountId: string;
  emailAddress: string;
  displayName?: string;
  enabled: boolean;
  dailySendCap: number;
  maxPerHour: number;
  minIntervalSeconds: number;
  jitterSeconds: number;
  assignedCount: number;
  sentCount: number;
  lastSentAt?: string;
  nextSendAt?: string;
  unavailableReason?: string;
  unavailableReasonCode?: string;
  pausedAt?: string;
  lastError?: string;
}

/** Live state of a sender account inside a campaign's dispatch queue. */
export interface SenderQueueAccount {
  accountId: string;
  emailAddress: string;
  displayName?: string;
  enabled: boolean;
  authorized: boolean;
  reasonCode?: string;
  reason?: string;
  waiting: number;
  sent: number;
  dailySendCap: number;
  maxPerHour: number;
  minIntervalSeconds: number;
  jitterSeconds: number;
  effectiveDailyCap: number;
  effectiveMaxPerHour: number;
  sendsToday: number;
  sendsThisHour: number;
  reservedSends: number;
  nextSendAt?: string;
  lastSendAt?: string;
  ready: boolean;
}

export interface CampaignSchedule {
  startAt: string;
  timezone: string;
  batchSize: number;
  paceMinutes: number;
  windowStartHour?: number;
  windowEndHour?: number;
  /** Permitted weekdays (0 = Sunday ... 6 = Saturday). */
  allowedWeekdays?: number[];
  minIntervalSeconds?: number;
  jitterSeconds?: number;
  maxPerHour?: number;
  dailySendCap?: number;
  label?: string;
  scheduledBy?: string;
  scheduledAt?: string;
  lastRunAt?: string;
}

export interface Campaign {
  _id: string;
  organizationId: string;
  name: string;
  status: CampaignStatus;
  mailboxId: string;
  /** Connected Gmail accounts that participate in this campaign. */
  senderAccounts?: CampaignSenderAccount[];
  tone: string;
  generationMode: 'template' | 'ai';
  targetService?: string;
  schedule?: CampaignSchedule;
  repliesReceived?: number;
  lastError?: string;
  steps: CampaignStep[];
  customFieldMapping: Record<string, string>;
  columnMapping: Record<string, string>;
  stats: CampaignStats;
  createdAt: string;
  updatedAt: string;
}

/** Result of a roster allocation or rebalance. */
export interface AllocationResult {
  campaignId: string;
  eligibleRecipients: number;
  assignedRecipients: number;
  newlyAssigned: number;
  duplicatesSkipped: number;
  orphaned: number;
  migrated: number;
  assignmentsFrozen: boolean;
  lockedRecipients?: number;
  accounts: Array<{
    accountId: string;
    emailAddress: string;
    enabled: boolean;
    authorized: boolean;
    assigned: number;
    newlyAssigned: number;
    released: number;
    unavailableReason?: string;
  }>;
}

export interface RecipientStepDraft {
  stepIndex: number;
  draftId?: string;
  status: 'pending' | 'draft' | 'approved' | 'sent' | 'failed' | 'skipped';
  providerMessageId?: string;
  error?: string;
  sentAt?: string;
  scheduledAt?: string;
  draft?: EmailDraft | null;
}

export interface CampaignRecipient {
  _id: string;
  campaignId: string;
  rowNumber: number;
  email: string;
  name?: string;
  companyName?: string;
  customFields: Record<string, string>;
  status: 'pending' | 'prepared' | 'approved' | 'sending' | 'sent' | 'replied' | 'failed' | 'skipped' | 'suppressed';
  completedSteps: number;
  stepDrafts: RecipientStepDraft[];
  /** The connected mailbox this recipient is assigned to. */
  assignedAccountId?: string;
  assignedAccountEmail?: string;
  assignedAt?: string;
  /** True once a step was sent from the assigned account. */
  assignmentLocked?: boolean;
  lastSentAt?: string;
  replied?: boolean;
  repliedAt?: string;
  replyThreadId?: string;
  replySnippet?: string;
  replySubject?: string;
  replyFromEmail?: string;
  replyMailboxEmail?: string;
  skipReason?: string;
  canRetry?: boolean;
  lastError?: string;
}

export interface CampaignProgress {
  campaignId: string;
  name: string;
  status: CampaignStatus;
  totalRecipients: number;
  byStatus: Record<string, number>;
  sent: number;
  failed: number;
  skipped: number;
  repliesReceived?: number;
  schedule?: CampaignSchedule | null;
  lastError?: string;
  hasUngeneratedDrafts?: boolean;
}

export interface ReplyAssistantResult {
  _id?: string;
  subject?: string;
  bodyText: string;
  suggestedNextStep?: string;
  questionsForUser: string[];
  factsUsed: string[];
  missingInformation: string[];
  warnings: string[];
  isFallback?: boolean;
  provider?: string;
}

export interface CampaignPreview {
  headers: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  totalRowsIsExact?: boolean;
}

export interface WorkspaceSettings {
  _id?: string;
  organizationId: string;
  senderDisplayName: string;
  businessName: string;
  businessDescription: string;
  authorizedMailbox?: string;
  defaultGreeting: string;
  missingNameFallback: string;
  defaultSignOff: string;
  emailSignature: string;
  contactDetails: string;
  defaultTimezone: string;
  sendingWindowStartHour: number;
  sendingWindowEndHour: number;
  dailySendCap: number;
  batchSize: number;
  paceMinutes: number;
  defaultFollowUpIntervalDays: number;
  preferredTone: 'professional' | 'friendly' | 'concise' | 'consultative' | 'urgent';
  preferredLength: 'short' | 'medium' | 'detailed';
  preferredLanguage: string;
  defaultServiceOffering: string;
}

export interface CalendarAccount {
  _id: string;
  organizationId: string;
  userId: string;
  emailAddress: string;
  displayName: string;
  provider: 'google' | 'mock';
  status: 'connected' | 'error' | 'disconnected';
  grantedScopes?: string[];
  createdAt: string;
}

export interface ParsedMeetingResult {
  isAmbiguous: boolean;
  clarificationQuestions: string[];
  parsedDetails: {
    summary: string;
    durationMinutes: number;
    timezone: string;
    attendees: string[];
    addMeetLink: boolean;
  };
}

export interface CreatedCalendarEvent {
  eventId: string;
  htmlLink: string;
  meetLink?: string;
  summary: string;
  startTime: string;
  endTime: string;
  timezone: string;
  attendees: string[];
  provider: 'google' | 'mock';
}


import { CampaignRecipient } from '../types';

/**
 * Reads a value from a recipient's custom-field bag, tolerating both plain objects
 * (API JSON) and Map-like shapes. Returns the first non-empty, trimmed value.
 */
export function getRecipientCustomField(
  recipient: Pick<CampaignRecipient, 'customFields'>,
  keys: string[]
): string | undefined {
  const custom = recipient?.customFields;
  if (!custom) return undefined;
  const isMap = typeof (custom as any).get === 'function';
  for (const key of keys) {
    const value = isMap ? (custom as any).get(key) : (custom as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return undefined;
}

export interface AuditAnalysis {
  statusType: 'success' | 'warning' | 'danger' | 'neutral';
  headline: string;
  explanation: string;
}

/**
 * Interprets a website audit without ever asserting that a company lacks a website.
 * Timeouts and HTTP errors are reported as *unverified*, never as "missing".
 */
export function getAuditAnalysis(
  websiteStatus?: string,
  httpCode?: string,
  techSignal?: string
): AuditAnalysis {
  const code = (httpCode || '').trim();
  const status = (websiteStatus || '').trim().toLowerCase();

  if (code === '408' || code === '504' || status.includes('timeout') || status.includes('timed out')) {
    return {
      statusType: 'warning',
      headline: `Website status unverified (HTTP ${code || 'Timeout'})`,
      explanation:
        'The site timed out or the server could not be reached during the automated audit. This does not mean the company lacks a website.',
    };
  }
  if (code === '404' || status.includes('not found')) {
    return {
      statusType: 'danger',
      headline: 'Audit returned HTTP 404 Not Found',
      explanation:
        'The audit URL was not found on the web server. Verify whether a new domain or landing page is active.',
    };
  }
  if (code.startsWith('2') || status === 'live' || status === 'ok' || status === 'active') {
    return {
      statusType: 'success',
      headline: `Verified live website (HTTP ${code || '200'})`,
      explanation: techSignal ? `Detected tech signal: ${techSignal}` : 'Site was accessible during audit.',
    };
  }
  if (websiteStatus || httpCode) {
    return {
      statusType: 'neutral',
      headline: `Audit status: ${websiteStatus || `HTTP ${code}`}`,
      explanation: techSignal ? `Tech signal: ${techSignal}` : 'Recorded during domain inspection.',
    };
  }
  return {
    statusType: 'neutral',
    headline: 'No automated site audit recorded',
    explanation: 'Audit data was not provided in the uploaded dataset.',
  };
}

export interface TargetingEvidenceRow {
  label: string;
  value: string;
}

export interface TargetingEvidence {
  /** Primary outreach topic from the imported CSV, or null when not provided. */
  topic: string | null;
  /** True when the topic came from the CSV rather than a synthesis. */
  source: 'csv' | 'none';
  sector?: string;
  domain?: string;
  websiteStatus?: string;
  siteAuditType?: string;
  httpCode?: string;
  pageTitle?: string;
  primaryTechSignal?: string;
  audit: AuditAnalysis;
  /** Supporting evidence rows (source data), blanks omitted. */
  rows: TargetingEvidenceRow[];
}

/**
 * Builds the "why are we targeting this company?" evidence for a recipient.
 * The primary source is the CSV `Proposed Deliverable`; supporting evidence is the
 * imported sector + website audit columns. AI recommendations are surfaced separately
 * (see `getAiRecommendation`) so source data is never confused with AI output.
 */
export function getTargetingEvidence(recipient: CampaignRecipient): TargetingEvidence {
  const topic = getRecipientCustomField(recipient, ['proposed_deliverable', 'Proposed Deliverable', 'deliverable']);
  const sector = getRecipientCustomField(recipient, ['sector', 'Sector', 'industry', 'Industry']);
  const websiteStatus = getRecipientCustomField(recipient, ['website_status', 'Website Status']);
  const httpCode = getRecipientCustomField(recipient, ['http_code', 'HTTP Code', 'Http Code']);
  const siteAuditType = getRecipientCustomField(recipient, ['site_audit_type', 'Site Audit Type']);
  const pageTitle = getRecipientCustomField(recipient, ['page_title', 'Page Title']);
  const primaryTechSignal = getRecipientCustomField(recipient, ['primary_tech_signal', 'Primary Tech Signal']);
  const domain = getRecipientCustomField(recipient, ['domain', 'Domain', 'website_url', 'Website URL']);

  const rows: TargetingEvidenceRow[] = [];
  if (sector) rows.push({ label: 'Sector', value: sector });
  if (websiteStatus) rows.push({ label: 'Website status', value: websiteStatus });
  if (siteAuditType) rows.push({ label: 'Audit type', value: siteAuditType });
  if (httpCode) rows.push({ label: 'HTTP code', value: httpCode });
  if (pageTitle) rows.push({ label: 'Page title', value: pageTitle });
  if (primaryTechSignal) rows.push({ label: 'Tech signal', value: primaryTechSignal });

  return {
    topic: topic ?? null,
    source: topic ? 'csv' : 'none',
    sector,
    domain,
    websiteStatus,
    siteAuditType,
    httpCode,
    pageTitle,
    primaryTechSignal,
    audit: getAuditAnalysis(websiteStatus, httpCode, primaryTechSignal),
    rows,
  };
}

/**
 * Returns the AI-recommended service for a recipient (if any step draft carries one),
 * clearly distinguished from the CSV-sourced target topic.
 */
export function getAiRecommendation(recipient: CampaignRecipient): string | undefined {
  for (const slot of recipient.stepDrafts || []) {
    const name = (slot.draft as any)?.recommendedServiceName;
    if (name && String(name).trim()) return String(name).trim();
  }
  return undefined;
}

/** Returns the mismatch phrase flagged on any step draft of the recipient, if any. */
export function getCompanyNameMismatch(recipient: CampaignRecipient): string | undefined {
  for (const slot of recipient.stepDrafts || []) {
    const mismatch = (slot.draft as any)?.companyNameMismatch;
    if (mismatch && String(mismatch).trim()) return String(mismatch).trim();
  }
  return undefined;
}

export interface RecipientValidationIssues {
  companyNameMismatch?: string;
  unsupportedClaims: string[];
  unsupportedIncorporationClaim?: string;
  unsupportedWebsiteClaim?: string;
  personalizationWarning?: string;
  hasBlockingError: boolean;
  requiresReview: boolean;
}

/**
 * Derives comprehensive validation issues across all step drafts for a recipient.
 * Distinguishes blocking errors (mismatches) from advisory review warnings.
 */
export function getRecipientValidationIssues(recipient: CampaignRecipient): RecipientValidationIssues {
  let companyNameMismatch: string | undefined;
  const unsupportedClaims: string[] = [];
  let unsupportedIncorporationClaim: string | undefined;
  let unsupportedWebsiteClaim: string | undefined;
  let personalizationWarning: string | undefined;

  for (const slot of recipient.stepDrafts || []) {
    const draft = slot.draft as any;
    if (!draft) continue;

    if (draft.companyNameMismatch && !companyNameMismatch) {
      companyNameMismatch = String(draft.companyNameMismatch).trim();
    }

    if (Array.isArray(draft.unsupportedClaims)) {
      for (const claim of draft.unsupportedClaims) {
        if (!unsupportedClaims.includes(claim)) unsupportedClaims.push(claim);
        if (/incorporat/i.test(claim) && !unsupportedIncorporationClaim) {
          unsupportedIncorporationClaim = claim;
        }
        if (/website/i.test(claim) && !unsupportedWebsiteClaim) {
          unsupportedWebsiteClaim = claim;
        }
      }
    }

    if (Array.isArray(draft.warnings)) {
      for (const w of draft.warnings) {
        if (/token|greeting|placeholder|salutation/i.test(w) && !personalizationWarning) {
          personalizationWarning = w;
        }
        if (/incorporat/i.test(w) && !unsupportedIncorporationClaim) {
          unsupportedIncorporationClaim = w;
          if (!unsupportedClaims.includes(w)) unsupportedClaims.push(w);
        }
        if (/website/i.test(w) && !unsupportedWebsiteClaim) {
          unsupportedWebsiteClaim = w;
          if (!unsupportedClaims.includes(w)) unsupportedClaims.push(w);
        }
      }
    }
  }

  return {
    companyNameMismatch,
    unsupportedClaims,
    unsupportedIncorporationClaim,
    unsupportedWebsiteClaim,
    personalizationWarning,
    hasBlockingError: Boolean(companyNameMismatch),
    requiresReview: Boolean(
      companyNameMismatch || unsupportedClaims.length > 0 || personalizationWarning
    ),
  };
}

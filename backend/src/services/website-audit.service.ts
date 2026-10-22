/**
 * Interpretation of supplied website-audit metadata (from prospect CSVs).
 *
 * Critical safety rule: a timeout or HTTP error DOES NOT mean the company has no
 * website. We only treat a site as definitively absent when the source itself
 * says the domain is unregistered (status=missing + audit type=unregistered).
 * Everything else produces cautious language so generated outreach never invents
 * a website finding.
 */

export type WebsiteStatus = 'active' | 'missing' | 'parked' | 'unknown';

export interface WebsiteAuditInput {
  statusRaw?: string | null;
  auditTypeRaw?: string | null;
  httpCodeRaw?: string | number | null;
}

export interface WebsiteAuditInterpretation {
  /** Normalized high-level site status. */
  websiteStatus: WebsiteStatus;
  /** Normalized audit type, e.g. live_portal, timeout, http_error, unregistered. */
  siteAuditType: string;
  /** Parsed HTTP status code, or null when not numeric/blank. */
  httpCode: number | null;
  /** True when any audit signal was supplied. */
  hasAuditData: boolean;
  /** True ONLY when we can safely state the company has no website. */
  definitiveNoWebsite: boolean;
  /** Cautious-language warnings to surface to the user. */
  cautions: string[];
  /** Safe, factual lines suitable for an AI grounding prompt. */
  contextLines: string[];
  /** Short human-readable summary. */
  summary: string;
}

const ACTIVE = new Set(['active', 'live', 'up', 'online', 'ok', 'reachable', 'live_portal']);
const MISSING = new Set(['missing', 'none', 'no', 'absent', 'not_found', 'notfound', 'unregistered']);
const PARKED = new Set(['parked', 'parked_registrar', 'parking', 'domain_parked']);

const AUDIT_TYPE_NORMALIZE: Record<string, string> = {
  'live portal': 'live_portal',
  liveportal: 'live_portal',
  live_portal: 'live_portal',
  'http error': 'http_error',
  httperror: 'http_error',
  http_error: 'http_error',
  timeout: 'timeout',
  timed_out: 'timeout',
  'timed out': 'timeout',
  'parked registrar': 'parked_registrar',
  parked_registrar: 'parked_registrar',
  unregistered: 'unregistered',
};

function clean(raw?: string | null): string {
  return String(raw ?? '').trim();
}

/** Normalizes a raw Website Status value. */
export function normalizeWebsiteStatus(raw?: string | null): WebsiteStatus {
  const value = clean(raw).toLowerCase().replace(/[\s-]+/g, '_');
  if (!value) return 'unknown';
  if (ACTIVE.has(value)) return 'active';
  if (MISSING.has(value)) return 'missing';
  if (PARKED.has(value)) return 'parked';
  return 'unknown';
}

/** Normalizes a raw Site Audit Type value to a stable snake_case enum-ish token. */
export function normalizeSiteAuditType(raw?: string | null): string {
  const value = clean(raw).toLowerCase();
  if (!value) return 'unknown';
  if (AUDIT_TYPE_NORMALIZE[value]) return AUDIT_TYPE_NORMALIZE[value];
  const snake = value.replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  return AUDIT_TYPE_NORMALIZE[snake] || snake || 'unknown';
}

/** Parses an HTTP code that may be numeric or blank. */
export function parseHttpCode(raw?: string | number | null): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = typeof raw === 'number' ? raw : parseInt(clean(raw), 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Interprets supplied audit metadata, producing normalized values plus the
 * cautious-language guardrails used throughout validation and AI grounding.
 */
export function interpretWebsiteAudit(input: WebsiteAuditInput): WebsiteAuditInterpretation {
  const websiteStatus = normalizeWebsiteStatus(input.statusRaw);
  const siteAuditType = normalizeSiteAuditType(input.auditTypeRaw);
  const httpCode = parseHttpCode(input.httpCodeRaw);

  const hasAuditData =
    clean(input.statusRaw).length > 0 ||
    clean(input.auditTypeRaw).length > 0 ||
    httpCode !== null;

  const cautions: string[] = [];
  const contextLines: string[] = [];

  if (websiteStatus !== 'unknown') contextLines.push(`Supplied website status: ${websiteStatus}`);
  if (siteAuditType !== 'unknown') contextLines.push(`Supplied site audit type: ${siteAuditType}`);
  if (httpCode !== null) contextLines.push(`Observed HTTP status code: ${httpCode}`);

  // A timeout or HTTP error is NOT proof of absence.
  if (siteAuditType === 'timeout') {
    cautions.push(
      'Website check timed out — the site may exist but was unreachable during the scan. Do not claim the company has no website.'
    );
  }
  if (siteAuditType === 'http_error' || (httpCode !== null && httpCode >= 400)) {
    cautions.push(
      'Website returned an HTTP error — the site may exist but responded with an error. Verify before making any claim.'
    );
  }
  if (siteAuditType === 'parked_registrar' || websiteStatus === 'parked') {
    cautions.push(
      'Domain appears parked at the registrar — treat as having no active site, but confirm before stating it as fact.'
    );
  }

  const definitiveNoWebsite = websiteStatus === 'missing' && siteAuditType === 'unregistered';
  if (definitiveNoWebsite) {
    contextLines.push('Source reports the domain as unregistered (no website).');
  }
  if (websiteStatus === 'active') {
    contextLines.push('Source reports an active website.');
  }

  let summary: string;
  if (!hasAuditData) {
    summary = 'No website audit data supplied.';
  } else if (definitiveNoWebsite) {
    summary = 'Source reports the domain is unregistered (no website).';
  } else if (websiteStatus === 'active') {
    summary = 'Source reports an active website.';
  } else if (websiteStatus === 'parked') {
    summary = 'Source reports a parked domain (no active site).';
  } else if (cautions.length > 0) {
    summary = 'Website audit was inconclusive; treat findings cautiously.';
  } else {
    summary = 'Website audit data supplied.';
  }

  return {
    websiteStatus,
    siteAuditType,
    httpCode,
    hasAuditData,
    definitiveNoWebsite,
    cautions,
    contextLines,
    summary,
  };
}

/**
 * Builds a cautious, non-hallucinated context block for AI drafting from raw
 * audit fields. Returns only safe statements (never "no website" unless proven).
 */
export function buildAuditContextLines(input: WebsiteAuditInput): string[] {
  return interpretWebsiteAudit(input).contextLines;
}

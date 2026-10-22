import Papa from 'papaparse';
import { AssessmentRating } from '../models/Company.js';
import { interpretWebsiteAudit, WebsiteAuditInterpretation } from './website-audit.service.js';

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/**
 * Maps CSV headers onto internal fields. Identity keys become first-class
 * company/contact fields; extended keys are preserved on the company's bounded
 * customFields bag so no source column is silently discarded.
 */
export interface ColumnMapping {
  company_name: string;
  domain?: string;
  website_url?: string;
  industry?: string;
  city?: string;
  country?: string;
  contact_first_name?: string;
  contact_last_name?: string;
  contact_full_name?: string;
  contact_role?: string;
  contact_email?: string;
  contact_phone?: string;
  services?: string;
  rating?: string;
  notes?: string;
  sector?: string;
  state_roc?: string;
  contact_confidence?: string;
  website_status?: string;
  site_audit_type?: string;
  http_code?: string;
  page_title?: string;
  proposed_deliverable?: string;
  direct_phone?: string;
  director_full_name?: string;
  step_1_subject?: string;
  step_1_body?: string;
  step_2_subject?: string;
  step_2_body?: string;
  step_3_subject?: string;
  step_3_body?: string;
  [key: string]: string | undefined;
}

export interface CleanedCsvRow {
  company_name: string;
  domain: string | null;
  website_url: string | null;
  industry: string | null;
  city: string | null;
  country: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_full_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  services: string[];
  rating: AssessmentRating;
  raw_rating: string | null;
  notes: string | null;
  sector: string | null;
  state_roc: string | null;
  contact_confidence: string | null;
  website_status: string | null;
  site_audit_type: string | null;
  http_code: string | null;
  page_title: string | null;
  proposed_deliverable: string | null;
  primary_tech_signal: string | null;
  authorized_capital: string | null;
  direct_phone: string | null;
  director_full_name: string | null;
  step_1_subject: string | null;
  step_1_body: string | null;
  step_2_subject: string | null;
  step_2_body: string | null;
  step_3_subject: string | null;
  step_3_body: string | null;
}

export interface ParsedCsvRow {
  rowNumber: number;
  raw: Record<string, string>;
  cleaned: CleanedCsvRow;
  errors: { field: string; reason: string }[];
  warnings: string[];
  isDuplicate: boolean;
  duplicateScope?: 'file' | 'database';
  duplicateReason?: string;
  websiteAudit: WebsiteAuditInterpretation;
}

export interface ValidationSummary {
  totalRows: number;
  validRows: number;
  errorRows: number;
  duplicateRows: number;
  /** Duplicates that already exist in the database (as opposed to in-file). */
  existingRows: number;
  /** Duplicates detected only within the uploaded file. */
  fileDuplicateRows: number;
  /** Rows missing recommended optional data (email, director, page title, offer). */
  missingOptionalRows: number;
  /** Rows whose supplied website audit was inconclusive (timeout/http_error/...). */
  websiteAuditWarningRows: number;
  parsedRows: ParsedCsvRow[];
}

// ---------------------------------------------------------------------------
// Header-mapping layer (recognizes the Swaniki column set + aliases)
// ---------------------------------------------------------------------------

/**
 * Alias table keyed by internal field. The first alias for each field is the
 * canonical Swaniki column name; the rest allow alternate headers to map in.
 */
export const SWANIKI_HEADER_ALIASES: Record<string, string[]> = {
  company_name: ['Company Name', 'Company', 'Organization', 'Organisation', 'Account Name', 'Business Name', 'Business'],
  domain: ['Domain', 'Domain Name', 'Website Domain'],
  website_url: ['Website URL', 'Website', 'Website Url', 'Web Site', 'Company Website', 'URL'],
  industry: ['Industry', 'Vertical', 'Category'],
  sector: ['Sector'],
  state_roc: ['State / ROC', 'State/ROC', 'State ROC', 'State', 'ROC'],
  city: ['City', 'Town'],
  country: ['Country', 'Nation'],
  contact_full_name: ['Contact Name', 'Contact Full Name', 'Full Name', 'Contact Person', 'Primary Contact'],
  contact_first_name: ['Contact First Name', 'First Name', 'Given Name'],
  contact_last_name: ['Contact Last Name', 'Last Name', 'Surname', 'Family Name'],
  contact_role: ['Contact Role', 'Role', 'Job Title', 'Contact Title', 'Position', 'Title'],
  contact_email: ['Work Email', 'Email Address', 'Email', 'Contact Email', 'E-mail', 'Email ID'],
  contact_phone: ['Contact Phone', 'Phone', 'Mobile', 'Contact Number', 'Phone Number', 'Telephone'],
  direct_phone: ['Direct Phone', 'Direct Dial', 'Direct Number'],
  services: ['Services', 'Service', 'Offering', 'Offerings', 'Products'],
  rating: ['Rating', 'Grade', 'Score'],
  notes: ['Notes', 'Note', 'Comment', 'Comments', 'Description'],
  contact_confidence: ['Contact Confidence', 'Confidence'],
  website_status: ['Website Status', 'Website'],
  site_audit_type: ['Site Audit Type', 'Audit Type'],
  http_code: ['HTTP Code', 'HTTP Status', 'Status Code'],
  page_title: ['Page Title', 'Title'],
  proposed_deliverable: ['Proposed Deliverable', 'Deliverable', 'Proposal'],
  primary_tech_signal: ['Primary Tech Signal', 'Tech Signal', 'Technology Signal'],
  authorized_capital: ['Authorized Capital (INR)', 'Authorized Capital', 'Authorised Capital (INR)', 'Authorised Capital'],
  director_full_name: ['Director Full Name', 'Director Name', 'Director'],
  step_1_subject: ['Step 1 Subject', 'Step1 Subject', 'Email 1 Subject', 'Subject 1'],
  step_1_body: ['Step 1 Body', 'Step1 Body', 'Email 1 Body', 'Body 1'],
  step_2_subject: ['Step 2 Subject', 'Step2 Subject', 'Email 2 Subject', 'Subject 2'],
  step_2_body: ['Step 2 Body', 'Step2 Body', 'Email 2 Body', 'Body 2'],
  step_3_subject: ['Step 3 Subject', 'Step3 Subject', 'Email 3 Subject', 'Subject 3'],
  step_3_body: ['Step 3 Body', 'Step3 Body', 'Email 3 Body', 'Body 3'],
};

/** Fields persisted as first-class company/contact attributes. */
export const IDENTITY_FIELD_KEYS = [
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
  'contact_email',
  'contact_phone',
  'services',
  'rating',
  'notes',
] as const;

/** Extended fields preserved onto the company's customFields bag. */
export const EXTENDED_FIELD_KEYS = [
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
  'step_1_subject',
  'step_1_body',
  'step_2_subject',
  'step_2_body',
  'step_3_subject',
  'step_3_body',
] as const;

export function normalizeHeaderName(raw: string): string {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Best-effort mapping of detected headers onto internal fields. A header is never
 * assigned to two fields. Returns unmapped headers so callers can preserve them.
 */
export function mapHeadersToFields(headers: string[]): {
  mapping: Record<string, string>;
  unmapped: string[];
  missingRequired: string[];
} {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  const byNormalized = new Map<string, string>();
  for (const h of headers) byNormalized.set(normalizeHeaderName(h), h);

  for (const [fieldKey, aliases] of Object.entries(SWANIKI_HEADER_ALIASES)) {
    let match: string | undefined;
    for (const alias of aliases) {
      const candidate = byNormalized.get(normalizeHeaderName(alias));
      if (candidate && !used.has(candidate)) {
        match = candidate;
        break;
      }
    }
    if (match) {
      mapping[fieldKey] = match;
      used.add(match);
    }
  }

  const unmapped = headers.filter((h) => !used.has(h));
  const missingRequired = ['company_name'].filter((k) => !mapping[k]);
  return { mapping, unmapped, missingRequired };
}

// ---------------------------------------------------------------------------
// Robust parsing + limits
// ---------------------------------------------------------------------------

/** Strips a leading UTF-8 BOM if present. */
export function stripBom(text: string): string {
  const str = String(text ?? '');
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

export function computeByteLength(text: string): number {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/** Throws a structured FILE_TOO_LARGE error when the payload exceeds the limit. */
export function assertByteLimit(text: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8');
  if (bytes > maxBytes) {
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    const limitMb = (maxBytes / (1024 * 1024)).toFixed(2);
    const err: any = new Error(`CSV file is ${mb} MB and exceeds the configured limit of ${limitMb} MB`);
    err.code = 'FILE_TOO_LARGE';
    err.statusCode = 413;
    throw err;
  }
}

/** Enforces the configured maximum row count with a clear, structured error. */
export function assertRowLimit(rowCount: number, maxRows: number): void {
  if (rowCount > maxRows) {
    const err: any = new Error(`CSV contains ${rowCount} rows and exceeds the configured limit of ${maxRows} rows`);
    err.code = 'TOO_MANY_ROWS';
    err.statusCode = 413;
    throw err;
  }
}

/** Parses CSV text, tolerating BOMs; returns headers and row records only. */
export function parseCsvString(csvContent: string): { headers: string[]; rows: Record<string, string>[] } {
  const { headers, rows } = parseCsvDetailed(csvContent);
  return { headers, rows };
}

export interface CsvParseResult {
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
  delimiter: string;
}

/**
 * Full CSV parse using a real RFC-4180 parser. Handles quoted fields, commas
 * inside fields, escaped quotes and multiline values. A leading UTF-8 BOM is
 * stripped before parsing.
 *
 * NOTE: this materializes the entire file in memory and is retained only for the
 * legacy JSON endpoints and small files. Large imports use {@link createCsvRowStream},
 * which streams from disk with bounded memory.
 */
export function parseCsvDetailed(csvContent: string): CsvParseResult {
  const text = stripBom(String(csvContent ?? ''));
  const errors: string[] = [];

  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (h: string) => String(h ?? '').replace(/^\uFEFF/, '').trim(),
  });

  const headers = (result.meta?.fields || []).filter((h) => h !== '');
  const rows = (result.data || []).filter((row: any) => row && Object.keys(row).length > 0);

  for (const e of result.errors || []) {
    // Field-count differences are tolerated (optional blank columns); only
    // structural problems (unterminated quotes, bad delimiters) are surfaced.
    if (e?.type === 'Quotes' || e?.type === 'Delimiter') {
      errors.push(`${e.message}${e.row !== undefined ? ` (row ${e.row + 1})` : ''}`);
    }
  }

  return { headers, rows, errors, delimiter: result.meta?.delimiter || ',' };
}

// ---------------------------------------------------------------------------
// Streaming parse (bounded memory) — used by the resumable import job pipeline
// ---------------------------------------------------------------------------

export interface StreamedRawRow {
  rowNumber: number;
  raw: Record<string, string>;
}

export interface CsvRowStream {
  headers: () => string[];
  parseErrors: () => string[];
  delimiter: () => string;
  rows: AsyncGenerator<StreamedRawRow, void, void>;
}

/**
 * Streams parsed CSV rows from a Node readable stream one at a time. Supports
 * UTF-8 BOM, quoted commas, escaped quotes, multiline fields and empty fields.
 * Backpressure keeps at most `highWaterMark` parsed rows buffered in memory, so
 * memory stays flat regardless of file size.
 */
export function createCsvRowStream(
  source: NodeJS.ReadableStream,
  options: { highWaterMark?: number } = {}
): CsvRowStream {
  const highWaterMark = Math.max(1, options.highWaterMark ?? 500);
  const lowWaterMark = Math.max(1, Math.floor(highWaterMark / 2));

  const queue: StreamedRawRow[] = [];
  const parseErrors: string[] = [];
  let headers: string[] = [];
  let delimiter = ',';
  let rowCounter = 0;
  let done = false;
  let failure: Error | null = null;
  let paused = false;
  let handle: { pause?: () => void; resume?: () => void } | null = null;
  let notify: (() => void) | null = null;

  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };

  Papa.parse(source as any, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (h: string) => String(h ?? '').replace(/^\uFEFF/, '').trim(),
    step: (results: any, stepHandle: any) => {
      handle = stepHandle;
      if (results.meta?.fields && headers.length === 0) {
        headers = (results.meta.fields || []).filter((h: string) => h !== '');
      }
      if (results.meta?.delimiter) delimiter = results.meta.delimiter;
      for (const e of results.errors || []) {
        if (e?.type === 'Quotes' || e?.type === 'Delimiter') {
          parseErrors.push(`${e.message}${e.row !== undefined ? ` (row ${e.row + 1})` : ''}`);
        }
      }
      // With header:true, Papa's step delivers a SINGLE row object (not an array).
      const raw = results.data as Record<string, string> | undefined;
      if (raw && Object.keys(raw).length > 0) {
        queue.push({ rowNumber: ++rowCounter, raw });
      }
      if (queue.length >= highWaterMark && handle?.pause) {
        try {
          handle.pause();
          paused = true;
        } catch {
          /* ignore */
        }
      }
      wake();
    },
    complete: () => {
      done = true;
      wake();
    },
    error: (err: any) => {
      failure = err instanceof Error ? err : new Error(String(err?.message ?? err));
      done = true;
      wake();
    },
  });

  async function* iterate(): AsyncGenerator<StreamedRawRow, void, void> {
    try {
      while (true) {
        if (queue.length > 0) {
          const item = queue.shift()!;
          if (paused && queue.length <= lowWaterMark) {
            paused = false;
            try {
              handle?.resume?.();
            } catch {
              /* ignore */
            }
          }
          yield item;
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      if (!done) {
        try {
          (source as any).destroy?.();
        } catch {
          /* ignore */
        }
      }
    }
  }

  return {
    headers: () => headers,
    parseErrors: () => parseErrors,
    delimiter: () => delimiter,
    rows: iterate(),
  };
}

/** Streams a file and returns bounded sample rows plus the full row count. */
export async function inspectCsvStream(
  source: NodeJS.ReadableStream,
  options: { maxPreviewRows?: number; highWaterMark?: number } = {}
): Promise<{
  headers: string[];
  totalRows: number;
  sampleRows: Record<string, string>[];
  parseErrors: string[];
  delimiter: string;
}> {
  const maxPreviewRows = Math.max(0, options.maxPreviewRows ?? 20);
  const stream = createCsvRowStream(source, { highWaterMark: options.highWaterMark ?? 64 });
  const sampleRows: Record<string, string>[] = [];
  let totalRows = 0;
  for await (const { raw } of stream.rows) {
    totalRows++;
    if (sampleRows.length < maxPreviewRows) sampleRows.push(raw);
  }
  return {
    headers: stream.headers(),
    totalRows,
    sampleRows,
    parseErrors: stream.parseErrors(),
    delimiter: stream.delimiter(),
  };
}

// ---------------------------------------------------------------------------
// Value normalization helpers
// ---------------------------------------------------------------------------

/** Neutralizes spreadsheet formula injection (values starting with = + - @). */
export function sanitizeForFormulaInjection(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return '';
  const value = raw.toString();
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

export const ratingScalePresets = {
  five_star: { '5': 'A', '4': 'B', '3': 'C', '2': 'D', '1': 'F' },
  ten_point: {
    '10': 'A',
    '9': 'A',
    '8': 'B',
    '7': 'B',
    '6': 'C',
    '5': 'C',
    '4': 'D',
    '3': 'D',
    '2': 'F',
    '1': 'F',
  },
};

/**
 * Normalizes a rating string into A, B, C, D, F, or 'unrated'.
 * Missing values are NEVER treated as zero.
 */
export function normalizeRating(
  rawVal: string | undefined | null,
  customScaleMapping: Record<string, string> = {},
  scaleType: 'standard' | 'five_star' | 'ten_point' = 'standard'
): AssessmentRating {
  if (!rawVal || !rawVal.trim()) return 'unrated';
  const clean = rawVal.trim().toLowerCase();

  if (customScaleMapping[clean]) {
    const mapped = customScaleMapping[clean].toUpperCase();
    if (['A', 'B', 'C', 'D', 'F'].includes(mapped)) return mapped as AssessmentRating;
  }

  const upper = rawVal.trim().toUpperCase();
  if (['A', 'B', 'C', 'D', 'F'].includes(upper)) return upper as AssessmentRating;

  if (scaleType === 'ten_point' && ratingScalePresets.ten_point[clean as keyof typeof ratingScalePresets.ten_point]) {
    return ratingScalePresets.ten_point[clean as keyof typeof ratingScalePresets.ten_point] as AssessmentRating;
  }
  if (scaleType === 'five_star' && ratingScalePresets.five_star[clean as keyof typeof ratingScalePresets.five_star]) {
    return ratingScalePresets.five_star[clean as keyof typeof ratingScalePresets.five_star] as AssessmentRating;
  }

  const num = parseFloat(clean);
  if (!isNaN(num)) {
    if (num >= 4.5 && num <= 5.0) return 'A';
    if (num >= 3.5 && num < 4.5) return 'B';
    if (num >= 2.5 && num < 3.5) return 'C';
    if (num >= 1.5 && num < 2.5) return 'D';
    if (num > 0 && num < 1.5) return 'F';
  }

  return 'unrated';
}

/** Extracts a clean hostname from a URL when no explicit domain was supplied. */
export function extractDomainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const cleanUrl = url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`;
    const parsed = new URL(cleanUrl);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Splits comma/semicolon/pipe delimited service lists. */
export function parseServicesList(rawServices: string | null | undefined): string[] {
  if (!rawServices) return [];
  return rawServices
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Trims and sanitizes a mapped value, returning null when blank. */
export function mappedValue(row: Record<string, string>, header: string | undefined, aliasKey?: string): string | null {
  if (header && row[header] !== undefined && row[header] !== null) {
    const trimmed = String(row[header]).trim();
    if (trimmed.length > 0) return trimmed;
  }
  // If not found under direct header, try aliasKey from SWANIKI_HEADER_ALIASES
  if (aliasKey && SWANIKI_HEADER_ALIASES[aliasKey]) {
    for (const alias of SWANIKI_HEADER_ALIASES[aliasKey]) {
      if (row[alias] !== undefined && row[alias] !== null) {
        const trimmed = String(row[alias]).trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
    // Also try case-insensitive comparison across row keys
    const lowerAliases = SWANIKI_HEADER_ALIASES[aliasKey].map((a) => normalizeHeaderName(a));
    for (const [k, v] of Object.entries(row)) {
      if (lowerAliases.includes(normalizeHeaderName(k))) {
        const trimmed = String(v ?? '').trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
  }
  return null;
}

function sanitized(row: Record<string, string>, header: string | undefined, aliasKey?: string): string | null {
  const value = mappedValue(row, header, aliasKey);
  return value === null ? null : sanitizeForFormulaInjection(value);
}

// ---------------------------------------------------------------------------
// Validation, normalization and duplicate detection
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Normalized-key buckets used for duplicate detection (file + database). */
export interface DuplicateSets {
  existingDomains: Set<string>;
  existingNames: Set<string>;
  existingEmails: Set<string>;
  inFileDomains: Set<string>;
  inFileNames: Set<string>;
  inFileEmails: Set<string>;
}

/** Creates empty duplicate-detection buckets. */
export function createDuplicateSets(): DuplicateSets {
  return {
    existingDomains: new Set<string>(),
    existingNames: new Set<string>(),
    existingEmails: new Set<string>(),
    inFileDomains: new Set<string>(),
    inFileNames: new Set<string>(),
    inFileEmails: new Set<string>(),
  };
}

/**
 * Validates and normalizes ONE row: required-field checks, email syntax,
 * website-audit interpretation and duplicate detection against both the current
 * file (mutating the in-file sets) and the database. Shared by the batch
 * validator and the streaming import processor so both honour identical field
 * mappings and protections.
 */
export function normalizeParsedRow(
  row: Record<string, string>,
  rowNumber: number,
  mapping: ColumnMapping,
  sets: DuplicateSets,
  scaleType: 'standard' | 'five_star' | 'ten_point' = 'standard'
): ParsedCsvRow {
  const errors: { field: string; reason: string }[] = [];
  const warnings: string[] = [];

  const companyName = sanitizeForFormulaInjection(mappedValue(row, mapping.company_name, 'company_name') ?? '');
  if (!companyName) {
    errors.push({ field: 'company_name', reason: 'Company name is required' });
  }

  const websiteUrl = sanitized(row, mapping.website_url, 'website_url');
  let domain = mappedValue(row, mapping.domain, 'domain')?.toLowerCase() ?? null;
  if (!domain && websiteUrl) domain = extractDomainFromUrl(websiteUrl);
  if (domain) domain = sanitizeForFormulaInjection(domain.toLowerCase());

  const contactEmail = mappedValue(row, mapping.contact_email, 'contact_email')?.toLowerCase() ?? null;
  if (contactEmail && !EMAIL_RE.test(contactEmail)) {
    errors.push({ field: 'contact_email', reason: `Invalid email format '${contactEmail}'` });
  }

  const rawRating = mappedValue(row, mapping.rating, 'rating') ?? undefined;
  const normalizedRating = normalizeRating(rawRating, {}, scaleType);

  const websiteAudit = interpretWebsiteAudit({
    statusRaw: mappedValue(row, mapping.website_status, 'website_status'),
    auditTypeRaw: mappedValue(row, mapping.site_audit_type, 'site_audit_type'),
    httpCodeRaw: mappedValue(row, mapping.http_code, 'http_code'),
  });
  warnings.push(...websiteAudit.cautions);

  const cleaned: CleanedCsvRow = {
    company_name: companyName,
    domain,
    website_url: websiteUrl,
    industry: sanitized(row, mapping.industry, 'industry'),
    city: sanitized(row, mapping.city, 'city'),
    country: sanitized(row, mapping.country, 'country'),
    contact_first_name: sanitized(row, mapping.contact_first_name, 'contact_first_name'),
    contact_last_name: sanitized(row, mapping.contact_last_name, 'contact_last_name'),
    contact_full_name: sanitized(row, mapping.contact_full_name, 'contact_full_name'),
    contact_role: sanitized(row, mapping.contact_role, 'contact_role'),
    contact_email: contactEmail,
    contact_phone: sanitized(row, mapping.contact_phone, 'contact_phone'),
    services: parseServicesList(mappedValue(row, mapping.services, 'services')),
    rating: normalizedRating,
    raw_rating: rawRating || null,
    notes: sanitized(row, mapping.notes, 'notes'),
    sector: sanitized(row, mapping.sector, 'sector'),
    state_roc: sanitized(row, mapping.state_roc, 'state_roc'),
    contact_confidence: sanitized(row, mapping.contact_confidence, 'contact_confidence'),
    website_status: mappedValue(row, mapping.website_status, 'website_status'),
    site_audit_type: mappedValue(row, mapping.site_audit_type, 'site_audit_type'),
    http_code: mappedValue(row, mapping.http_code, 'http_code'),
    page_title: sanitized(row, mapping.page_title, 'page_title'),
    proposed_deliverable: sanitized(row, mapping.proposed_deliverable, 'proposed_deliverable'),
    primary_tech_signal: sanitized(row, mapping.primary_tech_signal, 'primary_tech_signal'),
    authorized_capital: sanitized(row, mapping.authorized_capital, 'authorized_capital'),
    direct_phone: sanitized(row, mapping.direct_phone, 'direct_phone'),
    director_full_name: sanitized(row, mapping.director_full_name, 'director_full_name'),
    step_1_subject: sanitized(row, mapping.step_1_subject, 'step_1_subject'),
    step_1_body: sanitized(row, mapping.step_1_body, 'step_1_body'),
    step_2_subject: sanitized(row, mapping.step_2_subject, 'step_2_subject'),
    step_2_body: sanitized(row, mapping.step_2_body, 'step_2_body'),
    step_3_subject: sanitized(row, mapping.step_3_subject, 'step_3_subject'),
    step_3_body: sanitized(row, mapping.step_3_body, 'step_3_body'),
  };

  const lowerName = companyName.toLowerCase();
  let isDuplicate = false;
  let duplicateScope: 'file' | 'database' | undefined;
  let duplicateReason: string | undefined;

  const domainInFile = !!(domain && sets.inFileDomains.has(domain));
  const domainInDb = !!(domain && sets.existingDomains.has(domain));
  const nameInFile = sets.inFileNames.has(lowerName);
  const nameInDb = sets.existingNames.has(lowerName);
  const emailInFile = !!(contactEmail && sets.inFileEmails.has(contactEmail));
  const emailInDb = !!(contactEmail && sets.existingEmails.has(contactEmail));

  if (emailInFile || domainInFile || nameInFile) {
    isDuplicate = true;
    duplicateScope = 'file';
    duplicateReason = emailInFile
      ? `Duplicate contact email '${contactEmail}' within the uploaded file`
      : domainInFile
        ? `Duplicate domain '${domain}' within the uploaded file`
        : `Duplicate company name '${companyName}' within the uploaded file`;
  } else if (emailInDb || domainInDb || nameInDb) {
    isDuplicate = true;
    duplicateScope = 'database';
    duplicateReason = emailInDb
      ? `Contact email '${contactEmail}' already exists in the database`
      : domainInDb
        ? `Domain '${domain}' already exists in the database`
        : `Company name '${companyName}' already exists in the database`;
  }

  // Track keys for subsequent rows regardless of validity (so repeats are seen).
  if (domain) sets.inFileDomains.add(domain);
  sets.inFileNames.add(lowerName);
  if (contactEmail) sets.inFileEmails.add(contactEmail);

  return {
    rowNumber,
    raw: row,
    cleaned,
    errors,
    warnings,
    isDuplicate,
    duplicateScope,
    duplicateReason,
    websiteAudit,
  };
}

/**
 * Validates and normalizes parsed rows: required-field checks, email syntax,
 * website-audit interpretation, normalized duplicate detection (in-file AND
 * against the database), and advisory warnings. Never throws; invalid rows are
 * reported rather than aborting the batch.
 */
export function validateAndNormalizeRows(
  rawRows: Record<string, string>[],
  mapping: ColumnMapping,
  existingCompanyDomains: Set<string>,
  existingCompanyNames: Set<string>,
  existingContactEmails: Set<string>,
  scaleType: 'standard' | 'five_star' | 'ten_point' = 'standard'
): ValidationSummary {
  const sets = createDuplicateSets();
  sets.existingDomains = existingCompanyDomains;
  sets.existingNames = existingCompanyNames;
  sets.existingEmails = existingContactEmails;

  const parsedRows: ParsedCsvRow[] = [];
  let validCount = 0;
  let errorCount = 0;
  let duplicateCount = 0;
  let existingRows = 0;
  let fileDuplicateRows = 0;
  let missingOptionalRows = 0;
  let websiteAuditWarningRows = 0;

  rawRows.forEach((row, index) => {
    const parsed = normalizeParsedRow(row, index + 1, mapping, sets, scaleType);
    parsedRows.push(parsed);

    if (parsed.errors.length > 0) {
      errorCount++;
    } else if (parsed.isDuplicate) {
      duplicateCount++;
      if (parsed.duplicateScope === 'file') fileDuplicateRows++;
      else existingRows++;
    } else {
      validCount++;
    }

    const cleaned = parsed.cleaned;
    if (
      !cleaned.contact_email ||
      !cleaned.director_full_name ||
      !cleaned.direct_phone ||
      !cleaned.page_title ||
      !cleaned.proposed_deliverable
    ) {
      missingOptionalRows++;
    }
    if (parsed.websiteAudit.cautions.length > 0) websiteAuditWarningRows++;
  });

  return {
    totalRows: rawRows.length,
    validRows: validCount,
    errorRows: errorCount,
    duplicateRows: duplicateCount,
    existingRows,
    fileDuplicateRows,
    missingOptionalRows,
    websiteAuditWarningRows,
    parsedRows,
  };
}

/**
 * Builds the bounded customFields bag persisted on the company: extended mapped
 * fields plus any user-designated custom column mappings.
 */
export function buildCompanyCustomFields(
  cleaned: CleanedCsvRow,
  raw: Record<string, string>,
  customFieldMapping: Record<string, string> = {}
): Record<string, string> {
  const out: Record<string, string> = {};

  const put = (key: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && String(value).trim().length > 0) out[key] = String(value);
  };

  put('sector', cleaned.sector);
  put('state_roc', cleaned.state_roc);
  put('contact_confidence', cleaned.contact_confidence);
  put('website_status', cleaned.website_status);
  put('site_audit_type', cleaned.site_audit_type);
  put('http_code', cleaned.http_code);
  put('page_title', cleaned.page_title);
  put('proposed_deliverable', cleaned.proposed_deliverable);
  put('primary_tech_signal', cleaned.primary_tech_signal);
  put('authorized_capital', cleaned.authorized_capital);
  put('direct_phone', cleaned.direct_phone);
  put('director_full_name', cleaned.director_full_name);
  put('step_1_subject', cleaned.step_1_subject);
  put('step_1_body', cleaned.step_1_body);
  put('step_2_subject', cleaned.step_2_subject);
  put('step_2_body', cleaned.step_2_body);
  put('step_3_subject', cleaned.step_3_subject);
  put('step_3_body', cleaned.step_3_body);

  for (const [sourceHeader, targetKey] of Object.entries(customFieldMapping)) {
    if (raw && sourceHeader in raw) {
      const value = raw[sourceHeader];
      if (value !== null && value !== undefined && String(value).trim().length > 0) {
        out[targetKey] = String(value);
      }
    }
  }

  return out;
}

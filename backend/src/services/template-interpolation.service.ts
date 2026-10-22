/**
 * Safe {{token}} interpolation for campaign email steps.
 *
 * Design goals:
 * - Deterministic and pure (easily unit tested).
 * - Bounded: a hard cap on the number of custom fields and value length so a
 *   hostile CSV cannot amplify memory/DB growth.
 * - Header-safe: subject lines have CR/LF stripped to prevent SMTP header injection.
 * - Never throws: unknown tokens are reported as `missingTokens` and rendered empty.
 */

export const MAX_CUSTOM_FIELDS = 50;
export const MAX_CUSTOM_FIELD_LENGTH = 500;
export const MAX_TEMPLATE_LENGTH = 20000;

/**
 * CSV columns that carry the email template copy itself (the per-recipient Step
 * 1/2/3 subjects and bodies), rather than arbitrary metadata. These are the
 * message content, so they are bounded by the template size — not by the tight
 * metadata cap that exists to stop a hostile CSV amplifying short columns.
 *
 * Treating them as generic custom fields is what previously sliced the imported
 * CSV body mid-sentence at 500 characters.
 */
export const STEP_COPY_FIELD_KEYS: ReadonlySet<string> = new Set([
  'step_1_subject',
  'step_1_body',
  'step_2_subject',
  'step_2_body',
  'step_3_subject',
  'step_3_body',
]);

/** Upper bound for a single field value: template copy is large, metadata is small. */
export function maxFieldLengthForKey(key: string): number {
  return STEP_COPY_FIELD_KEYS.has(key) ? MAX_TEMPLATE_LENGTH : MAX_CUSTOM_FIELD_LENGTH;
}

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_\- ]+?)\s*\}\}/g;

/** Normalizes a raw token/header into a stable snake_case key. */
export function normalizeTokenKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Strips CR/LF so interpolated values cannot break an SMTP header. */
export function sanitizeHeaderValue(value: string): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

export interface FilterCustomFieldsResult {
  customFields: Record<string, string>;
  droppedKeys: number;
  truncatedValues: number;
  /** Normalized keys whose value was longer than the applicable bound. */
  truncatedKeys: string[];
}

/**
 * Bounds an arbitrary key/value map to a safe size. Keys are normalized to
 * snake_case, duplicate normalized keys collapse, and values are length-capped.
 * Email template copy (Step 1/2/3 subject/body) is bounded by `MAX_TEMPLATE_LENGTH`;
 * all other metadata columns by `MAX_CUSTOM_FIELD_LENGTH`.
 */
export function boundCustomFields(raw: Record<string, unknown> | undefined | null): FilterCustomFieldsResult {
  const customFields: Record<string, string> = {};
  let droppedKeys = 0;
  let truncatedValues = 0;
  const truncatedKeys: string[] = [];

  if (!raw) return { customFields, droppedKeys, truncatedValues, truncatedKeys };

  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    const key = normalizeTokenKey(k);
    if (!key) continue;
    if (Object.keys(customFields).length >= MAX_CUSTOM_FIELDS && !(key in customFields)) {
      droppedKeys++;
      continue;
    }
    let value = String(v);
    const cap = maxFieldLengthForKey(key);
    if (value.length > cap) {
      value = value.slice(0, cap);
      truncatedValues++;
      truncatedKeys.push(key);
    }
    customFields[key] = value;
  }

  return { customFields, droppedKeys, truncatedValues, truncatedKeys };
}

export interface InterpolationResult {
  output: string;
  usedTokens: string[];
  missingTokens: string[];
}

/**
 * Replaces `{{token}}` occurrences with values from `values` (already keyed by
 * normalized token). Unknown tokens become empty strings and are reported.
 */
export function interpolateTemplate(
  template: string,
  values: Record<string, string>
): InterpolationResult {
  const usedTokens = new Set<string>();
  const missingTokens = new Set<string>();

  const bounded = String(template ?? '').slice(0, MAX_TEMPLATE_LENGTH);

  const output = bounded.replace(TOKEN_PATTERN, (_match, rawToken: string) => {
    const key = normalizeTokenKey(rawToken);
    if (key in values && values[key] !== undefined && values[key] !== null) {
      usedTokens.add(key);
      return String(values[key]);
    }
    missingTokens.add(key);
    return '';
  });

  return {
    output,
    usedTokens: [...usedTokens],
    missingTokens: [...missingTokens],
  };
}

/** Corporate suffix/legal-form words that carry no identity on their own. */
const COMPANY_SUFFIX_WORDS = new Set([
  'private', 'limited', 'pvt', 'ltd', 'llp', 'inc', 'incorporated', 'corp', 'corporation',
  'llc', 'plc', 'gmbh', 'company', 'co',
]);

/** Generic descriptors too common to establish a company's identity. */
const GENERIC_COMPANY_WORDS = new Set([
  'global', 'international', 'group', 'holdings', 'enterprises', 'solutions', 'technologies',
  'technology', 'services', 'systems', 'industries', 'consulting', 'ventures', 'partners',
  'associates', 'trading', 'exports', 'imports',
]);

const COMPANY_SUFFIX_PATTERN =
  /\b([A-Za-z][A-Za-z&.'-]*(?:\s+[A-Za-z&][A-Za-z&.'-]*){0,5}?)\s+(?:private\s+limited|pvt\.?\s*ltd\.?|limited|ltd\.?|llp|incorporated|inc\.?|corporation|corp\.?|llc|plc|gmbh)\b/gi;

/** Identity-bearing tokens of a company name (drops legal-form + generic descriptor words). */
function coreCompanyTokens(name: string): string[] {
  return normalizeTokenKey(name)
    .split('_')
    .filter((t) => t.length >= 2 && !COMPANY_SUFFIX_WORDS.has(t) && !GENERIC_COMPANY_WORDS.has(t));
}

/** Non-company lead words, verbs, adverbs, and stopwords that must never begin or constitute a company name. */
const NON_COMPANY_LEAD_WORDS = new Set([
  'was', 'is', 'were', 'are', 'been', 'being', 'became', 'has', 'have', 'had',
  'recently', 'newly', 'duly', 'currently', 'formerly', 'previously', 'freshly',
  'not', 'also', 'already', 'just', 'that', 'which', 'who', 'it', 'they', 'we',
  'i', 'you', 'he', 'she', 'under', 'since', 'after', 'before', 'when', 'while',
  'if', 'as', 'by', 'for', 'with', 'in', 'on', 'at', 'of', 'to', 'the', 'a', 'an',
  'noticed', 'congratulations', 'regarding', 'about', 'welcome', 'our', 'your', 'their',
]);

const PLATFORM_SENDER_TOKENS = new Set([
  'swaniki', 'swaniki_studio', 'swaniki_new_business_radar', 'swaniki_studio_team',
]);

/**
 * Detects when rendered copy references a *different* company than the recipient.
 *
 * Defensive guard, never a rewriter: returns the offending company-like phrase (or null).
 * Excludes verbal predicate clauses (such as "was recently incorporated") and platform names.
 */
export function detectCompanyNameMismatch(text: string, companyName?: string | null): string | null {
  const haystack = String(text || '');
  if (!haystack.trim() || !companyName || !companyName.trim()) return null;

  const recipientTokens = coreCompanyTokens(companyName);
  if (recipientTokens.length === 0) return null;
  const recipientSet = new Set(recipientTokens);

  const regex = new RegExp(COMPANY_SUFFIX_PATTERN.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(haystack)) !== null) {
    let candidate = match[0].trim();

    // Clean leading punctuation
    candidate = candidate.replace(/^[^\w]+/, '').trim();

    // Strip leading stopwords and verbs (e.g. "Noticed AYYAN GLOBAL" -> "AYYAN GLOBAL")
    const words = candidate.split(/\s+/);
    while (words.length > 0 && NON_COMPANY_LEAD_WORDS.has(words[0].toLowerCase())) {
      words.shift();
    }
    candidate = words.join(' ');
    if (!candidate.trim()) continue;

    // Exclude explicit incorporation predicate clauses
    if (/\b(?:was|is|were|are|been|being|became|recently|newly|freshly|duly)\s+(?:recently\s+)?incorporated\b/i.test(candidate)) {
      continue;
    }

    const candidateTokens = coreCompanyTokens(candidate);
    if (candidateTokens.length === 0) continue;

    // Discard candidates composed entirely of stopwords/lead words
    if (candidateTokens.every((t) => NON_COMPANY_LEAD_WORDS.has(t))) {
      continue;
    }

    // Discard mentions of our own outreach platform
    if (candidateTokens.every((t) => PLATFORM_SENDER_TOKENS.has(t))) {
      continue;
    }

    const sharesRecipientToken = candidateTokens.some((t) => recipientSet.has(t));
    if (!sharesRecipientToken) {
      return candidate;
    }
  }
  return null;
}

export interface CompanyVerificationEvidence {
  incorporationDate?: string | Date | null;
  registrationDate?: string | Date | null;
  cin?: string | null;
  mcaVerified?: boolean;
  websiteStatus?: string | null;
  httpCode?: string | null;
  siteAuditType?: string | null;
  domain?: string | null;
  customFields?: Record<string, string>;
  notes?: string | null;
}

/**
 * Extracts claims about recent incorporation or company registration age.
 */
export function extractIncorporationClaim(text: string): string | null {
  const haystack = String(text || '');
  if (!haystack.trim()) return null;

  const patterns = [
    /\b(?:was|is|being|having\s+been)?\s*(?:recently|newly|freshly)\s+incorporated(?:\s+under\s+[^.\n]+)?/i,
    /\bincorporated\s+under\s+(?:the\s+)?Ministry\s+of\s+Corporate\s+Affairs(?:\s+gazette)?/i,
    /\b(?:recently|newly|freshly)\s+(?:registered|formed|established|founded)\b/i,
    /\bnew\s+(?:venture|entrant|startup)\b/i,
  ];

  for (const regex of patterns) {
    const m = regex.exec(haystack);
    if (m) return m[0].trim();
  }
  return null;
}

/**
 * Validates incorporation claims against verified company evidence.
 */
export function validateIncorporationClaim(
  text: string,
  evidence?: CompanyVerificationEvidence
): string | null {
  const claim = extractIncorporationClaim(text);
  if (!claim) return null;

  const custom = evidence?.customFields || {};
  const dateStr =
    evidence?.incorporationDate ||
    evidence?.registrationDate ||
    custom['incorporation_date'] ||
    custom['registration_date'] ||
    custom['mca_date'] ||
    custom['date_of_incorporation'];

  const notes = String(evidence?.notes || '');

  let isVerified = false;
  if (dateStr) {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      isVerified = true;
    }
  }
  if (evidence?.mcaVerified || /mca\s+verified|verified\s+incorporation/i.test(notes)) {
    isVerified = true;
  }

  if (isVerified) {
    return null;
  }

  return `Unsupported incorporation claim: copy references "${claim}" but no verified incorporation date or registration record was found in company data.`;
}

/**
 * Extracts claims asserting a company's website is missing or not live.
 */
export function extractWebsiteLiveClaim(text: string): string | null {
  const haystack = String(text || '');
  if (!haystack.trim()) return null;

  const patterns = [
    /\b(?:isn't|is\s+not|not)\s+live\s+yet\b/i,
    /\blacks\s+an?\s+(?:active\s+)?(?:website|online\s+presence|digital\s+presence)\b/i,
    /\bwebsite\s+(?:is\s+down|offline|missing|unregistered)\b/i,
    /\bno\s+(?:active\s+)?website\b/i,
  ];

  for (const regex of patterns) {
    const m = regex.exec(haystack);
    if (m) return m[0].trim();
  }
  return null;
}

/**
 * Validates website claims against verified site audit evidence.
 */
export function validateWebsiteClaim(
  text: string,
  evidence?: CompanyVerificationEvidence
): string | null {
  const claim = extractWebsiteLiveClaim(text);
  if (!claim) return null;

  const custom = evidence?.customFields || {};
  const httpCode = String(evidence?.httpCode || custom['http_code'] || '').trim();
  const websiteStatus = String(evidence?.websiteStatus || custom['website_status'] || '').trim().toLowerCase();

  if (httpCode === '200' || websiteStatus === 'active' || websiteStatus === 'live') {
    return `Unsupported website claim: copy asserts digital presence "${claim}", but verified audit indicates status is live (HTTP 200).`;
  }

  if (httpCode === '504' || websiteStatus === 'timeout') {
    return `Inconclusive website claim: copy asserts digital presence "${claim}", but website audit was inconclusive (timeout/504).`;
  }

  return null;
}

/**
 * Validates personalization tokens and placeholder values.
 */
export function validatePersonalizationData(
  subject: string,
  bodyText: string,
  recipient?: { name?: string | null; companyName?: string | null; email?: string | null }
): string | null {
  const combined = `${subject}\n${bodyText}`;

  const tokenMatch = /\{\{([a-zA-Z0-9_-]+)\}\}/.exec(combined);
  if (tokenMatch) {
    return `Unresolved template token detected: "${tokenMatch[0]}". Ensure all merge fields are mapped.`;
  }

  if (/\b(?:undefined|null|\[Company Name\]|\[Recipient Name\])\b/i.test(combined)) {
    return 'Copy contains placeholder literal (e.g. "undefined" or "[Company Name]"). Review before sending.';
  }

  if (recipient?.name && recipient?.companyName && isCompanyNameLike(recipient.name, recipient.companyName)) {
    if (new RegExp(`^Hi\\s+${recipient.name}\\b`, 'im').test(bodyText)) {
      return 'Greeting addresses recipient by corporate name instead of personal name. Consider a neutral greeting.';
    }
  }

  return null;
}

export interface ComprehensiveValidationInput {
  subject: string;
  bodyText: string;
  companyName?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  proposedDeliverable?: string | null;
  sector?: string | null;
  customFields?: Record<string, string>;
  domain?: string | null;
  websiteStatus?: string | null;
  httpCode?: string | null;
  incorporationDate?: string | Date | null;
  notes?: string | null;
}

export interface ComprehensiveValidationResult {
  companyNameMismatch: string | null;
  unsupportedIncorporationClaim: string | null;
  unsupportedWebsiteClaim: string | null;
  personalizationWarning: string | null;
  unsupportedClaims: string[];
  warnings: string[];
  hasBlockingError: boolean;
  requiresReview: boolean;
}

/**
 * Executes distinct, independent validation checks on cold outreach copy.
 */
export function validateEmailCopy(input: ComprehensiveValidationInput): ComprehensiveValidationResult {
  const subject = input.subject || '';
  const body = input.bodyText || '';
  const combined = `${subject}\n\n${body}`;

  const mismatch =
    detectCompanyNameMismatch(subject, input.companyName) ||
    detectCompanyNameMismatch(body, input.companyName);

  const incorpClaim = validateIncorporationClaim(combined, {
    incorporationDate: input.incorporationDate,
    customFields: input.customFields,
    notes: input.notes,
  });

  const websiteClaim = validateWebsiteClaim(combined, {
    websiteStatus: input.websiteStatus,
    httpCode: input.httpCode,
    domain: input.domain,
    customFields: input.customFields,
  });

  const personalizationWarning = validatePersonalizationData(subject, body, {
    name: input.recipientName,
    companyName: input.companyName,
    email: input.recipientEmail,
  });

  const warnings: string[] = [];
  const unsupportedClaims: string[] = [];

  if (mismatch) {
    warnings.push(
      `Company name mismatch: copy references "${mismatch}" but this recipient is "${input.companyName}". Review before sending.`
    );
  }

  if (incorpClaim) {
    warnings.push(incorpClaim);
    unsupportedClaims.push(incorpClaim);
  }

  if (websiteClaim) {
    warnings.push(websiteClaim);
    unsupportedClaims.push(websiteClaim);
  }

  if (personalizationWarning) {
    warnings.push(personalizationWarning);
  }

  return {
    companyNameMismatch: mismatch,
    unsupportedIncorporationClaim: incorpClaim,
    unsupportedWebsiteClaim: websiteClaim,
    personalizationWarning,
    unsupportedClaims,
    warnings,
    hasBlockingError: Boolean(mismatch),
    requiresReview: Boolean(mismatch || incorpClaim || websiteClaim || personalizationWarning),
  };
}

export interface RepairClaimsContext {
  companyName: string;
  sector?: string | null;
  domain?: string | null;
  proposedDeliverable?: string | null;
  websiteStatus?: string | null;
  httpCode?: string | null;
  incorporationDate?: string | Date | null;
  notes?: string | null;
}

/**
 * Rewrites unsupported factual claims into neutral, professional, verified wording
 * while preserving the source company name, proposed service offer, and email structure.
 */
export function repairUnsupportedClaims(bodyText: string, context: RepairClaimsContext): string {
  let cleaned = String(bodyText || '');

  // 1. Repair unsupported incorporation claims when no verified date/MCA status exists
  const hasVerifiedIncorp = Boolean(
    context.incorporationDate || /mca\s+verified|verified\s+incorporation/i.test(context.notes || '')
  );
  if (!hasVerifiedIncorp) {
    const incorpSentenceRegex = /Noticed\s+[^.\n]+?\s+(?:was\s+)?(?:recently|newly|freshly)\s+incorporated(?:\s+under\s+[^.\n]+?)?\.\s*(?:Congratulations\s+on\s+the\s+new\s+venture\.)?/gi;
    if (incorpSentenceRegex.test(cleaned)) {
      const neutralIntro = `Noticed ${context.companyName} and your work${
        context.sector ? ` in ${context.sector}` : ' across the region'
      }. Hope your quarter is off to a productive start.`;
      cleaned = cleaned.replace(incorpSentenceRegex, neutralIntro);
    } else {
      cleaned = cleaned.replace(
        /\bwas\s+recently\s+incorporated\s+under\s+the\s+Ministry\s+of\s+Corporate\s+Affairs\s+gazette\b/gi,
        `operates in ${context.sector || 'the region'}`
      );
    }
  }

  // 2. Repair unsupported website offline claims if the website is verified live (HTTP 200 / active)
  const isSiteLive =
    context.httpCode === '200' || context.websiteStatus === 'active' || context.websiteStatus === 'live';
  if (isSiteLive) {
    const portalNotLiveRegex = /I observed that your dedicated digital intake and client portal infrastructure isn't live yet on\s+[a-zA-Z0-9.-]+/gi;
    if (portalNotLiveRegex.test(cleaned)) {
      cleaned = cleaned.replace(
        portalNotLiveRegex,
        `I reviewed ${context.domain || 'your digital platform'} and observed opportunities to add a dedicated interactive client portal infrastructure`
      );
    }
    cleaned = cleaned.replace(/\bisn't\s+live\s+yet\s+on\s+([a-zA-Z0-9.-]+)/gi, `can be directly expanded on $1`);
  }

  return cleaned;
}

export function isCompanyNameLike(name?: string | null, companyName?: string | null): boolean {
  if (!name || !name.trim()) return true;
  const n = name.trim().toLowerCase();
  if (companyName && n === companyName.trim().toLowerCase()) return true;
  const corporateIndicators = [
    /\b(ltd|pvt|private|limited|inc|corp|corporation|llc|llp|gmbh|co|company)\b/i,
    /\b(technologies|tech|solutions|enterprises|holdings|services|industries|systems|consulting)\b/i,
  ];
  return corporateIndicators.some((regex) => regex.test(n));
}

export interface BuildInterpolationValuesInput {
  companyName?: string | null;
  contactName?: string | null;
  contactFirstName?: string | null;
  contactLastName?: string | null;
  email?: string | null;
  domain?: string | null;
  sector?: string | null;
  proposedDeliverable?: string | null;
  industry?: string | null;
  city?: string | null;
  country?: string | null;
  websiteUrl?: string | null;
  senderName?: string | null;
  senderBusiness?: string | null;
  signOff?: string | null;
  signature?: string | null;
  contactDetails?: string | null;
  greetingFormat?: string | null;
  missingNameFallback?: string | null;
  customFields?: Record<string, string>;
}

/**
 * Builds the token -> value map for a single recipient, covering both the
 * canonical built-ins, workspace sender settings, and any bounded custom CSV columns.
 */
export function buildInterpolationValues(input: BuildInterpolationValuesInput): Record<string, string> {
  const values: Record<string, string> = {};
  const put = (key: string, value?: string | null) => {
    if (value !== undefined && value !== null && String(value).length > 0) {
      values[key] = String(value);
    }
  };

  put('company_name', input.companyName);
  put('company', input.companyName);

  const rawCustom = input.customFields || {};

  // Check if contact name is missing or looks like an organization
  const rawContact = input.contactName || rawCustom['director_full_name'] || '';
  const looksLikeCompany = isCompanyNameLike(rawContact, input.companyName);

  // Derive first/last name
  let firstName = input.contactFirstName || '';
  let lastName = input.contactLastName || '';
  if (!firstName && rawCustom['first_name']) firstName = rawCustom['first_name'];
  if ((!firstName || !lastName) && rawContact && !looksLikeCompany) {
    const parts = String(rawContact).trim().split(/\s+/);
    if (!firstName) firstName = parts[0] || '';
    if (!lastName && parts.length > 1) lastName = parts.slice(1).join(' ');
  }

  const cleanContactName = looksLikeCompany ? '' : rawContact;
  const cleanFirstName = looksLikeCompany ? '' : firstName;
  const fallbackGreeting = input.missingNameFallback || 'Hello,';

  put('contact_name', cleanContactName || input.companyName);
  put('recipient_name', cleanContactName || input.companyName);
  put('contact_first_name', cleanFirstName || 'there');
  put('first_name', cleanFirstName || 'there');
  put('contact_last_name', lastName);
  put('director_name', rawCustom['director_full_name'] || cleanContactName);
  put('director_full_name', rawCustom['director_full_name'] || cleanContactName);

  // Greeting token
  if (!cleanFirstName || looksLikeCompany) {
    put('greeting', fallbackGreeting);
  } else if (input.greetingFormat) {
    put('greeting', input.greetingFormat.replace(/\{\{\s*(?:contact_)?first_name\s*\}\}/gi, cleanFirstName));
  } else {
    put('greeting', `Hi ${cleanFirstName},`);
  }

  put('email', input.email);
  put('domain', input.domain || input.websiteUrl || rawCustom['domain']);
  put('website', input.websiteUrl || input.domain || rawCustom['domain']);
  put('sector', input.sector || rawCustom['sector'] || input.industry);
  put('industry', input.industry || rawCustom['sector'] || input.sector);
  put('proposed_deliverable', input.proposedDeliverable || rawCustom['proposed_deliverable']);
  put('deliverable', input.proposedDeliverable || rawCustom['proposed_deliverable']);
  put('city', input.city);
  put('country', input.country);

  // Sender settings variables
  put('sender_name', input.senderName || 'Vansh Aggarwal');
  put('sender_business', input.senderBusiness || 'Swaniki New Business Radar');
  put('business_name', input.senderBusiness || 'Swaniki New Business Radar');
  put('sign_off', input.signOff || 'Best regards,');
  put('signature', input.signature || input.senderName || 'Vansh Aggarwal');
  put('contact_details', input.contactDetails || '');

  const { customFields } = boundCustomFields(rawCustom);
  for (const [key, value] of Object.entries(customFields)) {
    // Custom fields never override canonical built-ins.
    if (!(key in values)) values[key] = value;
  }

  return values;
}

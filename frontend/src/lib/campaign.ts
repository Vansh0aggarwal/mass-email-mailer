import type { CampaignStatus, CampaignRecipient, RecipientStepDraft } from '../types';

export interface FixedFieldDef {
  key: string;
  label: string;
  required?: boolean;
}

/** Fixed destination fields offered in the mapping step, in display order. */
export const FIXED_FIELD_DEFS: FixedFieldDef[] = [
  { key: 'company_name', label: 'Company name', required: true },
  { key: 'contact_email', label: 'Contact email' },
  { key: 'contact_full_name', label: 'Contact full name' },
  { key: 'contact_first_name', label: 'Contact first name' },
  { key: 'contact_last_name', label: 'Contact last name' },
  { key: 'contact_role', label: 'Contact role / title' },
  { key: 'domain', label: 'Domain' },
  { key: 'website_url', label: 'Website URL' },
  { key: 'industry', label: 'Industry' },
  { key: 'sector', label: 'Sector' },
  { key: 'state_roc', label: 'State / ROC' },
  { key: 'city', label: 'City' },
  { key: 'country', label: 'Country' },
  { key: 'contact_phone', label: 'Contact phone' },
  { key: 'direct_phone', label: 'Direct phone' },
  { key: 'director_full_name', label: 'Director full name' },
  { key: 'contact_confidence', label: 'Contact confidence' },
  { key: 'website_status', label: 'Website status' },
  { key: 'site_audit_type', label: 'Site audit type' },
  { key: 'http_code', label: 'HTTP code' },
  { key: 'page_title', label: 'Page title' },
  { key: 'proposed_deliverable', label: 'Proposed deliverable' },
  { key: 'primary_tech_signal', label: 'Primary tech signal' },
  { key: 'authorized_capital', label: 'Authorized capital (INR)' },
  { key: 'step_1_subject', label: 'Step 1 subject' },
  { key: 'step_1_body', label: 'Step 1 body' },
  { key: 'step_2_subject', label: 'Step 2 subject' },
  { key: 'step_2_body', label: 'Step 2 body' },
  { key: 'step_3_subject', label: 'Step 3 subject' },
  { key: 'step_3_body', label: 'Step 3 body' },
  { key: 'services', label: 'Services' },
  { key: 'rating', label: 'Rating' },
  { key: 'notes', label: 'Notes' },
];

/**
 * Exact Swaniki column names + alternate aliases, keyed by internal field.
 * Mirrors the backend mapping layer so the mapping UI detects the real campaign
 * file out of the box while still allowing manual remapping of any header.
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
  contact_role: ['Contact Role', 'Role', 'Job Title', 'Position', 'Designation', 'Title'],
  contact_email: ['Contact Email', 'Work Email', 'Email Address', 'Email', 'E-mail', 'Contact E-mail'],
  contact_phone: ['Contact Phone', 'Phone', 'Phone Number', 'Contact Number', 'Telephone', 'Mobile'],
  direct_phone: ['Direct Phone', 'Direct Number'],
  director_full_name: ['Director Full Name', 'Director Name', 'Director'],
  contact_confidence: ['Contact Confidence', 'Confidence'],
  website_status: ['Website Status', 'Site Status'],
  site_audit_type: ['Site Audit Type', 'Audit Type'],
  http_code: ['HTTP Code', 'Http Code', 'HTTP Status', 'Status Code'],
  page_title: ['Page Title', 'Meta Title', 'Title Tag'],
  proposed_deliverable: ['Proposed Deliverable', 'Deliverable', 'Proposal'],
  primary_tech_signal: ['Primary Tech Signal', 'Tech Signal', 'Technology Signal'],
  authorized_capital: ['Authorized Capital (INR)', 'Authorized Capital', 'Authorised Capital (INR)', 'Authorised Capital'],
  step_1_subject: ['Step 1 Subject', 'Step1 Subject', 'Email 1 Subject', 'Subject 1'],
  step_1_body: ['Step 1 Body', 'Step1 Body', 'Email 1 Body', 'Body 1'],
  step_2_subject: ['Step 2 Subject', 'Step2 Subject', 'Email 2 Subject', 'Subject 2'],
  step_2_body: ['Step 2 Body', 'Step2 Body', 'Email 2 Body', 'Body 2'],
  step_3_subject: ['Step 3 Subject', 'Step3 Subject', 'Email 3 Subject', 'Subject 3'],
  step_3_body: ['Step 3 Body', 'Step3 Body', 'Email 3 Body', 'Body 3'],
  services: ['Services', 'Service', 'Offering', 'Offerings', 'Products'],
  rating: ['Rating', 'Grade', 'Score'],
  notes: ['Notes', 'Note', 'Comment', 'Comments', 'Description'],
};

/** Built-in merge tokens always available in step templates. */
export const BUILTIN_TOKENS: { token: string; description: string }[] = [
  { token: 'company_name', description: 'Company name' },
  { token: 'contact_name', description: 'Full contact name' },
  { token: 'contact_first_name', description: 'Contact first name' },
  { token: 'contact_last_name', description: 'Contact last name' },
  { token: 'industry', description: 'Industry' },
  { token: 'sector', description: 'Sector' },
  { token: 'city', description: 'City' },
  { token: 'country', description: 'Country' },
  { token: 'proposed_deliverable', description: 'Proposed deliverable' },
  { token: 'sender_name', description: 'Your sender name' },
  { token: 'sender_business', description: 'Sender business name' },
  { token: 'sign_off', description: 'Sender sign-off' },
  { token: 'signature', description: 'Sender signature' },
  { token: 'contact_details', description: 'Sender contact details' },
  { token: 'greeting', description: 'Personalized greeting' },
  { token: 'step_1_subject', description: 'Step 1 Subject from CSV' },
  { token: 'step_1_body', description: 'Step 1 Body from CSV' },
  { token: 'step_2_subject', description: 'Step 2 Subject from CSV' },
  { token: 'step_2_body', description: 'Step 2 Body from CSV' },
  { token: 'step_3_subject', description: 'Step 3 Subject from CSV' },
  { token: 'step_3_body', description: 'Step 3 Body from CSV' },
];

/** Mirrors the backend normalizeTokenKey so UI hints match what the server does. */
export function normalizeTokenKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The set of `{{token}}` names usable in step templates: the built-ins that are
 * actually mapped plus every custom column key.
 */
export function buildAvailableTokens(
  columnMapping: Record<string, string>,
  customFieldMapping: Record<string, string>
): string[] {
  const tokens = new Set<string>();
  for (const def of FIXED_FIELD_DEFS) {
    if (columnMapping[def.key]) tokens.add(def.key);
  }
  for (const sourceHeader of Object.values(customFieldMapping)) {
    const key = normalizeTokenKey(sourceHeader);
    if (key) tokens.add(key);
  }
  tokens.add('sender_name');
  tokens.add('sender_business');
  tokens.add('sign_off');
  tokens.add('signature');
  tokens.add('contact_details');
  tokens.add('greeting');
  return [...tokens].sort();
}

/** Finds `{{token}}` names referenced in a template that are not in `available`. */
export function findUnknownTokens(template: string, available: string[]): string[] {
  const known = new Set(available);
  const unknown = new Set<string>();
  for (const match of String(template || '').matchAll(/\{\{\s*([a-zA-Z0-9_\- ]+?)\s*\}\}/g)) {
    const key = normalizeTokenKey(match[1]);
    if (key && !known.has(key)) unknown.add(key);
  }
  return [...unknown];
}

const FIELD_GUESS_PATTERNS: Record<string, RegExp> = {
  company_name: /company|organi[sz]ed|account|business|name/i,
  contact_email: /e[\-]?mail/i,
  contact_full_name: /contact\s*name|full ?name|contact person/i,
  contact_first_name: /first/i,
  contact_last_name: /last|surname|family/i,
  contact_role: /role|title|position|designation/i,
  domain: /domain/i,
  website_url: /website|web ?site|\burl\b|\bsite\b/i,
  industry: /industry|vertical|category/i,
  sector: /sector/i,
  state_roc: /state|\broc\b/i,
  city: /city|town/i,
  country: /country|nation/i,
  contact_phone: /phone|mobile|tel\b/i,
  direct_phone: /direct phone|direct number/i,
  director_full_name: /director/i,
  contact_confidence: /confidence/i,
  website_status: /website status|site status/i,
  site_audit_type: /audit type/i,
  http_code: /http code|status code|http status/i,
  page_title: /page title|meta title|title tag/i,
  proposed_deliverable: /deliverable|proposal/i,
  primary_tech_signal: /tech signal|technology signal/i,
  authorized_capital: /authori[sz]ed capital/i,
  step_1_subject: /step\s*1\s*subject|email\s*1\s*subject/i,
  step_1_body: /step\s*1\s*body|email\s*1\s*body|body\s*1/i,
  step_2_subject: /step\s*2\s*subject|email\s*2\s*subject/i,
  step_2_body: /step\s*2\s*body|email\s*2\s*body|body\s*2/i,
  step_3_subject: /step\s*3\s*subject|email\s*3\s*subject/i,
  step_3_body: /step\s*3\s*body|email\s*3\s*body|body\s*3/i,
  services: /service|offering|product/i,
  rating: /rating|grade|score/i,
  notes: /note|comment|description/i,
};

/**
 * Best-effort mapping of CSV headers onto destination fields. Tries an exact
 * normalized field-key match, then the Swaniki alias table (so the real campaign
 * file is detected automatically), then a loose pattern. A header is never
 * assigned to two fields and the user can always override the result.
 */
export function guessColumnMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();

  const pick = (predicate: (h: string) => boolean): string | undefined =>
    headers.find((h) => !used.has(h) && predicate(h));

  for (const def of FIXED_FIELD_DEFS) {
    // 1. Exact normalized field-key match.
    let match = headers.find((h) => !used.has(h) && normalizeTokenKey(h) === def.key);

    // 2. Exact alias match from the Swaniki column set.
    if (!match) {
      const aliases = (SWANIKI_HEADER_ALIASES[def.key] || []).map((a) => normalizeTokenKey(a));
      match = headers.find((h) => !used.has(h) && aliases.includes(normalizeTokenKey(h)));
    }

    // 3. Loose pattern match.
    if (!match) {
      match = pick((h) => FIELD_GUESS_PATTERNS[def.key]?.test(h) ?? false);
    }

    if (match) {
      mapping[def.key] = match;
      used.add(match);
    }
  }

  return mapping;
}

export interface StatusMeta {
  label: string;
  className: string;
}

export function campaignStatusMeta(status: CampaignStatus): StatusMeta {
  switch (status) {
    case 'draft':
      return { label: 'Draft', className: 'badge-warning' };
    case 'generating':
      return { label: 'Generating', className: 'badge-info' };
    case 'ready_for_review':
      return { label: 'Ready for review', className: 'badge-info' };
    case 'scheduled':
      return { label: 'Scheduled', className: 'badge-info' };
    case 'sending':
      return { label: 'Sending', className: 'badge-info' };
    case 'paused':
      return { label: 'Paused', className: 'badge-warning' };
    case 'completed':
      return { label: 'Completed', className: 'badge-success' };
    case 'cancelled':
      return { label: 'Cancelled', className: 'badge-danger' };
    case 'failed':
      return { label: 'Failed', className: 'badge-danger' };
    default:
      return { label: status, className: 'badge-info' };
  }
}

export function recipientStatusClass(status: CampaignRecipient['status']): string {
  switch (status) {
    case 'sent':
      return 'badge-success';
    case 'replied':
      return 'badge-success';
    case 'failed':
      return 'badge-danger';
    case 'suppressed':
    case 'skipped':
      return 'badge-warning';
    case 'approved':
    case 'prepared':
      return 'badge-info';
    default:
      return 'badge-info';
  }
}

/**
 * Flattens the per-step draft slots into the next actionable step for a
 * recipient, used by the review table.
 */
export function nextActionableStep(recipient: CampaignRecipient): RecipientStepDraft | undefined {
  return recipient.stepDrafts.find((d) => d.status !== 'sent' && d.status !== 'skipped');
}

export function maskEmail(email: string): string {
  if (!email) return '—';
  if (email.includes('@invalid.local')) return '(Missing / invalid)';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const maskedLocal =
    local.length <= 2 ? local : `${local[0]}${'*'.repeat(Math.max(1, Math.min(local.length - 2, 6)))}${local[local.length - 1]}`;
  return `${maskedLocal}@${domain}`;
}

export function isValidEmailFormat(email: string): boolean {
  if (!email || email.includes('@invalid.local')) return false;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email.trim());
}


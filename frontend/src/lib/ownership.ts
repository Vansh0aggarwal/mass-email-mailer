import type { CompanyCreatedVia, UserDisplaySummary } from '../types';

/**
 * Prefers the resolved user's name, then email, then the stored id. Legacy
 * records without ownership data render an em dash instead of a fake name.
 */
export function displayUserName(
  user?: UserDisplaySummary | null,
  fallbackId?: string
): string {
  const name = user?.fullName?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  if (email) return email;
  const fallback = fallbackId?.trim();
  return fallback || '—';
}

export function companySourceLabel(source?: CompanyCreatedVia): string {
  switch (source) {
    case 'manual':
      return 'Manual';
    case 'csv_import':
      return 'CSV import';
    case 'api':
      return 'API';
    default:
      return 'Not recorded';
  }
}

export function formatAuditDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

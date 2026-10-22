/**
 * Pure helpers for the CSV import hub. Kept free of React/DOM so the inspect
 * success and failure handling can be unit tested directly.
 */

export interface InspectResponse {
  fileName: string | null;
  byteLength: number;
  rowCount: number;
  headers: string[];
  detectedMapping: Record<string, string>;
  unmappedHeaders: string[];
  missingRequiredFields: string[];
  sampleRows: Record<string, string>[];
  parseErrors: string[];
  limits?: { maxFileBytes: number; maxRows: number };
}

export interface PreviewSummary {
  totalRows: number;
  validRows: number;
  errorRows: number;
  duplicateRows: number;
  existingRows?: number;
  fileDuplicateRows?: number;
  missingOptionalRows?: number;
  websiteAuditWarningRows?: number;
  parsedRows: any[];
}

export interface PreviewResponse {
  headers: string[];
  parseErrors?: string[];
  unmappedHeaders?: string[];
  summary: PreviewSummary;
}

/** Human-readable byte formatting (e.g. 6.01 MB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/** Defensive shape check for an inspect response payload. */
export function isInspectResponse(data: any): data is InspectResponse {
  return (
    !!data &&
    typeof data === 'object' &&
    Array.isArray(data.headers) &&
    typeof data.rowCount === 'number' &&
    !!data.sampleRows
  );
}

/**
 * Turns an unknown thrown value (ApiError / Error / network error) into a safe,
 * user-facing message. Never exposes stack traces — only structured messages the
 * backend deliberately returned.
 */
export function describeImportError(err: unknown): string {
  if (!err) return 'The import request failed for an unknown reason.';

  const anyErr = err as any;
  const message: string | undefined = anyErr?.message;
  const code: string | undefined = anyErr?.code;
  const details = anyErr?.details;

  const parts: string[] = [];
  if (message) parts.push(String(message));

  // Zod-style issues surfaced by the backend error handler.
  if (Array.isArray(details)) {
    for (const issue of details) {
      if (issue?.message) parts.push(`• ${issue.path ? `${issue.path}: ` : ''}${issue.message}`);
    }
  } else if (details && typeof details === 'object' && details.message) {
    parts.push(String(details.message));
  }

  if (code === 'PAYLOAD_TOO_LARGE' || code === 'FILE_TOO_LARGE') {
    parts.push('Try splitting the file into smaller batches or raise the server upload limit.');
  }
  if (code === 'TOO_MANY_ROWS') {
    parts.push('Split the file into smaller batches and import them separately.');
  }

  return parts.length ? parts.join('\n') : 'The import request failed. Please check the file and try again.';
}

/** Short summary lines for a successful inspect response. */
export function summarizeInspect(resp: InspectResponse): { title: string; details: string[] } {
  const details = [
    `${resp.rowCount.toLocaleString()} rows · ${resp.headers.length} columns`,
    `File size: ${formatBytes(resp.byteLength)}`,
  ];
  if (resp.missingRequiredFields.length) {
    details.push(`Missing required mapping: ${resp.missingRequiredFields.join(', ')}`);
  }
  if (resp.parseErrors?.length) {
    details.push(`${resp.parseErrors.length} parser warning(s)`);
  }
  return {
    title: resp.fileName ? resp.fileName : 'Uploaded CSV',
    details,
  };
}

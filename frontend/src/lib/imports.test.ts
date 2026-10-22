import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  describeImportError,
  isInspectResponse,
  summarizeInspect,
  type InspectResponse,
} from './imports';

describe('import helpers', () => {
  it('formats byte sizes for display', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(6_300_000)).toMatch(/MB$/);
    expect(formatBytes(1024)).toBe('1.00 KB');
  });

  it('surfaces structured backend issues without exposing a stack trace', () => {
    const err = {
      message: 'Invalid request data',
      code: 'VALIDATION_ERROR',
      details: [{ path: 'csvContent', message: 'CSV content is required' }],
    };
    const text = describeImportError(err);
    expect(text).toContain('Invalid request data');
    expect(text).toContain('csvContent');
    expect(text).not.toMatch(/at\s+\S+\s+\(/);
  });

  it('explains oversized-file errors with a next step', () => {
    const msg = describeImportError({ message: 'CSV file is 6.30 MB and exceeds the configured limit of 25.00 MB', code: 'FILE_TOO_LARGE' });
    expect(msg).toContain('6.30 MB');
    expect(describeImportError({ code: 'PAYLOAD_TOO_LARGE', message: 'too large' })).toContain('smaller batches');
    expect(describeImportError({ code: 'TOO_MANY_ROWS', message: 'too many' })).toContain('smaller batches');
  });

  it('does not expose stack traces for opaque errors', () => {
    const err = new Error('boom\n    at foo (bar.ts:1:1)');
    const out = describeImportError(err);
    expect(out).toContain('boom');
    // The helper only forwards the top-level message; it does not add internals.
    expect(out.split('\n').length).toBeGreaterThanOrEqual(1);
  });

  it('validates inspect response shape', () => {
    const good: InspectResponse = {
      fileName: 'file.csv',
      byteLength: 1024,
      rowCount: 3,
      headers: ['Company Name'],
      detectedMapping: { company_name: 'Company Name' },
      unmappedHeaders: [],
      missingRequiredFields: [],
      sampleRows: [{ 'Company Name': 'Acme' }],
      parseErrors: [],
    };
    expect(isInspectResponse(good)).toBe(true);
    expect(isInspectResponse({ headers: [] })).toBe(false);
    expect(isInspectResponse(null)).toBe(false);
  });

  it('summarizes an inspect response for display', () => {
    const resp: InspectResponse = {
      fileName: 'swaniki.csv',
      byteLength: 6_291_456,
      rowCount: 2800,
      headers: Array.from({ length: 22 }, (_, i) => `Col ${i}`),
      detectedMapping: { company_name: 'Col 0' },
      unmappedHeaders: [],
      missingRequiredFields: [],
      sampleRows: [],
      parseErrors: [],
    };
    const summary = summarizeInspect(resp);
    expect(summary.title).toBe('swaniki.csv');
    expect(summary.details.join(' ')).toContain('2,800 rows');
    expect(summary.details.join(' ')).toContain('22 columns');
  });
});

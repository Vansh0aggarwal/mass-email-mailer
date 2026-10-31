import { describe, it, expect } from 'vitest';
import { companySourceLabel, displayUserName, formatAuditDate } from './ownership';

describe('ownership display helpers', () => {
  it('prefers the resolved full name, then email, then the raw id', () => {
    expect(displayUserName({ _id: 'u1', fullName: 'Alice Owner', email: 'alice@x.com' })).toBe('Alice Owner');
    expect(displayUserName({ _id: 'u1', email: 'alice@x.com' }, 'raw-id')).toBe('alice@x.com');
    expect(displayUserName(null, 'raw-id')).toBe('raw-id');
    expect(displayUserName(undefined, '')).toBe('—');
  });

  it('labels every intake source and legacy rows', () => {
    expect(companySourceLabel('manual')).toBe('Manual');
    expect(companySourceLabel('csv_import')).toBe('CSV import');
    expect(companySourceLabel('api')).toBe('API');
    expect(companySourceLabel(undefined)).toBe('Not recorded');
  });

  it('formats audit dates safely and renders legacy values as an em dash', () => {
    expect(formatAuditDate('2026-03-05T10:00:00.000Z')).toBe(new Date('2026-03-05T10:00:00.000Z').toLocaleDateString());
    expect(formatAuditDate(undefined)).toBe('—');
    expect(formatAuditDate(null)).toBe('—');
    expect(formatAuditDate('not-a-date')).toBe('—');
  });
});

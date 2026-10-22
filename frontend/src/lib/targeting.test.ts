import { describe, it, expect } from 'vitest';
import { CampaignRecipient } from '../types';
import {
  getRecipientCustomField,
  getAuditAnalysis,
  getTargetingEvidence,
  getAiRecommendation,
  getCompanyNameMismatch,
} from './targeting';

function makeRecipient(overrides: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return {
    _id: 'r1',
    campaignId: 'c1',
    rowNumber: 1,
    email: 'ada@acme.example.com',
    companyName: 'Acme Corp',
    customFields: {},
    status: 'approved',
    completedSteps: 0,
    stepDrafts: [],
    ...overrides,
  } as CampaignRecipient;
}

describe('getRecipientCustomField', () => {
  it('returns the first non-empty trimmed value from a plain object', () => {
    const r = makeRecipient({ customFields: { proposed_deliverable: '  SEO revamp  ' } });
    expect(getRecipientCustomField(r, ['proposed_deliverable'])).toBe('SEO revamp');
  });

  it('supports Map-like custom field bags', () => {
    const map = new Map<string, string>([['sector', 'Fintech']]);
    const r = makeRecipient({ customFields: map as any });
    expect(getRecipientCustomField(r, ['sector'])).toBe('Fintech');
  });

  it('skips blanks and returns undefined when none present', () => {
    expect(getRecipientCustomField(makeRecipient(), ['sector'])).toBeUndefined();
  });
});

describe('getAuditAnalysis', () => {
  it('never claims a website is missing on timeout', () => {
    const a = getAuditAnalysis('timeout', '504');
    expect(a.statusType).toBe('warning');
    expect(a.headline.toLowerCase()).toContain('unverified');
    expect(a.explanation.toLowerCase()).toContain('does not mean');
  });

  it('reports live sites as verified', () => {
    const a = getAuditAnalysis('live', '200', 'WordPress');
    expect(a.statusType).toBe('success');
    expect(a.headline).toContain('200');
  });

  it('handles absent audit data neutrally', () => {
    expect(getAuditAnalysis().statusType).toBe('neutral');
  });
});

describe('getTargetingEvidence', () => {
  it('uses the CSV proposed deliverable as the primary topic', () => {
    const r = makeRecipient({
      customFields: {
        proposed_deliverable: 'Website Modernization',
        sector: 'Manufacturing',
        website_status: 'live',
        http_code: '200',
      },
    });
    const ev = getTargetingEvidence(r);
    expect(ev.topic).toBe('Website Modernization');
    expect(ev.source).toBe('csv');
    expect(ev.audit.statusType).toBe('success');
    expect(ev.rows.map((x) => x.label)).toContain('Sector');
  });

  it('flags a blank topic as none while still exposing evidence', () => {
    const r = makeRecipient({ customFields: { sector: 'Retail' } });
    const ev = getTargetingEvidence(r);
    expect(ev.topic).toBeNull();
    expect(ev.source).toBe('none');
    expect(ev.rows).toHaveLength(1);
  });
});

describe('getAiRecommendation / getCompanyNameMismatch', () => {
  it('reads the AI recommendation from a step draft, distinct from CSV topic', () => {
    const r = makeRecipient({
      customFields: { proposed_deliverable: 'CSV Topic' },
      stepDrafts: [
        { stepIndex: 0, status: 'draft', draft: { recommendedServiceName: 'AI Topic' } as any },
      ],
    });
    expect(getAiRecommendation(r)).toBe('AI Topic');
  });

  it('surfaces a stored company-name mismatch for review', () => {
    const r = makeRecipient({
      stepDrafts: [{ stepIndex: 0, status: 'draft', draft: { companyNameMismatch: 'vansh GLOBAL PRIVATE LIMITED' } as any }],
    });
    expect(getCompanyNameMismatch(r)).toBe('vansh GLOBAL PRIVATE LIMITED');
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildChildCampaignName,
  computeSplitPlan,
  describeCampaignRange,
  formatDurationSeconds,
  formatFileSize,
  isSplitJobActive,
  isSplitJobTerminal,
} from './campaign-split';

describe('computeSplitPlan', () => {
  it('matches the documented split arithmetic', () => {
    expect(computeSplitPlan(10_000, 100).expectedCampaigns).toBe(100);
    expect(computeSplitPlan(10_000, 200).expectedCampaigns).toBe(50);
    expect(computeSplitPlan(10_000, 500).expectedCampaigns).toBe(20);
    expect(computeSplitPlan(10_000, 1000).expectedCampaigns).toBe(10);
  });

  it('never confuses contacts with campaigns', () => {
    const plan = computeSplitPlan(10_000, 100);
    expect(plan.validContacts).toBe(10_000);
    expect(plan.contactsPerCampaign).toBe(100);
    expect(plan.lastCampaignContacts).toBe(100);
  });

  it('handles totals that do not divide evenly', () => {
    const plan = computeSplitPlan(10_000, 300);
    expect(plan.expectedCampaigns).toBe(34);
    expect(plan.lastCampaignContacts).toBe(100);
  });

  it('handles zero and invalid input safely', () => {
    expect(computeSplitPlan(0, 100)).toEqual({
      validContacts: 0,
      contactsPerCampaign: 100,
      expectedCampaigns: 0,
      lastCampaignContacts: 0,
    });
    expect(computeSplitPlan(50, 0).contactsPerCampaign).toBe(1);
    expect(computeSplitPlan(50, -10).expectedCampaigns).toBe(50);
  });
});

describe('buildChildCampaignName', () => {
  it('pads campaign numbers to at least three digits', () => {
    expect(buildChildCampaignName('{group} – Campaign {number}', 'October Prospect Import', 1, 100)).toBe(
      'October Prospect Import – Campaign 001'
    );
    expect(buildChildCampaignName('{group} – Campaign {number}', 'October Prospect Import', 100, 100)).toBe(
      'October Prospect Import – Campaign 100'
    );
  });

  it('widens padding when more than 999 campaigns are expected', () => {
    expect(buildChildCampaignName('{group} {number}', 'Big', 7, 1200)).toBe('Big 0007');
  });

  it('falls back to the default pattern when {number} is missing', () => {
    expect(buildChildCampaignName('Static name', 'Group', 2, 10)).toBe('Group – Campaign 002');
  });
});

describe('range and status helpers', () => {
  it('describes contiguous campaign contact ranges', () => {
    expect(describeCampaignRange(1, 100, 100, 100)).toBe('Contacts 1–100');
    expect(describeCampaignRange(2, 100, 100, 100)).toBe('Contacts 101–200');
    expect(describeCampaignRange(34, 300, 100, 34)).toBe('Contacts 9,901–10,000');
  });

  it('classifies active and terminal states', () => {
    expect(isSplitJobActive('queued')).toBe(true);
    expect(isSplitJobActive('analyzing')).toBe(true);
    expect(isSplitJobActive('generating')).toBe(true);
    expect(isSplitJobActive('ready')).toBe(false);
    expect(isSplitJobTerminal('completed')).toBe(true);
    expect(isSplitJobTerminal('completed_with_errors')).toBe(true);
    expect(isSplitJobTerminal('failed')).toBe(true);
    expect(isSplitJobTerminal('cancelled')).toBe(true);
    expect(isSplitJobTerminal('ready')).toBe(false);
  });
});

describe('formatting helpers', () => {
  it('formats file sizes and durations', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatDurationSeconds(45)).toBe('45s');
    expect(formatDurationSeconds(125)).toBe('2m 5s');
    expect(formatDurationSeconds(0)).toBe('—');
  });
});

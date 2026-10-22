import { describe, it, expect } from 'vitest';
import {
  normalizeTokenKey,
  buildAvailableTokens,
  findUnknownTokens,
  campaignStatusMeta,
  recipientStatusClass,
  nextActionableStep,
  guessColumnMapping,
} from './campaign';
import type { CampaignRecipient } from '../types';

describe('campaign helpers', () => {
  it('normalizes token keys to snake_case like the backend', () => {
    expect(normalizeTokenKey('Company Name')).toBe('company_name');
    expect(normalizeTokenKey('  Plan-Tier ')).toBe('plan_tier');
  });

  it('builds available tokens from mapped fixed fields and custom columns', () => {
    const tokens = buildAvailableTokens(
      { company_name: 'Company', contact_first_name: 'First' },
      { Plan: 'plan_tier' }
    );
    expect(tokens).toContain('company_name');
    expect(tokens).toContain('contact_first_name');
    expect(tokens).toContain('plan_tier');
    expect(tokens).toContain('sender_name');
    expect(tokens).not.toContain('country');
  });

  it('detects unknown tokens referenced in a template', () => {
    const unknown = findUnknownTokens('Hi {{company_name}} in {{unknown_place}}', [
      'company_name',
      'sender_name',
    ]);
    expect(unknown).toEqual(['unknown_place']);
  });

  it('guesses column mapping from common header names without reusing a header', () => {
    const mapping = guessColumnMapping(['Company Name', 'Email Address', 'First Name', 'Industry']);
    expect(mapping.company_name).toBe('Company Name');
    expect(mapping.contact_email).toBe('Email Address');
    expect(mapping.contact_first_name).toBe('First Name');
    expect(mapping.industry).toBe('Industry');
    expect(new Set(Object.values(mapping)).size).toBe(Object.values(mapping).length);
  });

  it('maps campaign statuses to badge classes', () => {
    expect(campaignStatusMeta('completed').className).toBe('badge-success');
    expect(campaignStatusMeta('failed').className).toBe('badge-danger');
    expect(campaignStatusMeta('draft').className).toBe('badge-warning');
  });

  it('maps recipient statuses and finds the next actionable step', () => {
    expect(recipientStatusClass('sent')).toBe('badge-success');
    expect(recipientStatusClass('suppressed')).toBe('badge-warning');

    const recipient = {
      stepDrafts: [
        { stepIndex: 0, status: 'sent' },
        { stepIndex: 1, status: 'draft' },
      ],
    } as CampaignRecipient;

    expect(nextActionableStep(recipient)?.stepIndex).toBe(1);
  });
});

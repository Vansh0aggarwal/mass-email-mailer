import { describe, it, expect } from 'vitest';
import { describeAccountStatus } from './MailSidebar';
import type { EmailAccount } from '../../types';

function account(overrides: Partial<EmailAccount>): EmailAccount {
  return {
    _id: 'acc_1',
    organizationId: 'org_1',
    emailAddress: 'user@example.com',
    displayName: 'User',
    provider: 'gmail',
    status: 'connected',
    dailySendLimit: 100,
    sendsToday: 0,
    isPaused: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as EmailAccount;
}

describe('describeAccountStatus', () => {
  it('labels a non-Gmail provider as Sandbox and never asks for reconnect', () => {
    const status = describeAccountStatus(account({ provider: 'mock' }));
    expect(status.label).toBe('Sandbox');
    expect(status.needsReconnect).toBe(false);
  });

  it('labels a connected, idle Gmail account as Connected', () => {
    const status = describeAccountStatus(account({ syncStatus: 'idle' }));
    expect(status.label).toBe('Connected');
    expect(status.dotClass).toBe('bg-success');
    expect(status.needsReconnect).toBe(false);
  });

  it('labels an errored Gmail account as needing reconnect', () => {
    const status = describeAccountStatus(account({ status: 'error' }));
    expect(status.label).toBe('Reconnect');
    expect(status.needsReconnect).toBe(true);
  });

  it('labels a disconnected Gmail account as Disconnected and needing reconnect', () => {
    const status = describeAccountStatus(account({ status: 'disconnected' }));
    expect(status.label).toBe('Disconnected');
    expect(status.needsReconnect).toBe(true);
  });

  it('labels a paused Gmail account without demanding a reconnect', () => {
    const status = describeAccountStatus(account({ status: 'paused' }));
    expect(status.label).toBe('Paused');
    expect(status.needsReconnect).toBe(false);
  });

  it('treats isPaused as needing reconnect even when status is connected', () => {
    const status = describeAccountStatus(account({ status: 'connected', isPaused: true }));
    expect(status.label).toBe('Reconnect');
    expect(status.needsReconnect).toBe(true);
  });

  it('surfaces an in-progress sync', () => {
    const status = describeAccountStatus(account({ syncStatus: 'syncing' }));
    expect(status.label).toBe('Syncing');
  });
});

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  normalizeTheme,
  persistTheme,
  readStoredTheme,
  resolveTheme,
} from './theme';

function fakeStorage(value: string | null): Pick<Storage, 'getItem'> {
  return { getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null) };
}

describe('theme preference resolution', () => {
  it('defaults to the system preference', () => {
    expect(DEFAULT_THEME).toBe('system');
    expect(THEME_STORAGE_KEY).toBe('radar_theme');
  });

  it('accepts the three valid preferences and coerces everything else', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('system')).toBe('system');
    expect(normalizeTheme('DARK')).toBe('system');
    expect(normalizeTheme('')).toBe('system');
    expect(normalizeTheme(null)).toBe('system');
    expect(normalizeTheme(undefined)).toBe('system');
    expect(normalizeTheme(42)).toBe('system');
  });

  it('resolves explicit preferences regardless of the OS signal', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('resolves system against the OS prefers-color-scheme signal', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('reads the persisted preference and falls back safely', () => {
    expect(readStoredTheme(fakeStorage('dark'))).toBe('dark');
    expect(readStoredTheme(fakeStorage('light'))).toBe('light');
    expect(readStoredTheme(fakeStorage('nonsense'))).toBe('system');
    expect(readStoredTheme(fakeStorage(null))).toBe('system');
    expect(readStoredTheme(null)).toBe('system');
  });

  it('survives a throwing storage implementation', () => {
    const throwing: Pick<Storage, 'getItem'> = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredTheme(throwing)).toBe('system');
    expect(() =>
      persistTheme('dark', {
        setItem: () => {
          throw new Error('quota');
        },
      })
    ).not.toThrow();
  });

  it('persists the selected preference under the storage key', () => {
    const written: Record<string, string> = {};
    persistTheme('dark', { setItem: (key, value) => void (written[key] = value) });
    expect(written[THEME_STORAGE_KEY]).toBe('dark');
  });
});

/*
 * Central theme primitives.
 *
 * The application supports three preferences:
 *   - 'light'  : always light, regardless of the OS
 *   - 'dark'   : always dark
 *   - 'system' — follow the operating system's `prefers-color-scheme`
 *
 * The resolved palette is applied by toggling the `dark` class on <html>,
 * which activates the semantic design tokens defined in `src/index.css`
 * (`:root` = light, `.dark` = dark). Everything else in the app references
 * those tokens (app / surface / line / ink / accent), so a single class flip
 * re-themes every page, layout, modal and workspace.
 *
 * The functions here are intentionally pure/DOM-light so they can be unit
 * tested in the node test environment.
 */

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'radar_theme';
export const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';
export const DEFAULT_THEME: Theme = 'system';

/** Coerces an arbitrary stored/parsed value into a valid theme preference. */
export function normalizeTheme(value: unknown): Theme {
  return value === 'light' || value === 'dark' || value === 'system' ? value : DEFAULT_THEME;
}

/** Resolves a preference + the current OS signal into the theme to render. */
export function resolveTheme(theme: Theme, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light';
  return theme;
}

/** Reads the persisted preference, falling back to the default safely. */
export function readStoredTheme(
  storage: Pick<Storage, 'getItem'> | null = typeof window !== 'undefined' ? window.localStorage : null
): Theme {
  try {
    return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_THEME;
  }
}

export function persistTheme(
  theme: Theme,
  storage: Pick<Storage, 'setItem'> | null = typeof window !== 'undefined' ? window.localStorage : null
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore storage failures (private mode, quota, etc.) */
  }
}

/** Whether the operating system currently prefers a dark appearance. */
export function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.(THEME_MEDIA_QUERY).matches;
  } catch {
    return false;
  }
}

export function getInitialTheme(): Theme {
  return readStoredTheme();
}

const META_THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f5f6f9',
  dark: '#0b0c0f',
};

function updateMetaThemeColor(resolved: ResolvedTheme): void {
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', META_THEME_COLORS[resolved]);
  } catch {
    /* meta tag is a progressive enhancement only */
  }
}

/**
 * Applies the resolved theme to the document root: toggles `.dark`, sets
 * `color-scheme` (for native form controls / scrollbars) and syncs the
 * mobile theme-color meta tag. Returns the resolved theme.
 */
export function applyTheme(theme: Theme, prefersDark: boolean = systemPrefersDark()): ResolvedTheme {
  const resolved = resolveTheme(theme, prefersDark);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.style.colorScheme = resolved;
    updateMetaThemeColor(resolved);
  }
  return resolved;
}

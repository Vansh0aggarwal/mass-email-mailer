import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_THEME,
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  applyTheme,
  getInitialTheme,
  normalizeTheme,
  persistTheme,
  resolveTheme,
  systemPrefersDark,
  type ResolvedTheme,
  type Theme,
} from '../lib/theme';

interface ThemeContextValue {
  /** The user's stored preference: 'light' | 'dark' | 'system'. */
  theme: Theme;
  /** The palette actually rendered right now: 'light' | 'dark'. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** Cycles light → dark → system (for the header quick-switch). */
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const CYCLE: Theme[] = ['light', 'dark', 'system'];

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => getInitialTheme());
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

  const resolvedTheme = resolveTheme(theme, prefersDark);

  // Keep the OS signal in sync so 'system' reacts to live preference changes.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia(THEME_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    setPrefersDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // Apply the resolved theme whenever the preference or OS signal changes.
  useEffect(() => {
    applyTheme(theme, prefersDark);
  }, [theme, prefersDark]);

  // Mirror changes made in other tabs/windows.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setThemeState(normalizeTheme(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    persistTheme(next);
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeState((previous) => {
      const next = CYCLE[(CYCLE.indexOf(previous) + 1) % CYCLE.length] ?? DEFAULT_THEME;
      persistTheme(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, cycleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

import { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import type { Theme } from '../../lib/theme';

const OPTIONS: { value: Theme; label: string; description: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', description: 'Always use the light palette', icon: Sun },
  { value: 'dark', label: 'Dark', description: 'Always use the dark palette', icon: Moon },
  { value: 'system', label: 'System', description: 'Match your device appearance', icon: Monitor },
];

export function ThemeToggle({ variant = 'header' }: { variant?: 'header' | 'rail' }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const ActiveIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  if (variant === 'rail') {
    const RailIcon = resolvedTheme === 'dark' ? Moon : Sun;
    const nextLabel = resolvedTheme === 'dark' ? 'light' : 'dark';

    return (
      <button
        type="button"
        onClick={() => setTheme(nextLabel)}
        aria-label={`Switch to ${nextLabel} theme`}
        aria-pressed={resolvedTheme === 'dark'}
        className="group relative flex h-11 w-11 items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <RailIcon className="h-[18px] w-[18px]" />
        <span className="app-rail-tooltip" role="tooltip">
          Switch Theme
        </span>
      </button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen((open) => !open)}
        aria-label="Change color theme"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="Change color theme"
        className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-surface-3 border border-transparent hover:border-line transition-colors active:scale-95"
      >
        <ActiveIcon className="w-4 h-4" />
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 p-1.5 rounded-xl bg-surface border border-line shadow-pop z-50 animate-scale-in"
        >
          {OPTIONS.map(({ value, label, description, icon: Icon }) => {
            const isActive = theme === value;
            return (
              <button
                key={value}
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  setTheme(value);
                  setIsOpen(false);
                }}
                className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors ${
                  isActive ? 'bg-accent/10 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-semibold text-ink">{label}</span>
                  <span className="block text-[10px] text-ink-subtle leading-snug">{description}</span>
                </span>
                {isActive && <Check className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

# Theming & Design Tokens

Swaniki supports three user-selectable themes — **Light**, **Dark** and **System** —
that apply consistently across every route, layout, modal and workspace.

## How it works

1. A single semantic palette lives in `frontend/src/index.css`:
   - `:root` defines the **light** value of every token.
   - `.dark` overrides them for the dark palette.
2. Tailwind (`frontend/tailwind.config.js`, `darkMode: 'class'`) exposes those tokens
   as utilities (e.g. `bg-app`, `text-ink-muted`, `border-line`, `bg-surface-2`).
3. `frontend/src/main.tsx` wraps the app in `<ThemeProvider>`
   (`src/context/ThemeContext.tsx`), which owns the preference and flips the `dark`
   class on `<html>` plus `color-scheme` on the document root.
4. A tiny inline script in `index.html` runs **before React and before first paint**
   to apply the persisted preference, so there is no light/dark flash on load.

Components never hard-code theme colors; they consume tokens so a single class flip
re-themes the entire product.

## Preferences & persistence

| Preference | Behavior |
| ---------- | -------- |
| `light`    | Always the light palette |
| `dark`     | Always the dark palette |
| `system`   | Follows the OS `prefers-color-scheme` (default), reacting live to OS changes |

The choice is stored in `localStorage` under `radar_theme` and mirrors across open
tabs via the `storage` event.

## Where users change it

- **Header quick-switch** — the theme button in the top bar opens a Light / Dark /
  System menu (`src/components/layout/ThemeToggle.tsx`).
- **Settings → Appearance** — full-width option cards (`src/pages/SettingsPage.tsx`).

Both read from and write to the same `useTheme()` context, so they always agree.

## Design tokens

Defined in `src/index.css` under `:root` (light) and `.dark`:

| Token | Utility | Purpose |
| ----- | ------- | ------- |
| `--app` | `bg-app` | Page background |
| `--surface` / `--surface-2` / `--surface-3` | `bg-surface`, `bg-surface-2`, `bg-surface-3` | Cards, inputs, hover fills |
| `--line` / `--line-strong` | `border-line`, `border-line-strong` | Borders / dividers |
| `--ink` / `--ink-muted` / `--ink-subtle` | `text-ink`, `text-ink-muted`, `text-ink-subtle` | Primary / secondary / tertiary text |
| `--accent`, `--accent-strong`, `--accent-fg` | `bg-accent`, `text-accent`, `text-accent-fg` | Brand blue + on-accent text |
| `--success`, `--warning`, `--danger`, `--info` | `text-success`, `bg-warning/10`, … | Theme-aware status colors |
| `--overlay` | `bg-overlay/60` | Modal scrims |

Each token is exposed as `rgb(var(--x) / <alpha-value>)`, so opacity modifiers work
(`bg-accent/10`, `text-ink/50`).

## Conventions for new code

- Use semantic tokens, not raw Tailwind colors (`bg-surface`, not `bg-slate-800`).
- For status text that needs a different shade per theme, prefer the `success` /
  `warning` / `danger` / `info` tokens over `dark:` overrides.
- Brand-only colors (e.g. the Google logo) may stay hard-coded.

## Verification

- `npm run typecheck --workspace=frontend`
- `npm run test --workspace=frontend` (includes `src/lib/theme.test.ts`)
- `npm run build --workspace=frontend`

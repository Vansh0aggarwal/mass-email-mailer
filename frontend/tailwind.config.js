/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic, theme-aware tokens (see index.css :root / .dark)
        app: 'rgb(var(--app) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          2: 'rgb(var(--surface-2) / <alpha-value>)',
          3: 'rgb(var(--surface-3) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          subtle: 'rgb(var(--ink-subtle) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          strong: 'rgb(var(--accent-strong) / <alpha-value>)',
          fg: 'rgb(var(--accent-fg) / <alpha-value>)',
        },
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
        overlay: 'rgb(var(--overlay) / <alpha-value>)',

        // Legacy aliases kept for backwards compatibility
        border: 'hsl(var(--border, 214.3 31.8% 91.4%))',
        background: 'hsl(var(--background, 0 0% 100%))',
        foreground: 'hsl(var(--foreground, 222.2 84% 4.9%))',
        ios: {
          blue: '#0A84FF',
          blueHover: '#0071E3',
          green: '#30D158',
          indigo: '#5E5CE6',
          orange: '#FF9F0A',
          pink: '#FF375F',
          purple: '#BF5AF2',
          red: '#FF453A',
          teal: '#64D2FF',
          yellow: '#FFD60A',
          gray: '#8E8E93',
        },
        primary: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#3B82F6',
          600: '#2563EB',
          700: '#1D4ED8',
          800: '#1E40AF',
          900: '#1E3A8A',
          950: '#172554',
        },
      },
      borderRadius: {
        'ios-sm': '0.5rem',
        'ios': '0.75rem',
        'ios-lg': '1rem',
        'ios-xl': '1.25rem',
        'card': '0.75rem',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'Inter',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: ['SF Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(var(--overlay) / 0.04)',
        raised: '0 2px 8px rgb(var(--overlay) / 0.06)',
        pop: '0 12px 32px rgb(var(--overlay) / 0.14)',
      },
    },
  },
  plugins: [],
}

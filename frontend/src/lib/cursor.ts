/*
 * Custom cursor primitives.
 *
 * Everything in this module is pure and DOM free so it can be unit tested in
 * the Node test environment (`src/lib/cursor.test.ts`). The React component
 * (`src/components/common/CustomCursor.tsx`) owns the DOM nodes, the event
 * listeners and the animation loop; it only asks this module *what* the
 * cursor should look like and *how* it should move.
 *
 * Design rules that shape this file:
 *  - two muted inks only (near black and medium grey), the theme picks one,
 *  - never overshoot: the smoothing is exponential, so the cursor can not
 *    wobble or oscillate,
 *  - frame rate independent: the smoothing constant is a time, not a factor,
 *    so a 60 Hz and a 144 Hz display feel the same,
 *  - only genuinely interactive elements enlarge the cursor.
 */

/** Every state the cursor can be in. */
export type CursorMode =
  | 'default'
  | 'link'
  | 'button'
  | 'card'
  | 'image'
  | 'text'
  | 'drag'
  | 'disabled'
  | 'hidden';

/** Only devices with a precise pointer and real hover get the custom cursor. */
export const CURSOR_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

/** Users who asked for less motion get a simplified cursor. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The two inks the cursor is allowed to use. Anything else is noise.
 *  - 23 23 23 is #171717, a near black that reads as "ink" on light surfaces.
 *  - 163 163 163 is #A3A3A3, a medium grey that stays quiet on dark surfaces.
 * A pure white cursor in dark mode is deliberately avoided.
 */
export const CURSOR_INK_PRIMARY = 23;
export const CURSOR_INK_MUTED = 163;

/** The geometry of the untouched cursor, in CSS pixels. */
export const CURSOR_DOT_SIZE = 8;
export const CURSOR_RING_SIZE = 26;

/**
 * The modes that are allowed to enlarge the cursor. The concrete scale lives
 * in `index.css` next to the rest of the visual rules — the cursor only ever
 * grows over something that really does something.
 */
export const INTERACTIVE_MODES: readonly CursorMode[] = [
  'link',
  'button',
  'card',
  'image',
  'drag',
];

/** Whether a mode enlarges the cursor. */
export function isInteractiveMode(mode: CursorMode): boolean {
  return INTERACTIVE_MODES.includes(mode);
}

/** Every mode the cursor understands. */
export const CURSOR_MODES: readonly CursorMode[] = [
  'default',
  'link',
  'button',
  'card',
  'image',
  'text',
  'drag',
  'disabled',
  'hidden',
];

/** Type guard for a `data-cursor` attribute value. */
export function isCursorMode(value: string | null | undefined): value is CursorMode {
  return typeof value === 'string' && (CURSOR_MODES as readonly string[]).includes(value);
}

/**
 * Elements that are genuinely interactive. Everything the cursor reacts to
 * has to match one of these — semantic links, buttons, form controls, ARIA
 * widgets and explicitly marked custom controls.
 */
export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'summary',
  'select',
  'input',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[data-cursor]',
].join(', ');

/** Controls that behave like a button. */
export const BUTTON_SELECTOR = [
  'button',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  'summary',
  'select',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
].join(', ');

/** Media that reads as an image. */
export const MEDIA_SELECTOR = 'img, picture, video, canvas';

/** Surfaces that read as a card. */
export const CARD_SELECTOR = '.ios-card, .surface-card';

/** Input types that are a control rather than a text field. */
export const NON_TEXT_INPUT_TYPES: readonly string[] = [
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
  'hidden',
];

/** Facts about the element under the pointer, collected by the component. */
export interface CursorTargetInfo {
  /** An explicit `data-cursor="…"` override found on the element or an ancestor. */
  explicit?: CursorMode | null;
  /** The pointer is over an embedded document (the native cursor stays there). */
  isFrame?: boolean;
  /** The target (or an ancestor) is disabled. */
  isDisabled?: boolean;
  /** A text field, a textarea or an editable region. */
  isTextInput?: boolean;
  /** A draggable element. */
  isDragging?: boolean;
  /** A button or something that behaves like one. */
  isButton?: boolean;
  /** An anchor with a target. */
  isLink?: boolean;
  /** A card that is clickable itself. */
  isCard?: boolean;
  /** An image that is clickable itself. */
  isImage?: boolean;
}

/**
 * Maps the facts about the element under the pointer onto a cursor mode.
 *
 * The order encodes the specificity: a disabled control wins over everything,
 * a text field beats a generic container, and a real control beats the
 * surrounding card.
 */
export function resolveCursorMode(info: CursorTargetInfo): CursorMode {
  if (info.isFrame) return 'hidden';
  if (info.explicit === 'hidden') return 'hidden';
  if (info.isDisabled) return 'disabled';
  if (info.isTextInput) return 'text';
  if (info.isDragging) return 'drag';
  if (info.isButton) return 'button';
  if (info.isLink) return 'link';
  if (info.isImage) return 'image';
  if (info.isCard) return 'card';
  if (info.explicit) return info.explicit;
  return 'default';
}

/** Modes that carry a contextual label without an explicit opt-in. */
export const CURSOR_MODE_LABELS: Partial<Record<CursorMode, string>> = {
  drag: 'DRAG',
};

/** Longest label that is rendered, so a stray attribute can not break the layout. */
const MAX_LABEL_LENGTH = 14;

/**
 * The contextual label of the cursor: an explicit `data-cursor-label` wins,
 * otherwise the mode may provide one. `undefined` means "no label".
 */
export function resolveCursorLabel(mode: CursorMode, explicit?: string | null): string | undefined {
  const raw = explicit?.trim();
  if (raw) return raw.toUpperCase().slice(0, MAX_LABEL_LENGTH);
  return CURSOR_MODE_LABELS[mode];
}

/**
 * Frame rate independent exponential smoothing.
 *
 * `tau` is the time (in seconds) it takes to cover ~63% of the remaining
 * distance. The result can never overshoot the target, so the cursor is
 * always calm — no wobble, no oscillation, no jitter.
 */
export function damp(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Clamps a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** True when every delta is smaller than the given epsilon. */
export function isSettled(deltas: number[], epsilon: number): boolean {
  return deltas.every((delta) => Math.abs(delta) < epsilon);
}

/** An sRGB colour with its alpha channel. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Parses the `rgb()` / `rgba()` output of `getComputedStyle`.
 * Returns `null` for every other notation (named colours, `transparent`, …).
 */
export function parseCssColor(value: string | null | undefined): RgbColor | null {
  if (!value) return null;
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;

  const parts = match[1]
    .split(/[\s,/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;

  const channel = (raw: string): number => {
    const numeric = raw.endsWith('%') ? (parseFloat(raw) / 100) * 255 : parseFloat(raw);
    return Number.isFinite(numeric) ? clamp(numeric, 0, 255) : 0;
  };

  const alpha = parts.length > 3 ? parseFloat(parts[3]) : 1;
  return {
    r: channel(parts[0]),
    g: channel(parts[1]),
    b: channel(parts[2]),
    a: Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1,
  };
}

/** WCAG relative luminance of a colour (0 = black, 1 = white). */
export function relativeLuminance(color: RgbColor): number {
  const linear = (value: number): number => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** Surfaces darker than this need the grey ink to stay visible. */
export const DARK_SURFACE_LUMINANCE = 0.42;

/**
 * Whether the cursor has to swap to its opposite ink to stay readable on the
 * surface under the pointer. `null` means "unknown surface", in which case
 * the theme ink is kept.
 */
export function shouldInvertCursor(luminance: number | null): boolean {
  if (luminance === null || !Number.isFinite(luminance)) return false;
  return luminance < DARK_SURFACE_LUMINANCE;
}

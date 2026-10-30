/*
 * Custom cursor primitives.
 *
 * Everything here is pure and DOM free so it can be unit tested in the Node
 * test environment. The React component (`components/common/CustomCursor.tsx`)
 * owns the DOM and the listeners; this module only holds the geometry, the
 * selectors and the precedence rules.
 *
 * The cursor is deliberately minimal: one solid #CCD0CF circle, no ring, no
 * label, no glow. It only grows over something that really does something.
 */

/** Only devices with a precise pointer and real hover get the custom cursor. */
export const CURSOR_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

/** Users who prefer reduced motion keep the native cursor. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The four visual states the dot can be in. */
export type CursorState = 'default' | 'hover' | 'native' | 'hidden';

/** The one allowed ink, from the application palette. */
export const CURSOR_COLOR = '#CCD0CF';

/** Geometry, in CSS pixels. */
export const CURSOR_SIZE = 10;
export const CURSOR_HOVER_SIZE = 17;
export const CURSOR_PRESS_SIZE = 25;

/**
 * The sizes are reached by scaling the 10px dot, so the browser only ever
 * animates a transform — never width, height or layout.
 */
export const CURSOR_DEFAULT_SCALE = 1;
export const CURSOR_HOVER_SCALE = CURSOR_HOVER_SIZE / CURSOR_SIZE;
export const CURSOR_PRESS_SCALE = CURSOR_PRESS_SIZE / CURSOR_SIZE;

/** Above every dialog, dropdown and toast in the application. */
export const CURSOR_Z_INDEX = 2147483647;

/* -------------------------------------------------------------------------
 * Motion
 * ---------------------------------------------------------------------- */

/**
 * Fraction of the remaining distance the cursor covers on a 60Hz frame.
 * Converted to elapsed time each frame, so a 120Hz or 144Hz display follows
 * at the same physical speed instead of twice as fast.
 */
export const POSITION_SMOOTHING = 0.22;

/** A stalled frame (tab throttling, GC pause) never integrates beyond this. */
export const CURSOR_MAX_FRAME_SECONDS = 1 / 30;

export interface CursorSpring {
  stiffness: number;
  damping: number;
}

export interface CursorSpringState {
  value: number;
  velocity: number;
}

/**
 * Spring-damper presets. Each is tuned for a visual duration at roughly 60Hz:
 * hover-in settles in ~180ms, hover-out in ~230ms, press in ~130ms and a
 * press release in ~180ms. Damping ratios stay between 0.8 and 1.0, which
 * gives a barely perceptible overshoot on press and none on hover.
 */
export const CURSOR_SPRINGS: Record<'hoverIn' | 'hoverOut' | 'press' | 'release', CursorSpring> = {
  hoverIn: { stiffness: 1500, damping: 69.7 }, // ζ ≈ 0.90
  hoverOut: { stiffness: 1936, damping: 88 }, // ζ = 1.00
  press: { stiffness: 6000, damping: 123.9 }, // ζ ≈ 0.80
  release: { stiffness: 1700, damping: 74.2 }, // ζ ≈ 0.90
};

/**
 * Elements that enlarge the cursor. Everything interactive — buttons, links,
 * navigation items, tabs, dropdown triggers, ARIA widgets and custom
 * clickable surfaces — has to match one of these. Delegated listeners plus
 * `closest()` mean dynamically rendered components are covered too.
 */
export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'summary',
  'label',
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
  '.cursor-pointer',
  '[data-cursor="interactive"]',
].join(', ');

/** Input types that are a control rather than a text field. */
export const NON_TEXT_INPUT_TYPES: readonly string[] = [
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'range',
  'color',
  'file',
  'image',
  'hidden',
];

/**
 * Text editing keeps the native I-beam: a solid dot cannot communicate where
 * the caret will land. `.select-text` and `[data-cursor-native]` let a
 * selectable region opt in to the same treatment.
 */
export const TEXT_INPUT_SELECTOR = [
  'textarea',
  'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="image"]):not([type="hidden"])',
  '[contenteditable]:not([contenteditable="false"])',
  '.select-text',
  '[data-cursor-native]',
].join(', ');

/**
 * Specialised controls whose native cursor must survive. When the pointer is
 * over one of these the custom dot steps aside completely.
 */
export const NATIVE_CURSOR_SELECTOR = [
  TEXT_INPUT_SELECTOR,
  'select',
  ':disabled',
  '[aria-disabled="true"]',
  '[draggable="true"]',
  '.cursor-not-allowed',
  '.cursor-text',
  '.cursor-grab',
  '.cursor-grabbing',
  '.cursor-move',
  '.cursor-col-resize',
  '.cursor-row-resize',
  '.cursor-ns-resize',
  '.cursor-ew-resize',
  '.cursor-nwse-resize',
  '.cursor-nesw-resize',
  '.cursor-zoom-in',
  '.cursor-zoom-out',
  '.cursor-wait',
  '.cursor-progress',
  '.cursor-help',
  '.cursor-crosshair',
  '.cursor-copy',
  '.cursor-cell',
  '.cursor-all-scroll',
  '.cursor-alias',
].join(', ');

/** Embedded documents own their own cursor, so ours has to disappear. */
export const EMBEDDED_SELECTOR = 'iframe, embed, object';

/** Facts about the element under the pointer, collected by the component. */
export interface CursorTargetFacts {
  /** The pointer is over an embedded document. */
  isEmbedded?: boolean;
  /** A text field, selectable region, draggable element or disabled control. */
  isNative?: boolean;
  /** A genuine control, link, tab or clickable surface. */
  isInteractive?: boolean;
}

/**
 * Maps the facts onto a state. Native affordances win over the custom hover
 * state, and an embedded document wins over everything because the browser
 * draws the cursor inside it.
 */
export function resolveCursorState(facts: CursorTargetFacts): CursorState {
  if (facts.isEmbedded) return 'hidden';
  if (facts.isNative) return 'native';
  if (facts.isInteractive) return 'hover';
  return 'default';
}

/** Only hover and press grow the dot; every other state rests at 10px. */
export function resolveCursorScale(state: CursorState, pressed: boolean): number {
  if (pressed) return CURSOR_PRESS_SCALE;
  return state === 'hover' ? CURSOR_HOVER_SCALE : CURSOR_DEFAULT_SCALE;
}

/**
 * Picks the spring for the transition that is currently happening. Pressing
 * always uses the stiff response; otherwise an expanding dot uses hover-in and
 * a contracting one uses the release spring when it is coming down from a
 * click, or the softer hover-out spring.
 */
export function springForScale(
  current: number,
  target: number,
  pressed: boolean,
): CursorSpring {
  if (pressed) return CURSOR_SPRINGS.press;
  if (target > current) return CURSOR_SPRINGS.hoverIn;
  if (current > CURSOR_HOVER_SCALE + 0.01) return CURSOR_SPRINGS.release;
  return CURSOR_SPRINGS.hoverOut;
}

/**
 * Frame-rate independent easing toward the pointer. The per-frame fraction is
 * re-derived from elapsed time, so the physical response is identical on
 * 60Hz, 120Hz and 144Hz displays.
 */
export function smoothPosition(current: number, target: number, deltaSeconds: number): number {
  const delta = Math.min(Math.max(deltaSeconds, 0), CURSOR_MAX_FRAME_SECONDS);
  if (delta === 0) return current;
  const alpha = 1 - Math.pow(1 - POSITION_SMOOTHING, delta * 60);
  return current + (target - current) * alpha;
}

/**
 * Advances a spring-damper one frame using the closed-form solution, so the
 * result is independent of the refresh rate and stable at any delta. The
 * spring is underdamped or critically damped — both are handled exactly.
 */
export function springStep(
  value: number,
  velocity: number,
  target: number,
  spring: CursorSpring,
  deltaSeconds: number,
): CursorSpringState {
  const delta = Math.min(Math.max(deltaSeconds, 0), CURSOR_MAX_FRAME_SECONDS);
  if (delta === 0) return { value, velocity };

  const omega = Math.sqrt(spring.stiffness);
  const zeta = spring.damping / (2 * omega);
  const offset = value - target;

  if (zeta >= 1) {
    // Critically damped.
    const decay = Math.exp(-omega * delta);
    const slope = velocity + omega * offset;
    return {
      value: target + (offset + slope * delta) * decay,
      velocity: (velocity - omega * slope * delta) * decay,
    };
  }

  // Underdamped: decaying oscillation that settles on the target.
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega * delta);
  const cosine = Math.cos(damped * delta);
  const sine = Math.sin(damped * delta);
  return {
    value:
      target +
      decay *
        (offset * cosine + ((velocity + zeta * omega * offset) / damped) * sine),
    velocity:
      decay *
        (velocity * cosine -
          ((omega * omega * offset + zeta * omega * velocity) / damped) * sine),
  };
}

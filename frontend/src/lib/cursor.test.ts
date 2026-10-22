import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  BUTTON_SELECTOR,
  CARD_SELECTOR,
  CURSOR_DOT_SIZE,
  CURSOR_INK_MUTED,
  CURSOR_INK_PRIMARY,
  CURSOR_MODES,
  CURSOR_POINTER_QUERY,
  CURSOR_RING_SIZE,
  DARK_SURFACE_LUMINANCE,
  INTERACTIVE_MODES,
  INTERACTIVE_SELECTOR,
  MEDIA_SELECTOR,
  NON_TEXT_INPUT_TYPES,
  REDUCED_MOTION_QUERY,
  clamp,
  damp,
  isCursorMode,
  isInteractiveMode,
  isSettled,
  parseCssColor,
  relativeLuminance,
  resolveCursorLabel,
  resolveCursorMode,
  shouldInvertCursor,
} from './cursor';

/* -------------------------------------------------------------------------
 * Modes
 * ---------------------------------------------------------------------- */

describe('cursor mode resolution', () => {
  it('falls back to the default mode', () => {
    expect(resolveCursorMode({})).toBe('default');
    expect(resolveCursorMode({ explicit: null })).toBe('default');
  });

  it('detects the interactive roles', () => {
    expect(resolveCursorMode({ isButton: true })).toBe('button');
    expect(resolveCursorMode({ isLink: true })).toBe('link');
    expect(resolveCursorMode({ isImage: true })).toBe('image');
    expect(resolveCursorMode({ isCard: true })).toBe('card');
    expect(resolveCursorMode({ isTextInput: true })).toBe('text');
    expect(resolveCursorMode({ isDragging: true })).toBe('drag');
    expect(resolveCursorMode({ isDisabled: true })).toBe('disabled');
  });

  it('lets a disabled control win over everything else', () => {
    expect(resolveCursorMode({ isDisabled: true, isButton: true, isLink: true })).toBe('disabled');
    expect(resolveCursorMode({ isDisabled: true, isTextInput: true })).toBe('disabled');
  });

  it('prefers a specific control over the surrounding card', () => {
    expect(resolveCursorMode({ isButton: true, isCard: true })).toBe('button');
    expect(resolveCursorMode({ isLink: true, isCard: true })).toBe('link');
    expect(resolveCursorMode({ isImage: true, isCard: true })).toBe('image');
  });

  it('hides the cursor over an embedded document', () => {
    expect(resolveCursorMode({ isFrame: true })).toBe('hidden');
    expect(resolveCursorMode({ isFrame: true, isButton: true })).toBe('hidden');
    expect(resolveCursorMode({ explicit: 'hidden' })).toBe('hidden');
    expect(resolveCursorMode({ explicit: 'hidden', isButton: true })).toBe('hidden');
  });

  it('uses an explicit mode when nothing more specific applies', () => {
    expect(resolveCursorMode({ explicit: 'drag' })).toBe('drag');
    expect(resolveCursorMode({ explicit: 'card' })).toBe('card');
  });
});

describe('cursor mode guard', () => {
  it('accepts every known mode', () => {
    for (const mode of CURSOR_MODES) {
      expect(isCursorMode(mode)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isCursorMode('nope')).toBe(false);
    expect(isCursorMode('')).toBe(false);
    expect(isCursorMode(null)).toBe(false);
    expect(isCursorMode(undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------- */

describe('cursor geometry', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

  /** The scale a mode ships with, read from the stylesheet itself. */
  const scaleOf = (mode: string, variable: 'dot-scale' | 'ring-scale'): number => {
    const rule =
      css.match(new RegExp(`\\.cursor-layer\\[data-mode='${mode}'\\]\\s*\\{([^}]*)\\}`)) ??
      css.match(/\.cursor-layer\s*\{([^}]*)\}/);
    const value = rule?.[1].match(new RegExp(`--${variable}:\\s*([0-9.]+)`));
    return Number(value?.[1] ?? NaN);
  };

  it('keeps the untouched cursor small', () => {
    expect(CURSOR_DOT_SIZE).toBeGreaterThanOrEqual(7);
    expect(CURSOR_DOT_SIZE).toBeLessThanOrEqual(9);
    expect(CURSOR_RING_SIZE).toBeGreaterThanOrEqual(24);
    expect(CURSOR_RING_SIZE).toBeLessThanOrEqual(28);
  });

  it('never enlarges the cursor in the default state', () => {
    expect(scaleOf('default', 'dot-scale')).toBe(1);
    expect(scaleOf('default', 'ring-scale')).toBe(1);
  });

  it('grows the dot to 10-12 px over an interactive element', () => {
    for (const mode of INTERACTIVE_MODES) {
      const size = CURSOR_DOT_SIZE * scaleOf(mode, 'dot-scale');
      expect(size).toBeGreaterThanOrEqual(9.5);
      expect(size).toBeLessThanOrEqual(12);
    }
  });

  it('grows the ring to 36-42 px over an interactive element', () => {
    for (const mode of INTERACTIVE_MODES) {
      const size = CURSOR_RING_SIZE * scaleOf(mode, 'ring-scale');
      expect(size).toBeGreaterThanOrEqual(35.5);
      expect(size).toBeLessThanOrEqual(42);
    }
  });

  it('never enlarges the cursor over static text or a disabled control', () => {
    expect(scaleOf('text', 'dot-scale')).toBeLessThanOrEqual(1);
    expect(scaleOf('text', 'ring-scale')).toBeLessThan(1);
    expect(scaleOf('disabled', 'dot-scale')).toBeLessThanOrEqual(1);
    expect(scaleOf('disabled', 'ring-scale')).toBeLessThanOrEqual(1);
  });

  it('only enlarges the cursor in interactive modes', () => {
    for (const mode of CURSOR_MODES) {
      const enlarges =
        scaleOf(mode, 'dot-scale') > 1 || scaleOf(mode, 'ring-scale') > 1;
      expect(enlarges).toBe(isInteractiveMode(mode));
    }
  });

  it('hides the cursor over an embedded document', () => {
    // The iframe owns its own cursor, so ours has to step out of the way.
    const hidden = css.match(/\.cursor-layer\[data-mode='hidden'\]\s*\{([^}]*)\}/);
    expect(hidden?.[1]).toMatch(/opacity:\s*0/);
    const visibleAt = css.indexOf(".cursor-layer[data-visible='true']");
    const hiddenAt = css.indexOf(".cursor-layer[data-mode='hidden']");
    expect(hiddenAt).toBeGreaterThan(visibleAt);
  });
});

/* -------------------------------------------------------------------------
 * Interaction detection
 * ---------------------------------------------------------------------- */

describe('interaction detection', () => {
  it('covers the semantic and ARIA ways of being interactive', () => {
    for (const selector of [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[data-cursor]',
      '[contenteditable="true"]',
    ]) {
      expect(INTERACTIVE_SELECTOR).toContain(selector);
    }
  });

  it('covers the controls that behave like a button', () => {
    for (const selector of ['button', '[role="tab"]', 'summary', 'select', 'input[type="submit"]']) {
      expect(BUTTON_SELECTOR).toContain(selector);
    }
  });

  it('knows media and cards', () => {
    expect(MEDIA_SELECTOR).toContain('img');
    expect(CARD_SELECTOR).toContain('.ios-card');
  });

  it('treats every non text input type as a control', () => {
    expect(NON_TEXT_INPUT_TYPES).toContain('checkbox');
    expect(NON_TEXT_INPUT_TYPES).toContain('submit');
    expect(NON_TEXT_INPUT_TYPES).not.toContain('text');
    expect(NON_TEXT_INPUT_TYPES).not.toContain('email');
  });
});

/* -------------------------------------------------------------------------
 * Labels
 * ---------------------------------------------------------------------- */

describe('cursor labels', () => {
  it('uses the explicit label and upper-cases it', () => {
    expect(resolveCursorLabel('link', 'view')).toBe('VIEW');
    expect(resolveCursorLabel('default', '  open  ')).toBe('OPEN');
  });

  it('falls back to the label of the mode', () => {
    expect(resolveCursorLabel('drag')).toBe('DRAG');
    expect(resolveCursorLabel('link')).toBeUndefined();
    expect(resolveCursorLabel('default', null)).toBeUndefined();
    expect(resolveCursorLabel('default', '   ')).toBeUndefined();
  });

  it('never renders an unreasonably long label', () => {
    expect(resolveCursorLabel('link', 'a'.repeat(50))).toHaveLength(14);
  });
});

/* -------------------------------------------------------------------------
 * Movement
 * ---------------------------------------------------------------------- */

describe('smoothing', () => {
  it('never overshoots the target', () => {
    const value = damp(0, 100, 0.1, 0.016);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(100);
  });

  it('converges towards the target', () => {
    let value = 0;
    for (let step = 0; step < 60; step += 1) {
      value = damp(value, 100, 0.1, 0.016);
    }
    expect(value).toBeGreaterThan(99);
    expect(value).toBeLessThanOrEqual(100);
  });

  it('is frame rate independent', () => {
    let slow = 0;
    for (let step = 0; step < 10; step += 1) slow = damp(slow, 100, 0.1, 0.016);

    let fast = 0;
    for (let step = 0; step < 40; step += 1) fast = damp(fast, 100, 0.1, 0.004);

    expect(Math.abs(slow - fast)).toBeLessThan(0.5);
  });

  it('jumps straight to the target when the time constant is zero', () => {
    expect(damp(10, 90, 0, 0.016)).toBe(90);
    expect(damp(10, 90, 0.1, 0)).toBe(10);
  });
});

/**
 * The cursor is driven by a single damped follow. This simulates a real
 * pointer path — a slow drift, a fast flick, an instant reversal and a jump
 * across the screen — and asserts the properties that make the movement feel
 * premium: no overshoot, no jitter, no stuck state.
 */
describe('motion simulation', () => {
  const DOT_TAU = 0.006;
  const RING_TAU = 0.022;
  const FRAME = 1 / 60;

  interface Trace {
    dot: number[];
    ring: number[];
  }

  function simulate(points: Array<{ x: number; y: number }>): Trace {
    let dotX = points[0].x;
    let dotY = points[0].y;
    let ringX = dotX;
    let ringY = dotY;
    const dot: number[] = [];
    const ring: number[] = [];

    for (const target of points) {
      dotX = damp(dotX, target.x, DOT_TAU, FRAME);
      dotY = damp(dotY, target.y, DOT_TAU, FRAME);
      ringX = damp(ringX, target.x, RING_TAU, FRAME);
      ringY = damp(ringY, target.y, RING_TAU, FRAME);
      dot.push(dotX);
      ring.push(ringX);
    }

    return { dot, ring };
  }

  it('never lets the cursor pass the pointer', () => {
    // A first order lag can not overshoot: the drawn position is always
    // inside the range the pointer has travelled through so far.
    const points = Array.from({ length: 240 }, (_, index) => ({
      x: 400 + Math.sin(index / 9) * 300,
      y: 300 + Math.cos(index / 13) * 200,
    }));
    const trace = simulate(points);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < points.length; index += 1) {
      min = Math.min(min, points[index].x);
      max = Math.max(max, points[index].x);
      expect(trace.dot[index]).toBeGreaterThanOrEqual(min - 0.001);
      expect(trace.dot[index]).toBeLessThanOrEqual(max + 0.001);
      expect(trace.ring[index]).toBeGreaterThanOrEqual(min - 0.001);
      expect(trace.ring[index]).toBeLessThanOrEqual(max + 0.001);
    }
  });

  it('keeps the dot far closer to the pointer than the ring', () => {
    const points = Array.from({ length: 120 }, (_, index) => ({ x: index * 18, y: 300 }));
    const trace = simulate(points);
    const last = points.length - 1;
    const dotLag = Math.abs(trace.dot[last] - points[last].x);
    const ringLag = Math.abs(trace.ring[last] - points[last].x);
    expect(dotLag).toBeLessThan(4);
    expect(ringLag).toBeGreaterThan(dotLag);
    expect(ringLag).toBeLessThan(20);
  });

  it('stays glued to the pointer during a fast flick', () => {
    const points = Array.from({ length: 60 }, (_, index) => ({ x: index * 40, y: 300 }));
    const trace = simulate(points);
    const last = trace.dot[trace.dot.length - 1];
    const target = points[points.length - 1].x;
    // 40 px per frame is 2400 px/s — the dot may lag a little, never much.
    expect(Math.abs(last - target)).toBeLessThan(6);
  });

  it('keeps the ring behind the dot without ever losing it', () => {
    const points = Array.from({ length: 120 }, (_, index) => ({ x: index * 18, y: 300 }));
    const trace = simulate(points);
    for (let index = 0; index < points.length; index += 1) {
      expect(trace.ring[index]).toBeLessThanOrEqual(trace.dot[index] + 0.0001);
      expect(Math.abs(trace.ring[index] - points[index].x)).toBeLessThan(20);
    }
  });

  it('survives an instant reversal without oscillating', () => {
    const points: Array<{ x: number; y: number }> = [];
    for (let index = 0; index < 30; index += 1) points.push({ x: 100 + index * 20, y: 200 });
    for (let index = 0; index < 30; index += 1) points.push({ x: 700 - index * 20, y: 200 });
    const trace = simulate(points);
    // A first order lag can not oscillate: the drawn position is monotonic
    // between two reversals of the target.
    for (let index = 1; index < points.length; index += 1) {
      const delta = trace.dot[index] - trace.dot[index - 1];
      const targetDelta = points[index].x - points[index - 1].x;
      if (targetDelta !== 0 && Math.sign(targetDelta) !== Math.sign(delta)) {
        expect(Math.abs(delta)).toBeLessThan(0.001);
      }
    }
  });

  it('reaches a resting state and reports it', () => {
    let dotX = 0;
    for (let step = 0; step < 200; step += 1) dotX = damp(dotX, 640, DOT_TAU, FRAME);
    expect(isSettled([dotX - 640], 0.05)).toBe(true);
  });

  it('never produces a value that is not a number', () => {
    let dotX = 0;
    for (let step = 0; step < 500; step += 1) {
      dotX = damp(dotX, step * 37, DOT_TAU, FRAME);
      expect(Number.isFinite(dotX)).toBe(true);
    }
  });
});

describe('helpers', () => {
  it('clamps into a range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 3, 10)).toBe(3);
  });

  it('detects a settled state', () => {
    expect(isSettled([0.01, -0.02], 0.05)).toBe(true);
    expect(isSettled([0.2, 0.01], 0.05)).toBe(false);
    expect(isSettled([], 0.05)).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Colour
 * ---------------------------------------------------------------------- */

describe('colour handling', () => {
  it('parses rgb and rgba values', () => {
    expect(parseCssColor('rgb(23, 23, 23)')).toEqual({ r: 23, g: 23, b: 23, a: 1 });
    expect(parseCssColor('rgba(163, 163, 163, 0.5)')).toEqual({ r: 163, g: 163, b: 163, a: 0.5 });
    expect(parseCssColor('rgb(23 23 23 / 0.25)')).toEqual({ r: 23, g: 23, b: 23, a: 0.25 });
  });

  it('ignores notations it can not read', () => {
    expect(parseCssColor('transparent')).toBeNull();
    expect(parseCssColor('currentColor')).toBeNull();
    expect(parseCssColor(null)).toBeNull();
    expect(parseCssColor(undefined)).toBeNull();
  });

  it('computes the relative luminance', () => {
    const white = relativeLuminance({ r: 255, g: 255, b: 255, a: 1 });
    const black = relativeLuminance({ r: 0, g: 0, b: 0, a: 1 });
    expect(white).toBeCloseTo(1, 3);
    expect(black).toBeCloseTo(0, 3);
  });

  it('inverts the cursor only on dark surfaces', () => {
    expect(shouldInvertCursor(0)).toBe(true);
    expect(shouldInvertCursor(0.05)).toBe(true);
    expect(shouldInvertCursor(1)).toBe(false);
    expect(shouldInvertCursor(null)).toBe(false);
    expect(shouldInvertCursor(Number.NaN)).toBe(false);
    expect(DARK_SURFACE_LUMINANCE).toBeGreaterThan(0);
    expect(DARK_SURFACE_LUMINANCE).toBeLessThan(1);
  });

  it('uses exactly two inks and never a pure white', () => {
    expect(CURSOR_INK_PRIMARY).toBe(23);
    expect(CURSOR_INK_MUTED).toBe(163);
    expect(CURSOR_INK_MUTED).toBeLessThan(255);
  });
});

describe('capability queries', () => {
  it('only targets devices with a precise pointer', () => {
    expect(CURSOR_POINTER_QUERY).toContain('hover: hover');
    expect(CURSOR_POINTER_QUERY).toContain('pointer: fine');
  });

  it('respects the reduced motion preference', () => {
    expect(REDUCED_MOTION_QUERY).toContain('prefers-reduced-motion');
  });
});

/* -------------------------------------------------------------------------
 * The stylesheet is part of the contract
 * ---------------------------------------------------------------------- */

describe('cursor stylesheet contract', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

  it('uses the near black ink in the light theme', () => {
    expect(css).toContain(`--cursor-ink: ${CURSOR_INK_PRIMARY} ${CURSOR_INK_PRIMARY} ${CURSOR_INK_PRIMARY}`);
  });

  it('uses the medium grey ink in the dark theme', () => {
    expect(css).toContain(`--cursor-ink: ${CURSOR_INK_MUTED} ${CURSOR_INK_MUTED} ${CURSOR_INK_MUTED}`);
  });

  it('never paints a pure white cursor', () => {
    expect(css).not.toMatch(/--cursor-ink:\s*255 255 255/);
  });

  it('sizes the dot and the ring as specified', () => {
    expect(css).toMatch(new RegExp(`\\.cursor-dot\\s*\\{[^}]*width:\\s*${CURSOR_DOT_SIZE}px`));
    expect(css).toMatch(new RegExp(`\\.cursor-dot\\s*\\{[^}]*height:\\s*${CURSOR_DOT_SIZE}px`));
    expect(css).toMatch(new RegExp(`\\.cursor-ring\\s*\\{[^}]*width:\\s*${CURSOR_RING_SIZE}px`));
    expect(css).toMatch(new RegExp(`\\.cursor-ring\\s*\\{[^}]*height:\\s*${CURSOR_RING_SIZE}px`));
  });

  it('keeps the ring border between 35% and 50% opacity', () => {
    const match = css.match(/--ring-alpha:\s*([0-9.]+)/);
    expect(match).not.toBeNull();
    const alpha = Number(match?.[1]);
    expect(alpha).toBeGreaterThanOrEqual(0.35);
    expect(alpha).toBeLessThanOrEqual(0.5);
  });

  it('transitions the states in 250-400 ms', () => {
    const durations = [...css.matchAll(/transform\s+(\d+)ms\s+var\(--ease-soft\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const duration of durations) {
      expect(duration).toBeGreaterThanOrEqual(250);
      expect(duration).toBeLessThanOrEqual(400);
    }
  });

  it('keeps the press feedback fast', () => {
    expect(css).toContain('transition-duration: 110ms');
  });

  it('never lets the cursor layers swallow a click', () => {
    expect(css).toMatch(/\.cursor-layer\s*\{[^}]*pointer-events:\s*none/);
  });

  it('only hides the native cursor while the custom one runs', () => {
    expect(css).toContain("html[data-cursor='custom']");
  });

  it('has no glow, shadow or gradient on the cursor', () => {
    const cursorBlock = css.slice(css.indexOf('.cursor-layer'), css.indexOf('/* Overlay scrollbar */'));
    expect(cursorBlock).not.toContain('box-shadow');
    expect(cursorBlock).not.toContain('linear-gradient');
    expect(cursorBlock).not.toContain('radial-gradient');
    expect(cursorBlock).not.toContain('filter:');
  });

  it('animates transforms and opacity, never layout', () => {
    const cursorBlock = css.slice(css.indexOf('.cursor-layer'), css.indexOf('/* Overlay scrollbar */'));
    expect(cursorBlock).not.toMatch(/transition:[^;]*\b(top|left|width|height|margin|padding)\b/);
  });
});

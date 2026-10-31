import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  CURSOR_COLOR,
  CURSOR_DEFAULT_SCALE,
  CURSOR_HOVER_SCALE,
  CURSOR_HOVER_SIZE,
  CURSOR_LIGHT_INK,
  CURSOR_POINTER_QUERY,
  CURSOR_PRESS_SCALE,
  CURSOR_PRESS_SIZE,
  CURSOR_SIZE,
  CURSOR_SPRINGS,
  CURSOR_Z_INDEX,
  EMBEDDED_SELECTOR,
  INTERACTIVE_SELECTOR,
  NATIVE_CURSOR_SELECTOR,
  POSITION_SMOOTHING,
  REDUCED_MOTION_QUERY,
  TEXT_INPUT_SELECTOR,
  resolveCursorScale,
  resolveCursorState,
  smoothPosition,
  springForScale,
  springStep,
  type CursorSpring,
} from './cursor';

/* -------------------------------------------------------------------------
 * State resolution
 * ---------------------------------------------------------------------- */

describe('cursor state resolution', () => {
  it('falls back to the resting dot', () => {
    expect(resolveCursorState({})).toBe('default');
    expect(resolveCursorState({ isInteractive: false, isNative: false })).toBe('default');
  });

  it('grows over interactive elements', () => {
    expect(resolveCursorState({ isInteractive: true })).toBe('hover');
  });

  it('steps aside for native affordances', () => {
    expect(resolveCursorState({ isNative: true })).toBe('native');
    expect(resolveCursorState({ isNative: true, isInteractive: true })).toBe('native');
  });

  it('hides inside an embedded document', () => {
    expect(resolveCursorState({ isEmbedded: true })).toBe('hidden');
    expect(resolveCursorState({ isEmbedded: true, isInteractive: true })).toBe('hidden');
    expect(resolveCursorState({ isEmbedded: true, isNative: true, isInteractive: true })).toBe(
      'hidden',
    );
  });
});

/* -------------------------------------------------------------------------
 * Geometry and palette
 * ---------------------------------------------------------------------- */

describe('cursor geometry', () => {
  it('uses the requested diameters', () => {
    expect(CURSOR_SIZE).toBe(10);
    expect(CURSOR_HOVER_SIZE).toBe(12);
    expect(CURSOR_PRESS_SIZE).toBe(13);
  });

  it('derives the animation scales from a 10px dot', () => {
    expect(CURSOR_DEFAULT_SCALE).toBe(1);
    expect(CURSOR_HOVER_SCALE).toBeCloseTo(1.2, 5);
    expect(CURSOR_PRESS_SCALE).toBeCloseTo(1.3, 5);
  });

  it('stays above every overlay in the application', () => {
    expect(CURSOR_Z_INDEX).toBe(2147483647);
  });

  it('uses the primary text ink and only that ink', () => {
    expect(CURSOR_COLOR).toBe('#CCD0CF');
  });
});

/* -------------------------------------------------------------------------
 * Selectors
 * ---------------------------------------------------------------------- */

describe('interaction detection', () => {
  it('covers buttons, links, navigation, tabs and ARIA widgets', () => {
    for (const selector of [
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
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="combobox"]',
      '[contenteditable="true"]',
      '.cursor-pointer',
      '[data-cursor="interactive"]',
    ]) {
      expect(INTERACTIVE_SELECTOR).toContain(selector);
    }
  });

  it('recognises text fields and opt-in selectable regions', () => {
    for (const selector of ['textarea', 'input', '[contenteditable]', '.select-text', '[data-cursor-native]']) {
      expect(TEXT_INPUT_SELECTOR).toContain(selector);
    }
  });

  it('treats specialised controls as native', () => {
    for (const selector of [
      'select',
      ':disabled',
      '[aria-disabled="true"]',
      '[draggable="true"]',
      '.cursor-not-allowed',
      '.cursor-col-resize',
      '.cursor-zoom-in',
    ]) {
      expect(NATIVE_CURSOR_SELECTOR).toContain(selector);
    }
  });

  it('hides the dot inside embedded documents', () => {
    expect(EMBEDDED_SELECTOR).toContain('iframe');
    expect(EMBEDDED_SELECTOR).toContain('embed');
    expect(EMBEDDED_SELECTOR).toContain('object');
  });
});

describe('capability queries', () => {
  it('only targets devices with a precise pointer', () => {
    expect(CURSOR_POINTER_QUERY).toContain('hover: hover');
    expect(CURSOR_POINTER_QUERY).toContain('pointer: fine');
  });

  it('detects a reduced-motion preference', () => {
    expect(REDUCED_MOTION_QUERY).toContain('prefers-reduced-motion');
  });
});

/* -------------------------------------------------------------------------
 * Motion
 * ---------------------------------------------------------------------- */

interface Simulation {
  ninety: number;
  settled: number;
  overshoot: number;
}

/** Advances a spring at a fixed frame rate and measures its step response. */
function simulate(spring: CursorSpring, from: number, to: number, fps: number): Simulation {
  const frame = 1 / fps;
  const distance = to - from;
  let value = from;
  let velocity = 0;
  let elapsed = 0;
  let peak = from;
  let ninety: number | null = null;
  let settled: number | null = null;

  for (let i = 0; i < Math.ceil(fps * 1.5); i += 1) {
    const state = springStep(value, velocity, to, spring, frame);
    value = state.value;
    velocity = state.velocity;
    elapsed += frame;

    if ((distance > 0 && value > peak) || (distance < 0 && value < peak)) peak = value;
    if (ninety === null && Math.abs(value - from) / Math.abs(distance) >= 0.9) ninety = elapsed;
    if (
      settled === null &&
      Math.abs(to - value) <= 0.02 * Math.abs(distance) &&
      Math.abs(velocity) <= 0.02 * Math.abs(distance)
    ) {
      settled = elapsed;
    }
  }

  return {
    ninety: ninety ?? Number.POSITIVE_INFINITY,
    settled: settled ?? Number.POSITIVE_INFINITY,
    overshoot: (peak - from) / distance - 1,
  };
}

describe('cursor scale resolution', () => {
  it('rests at 10px and grows only for hover and press', () => {
    expect(resolveCursorScale('default', false)).toBe(CURSOR_DEFAULT_SCALE);
    expect(resolveCursorScale('native', false)).toBe(CURSOR_DEFAULT_SCALE);
    expect(resolveCursorScale('hidden', false)).toBe(CURSOR_DEFAULT_SCALE);
    expect(resolveCursorScale('hover', false)).toBeCloseTo(CURSOR_HOVER_SCALE, 5);
    expect(resolveCursorScale('default', true)).toBeCloseTo(CURSOR_PRESS_SCALE, 5);
    expect(resolveCursorScale('hover', true)).toBeCloseTo(CURSOR_PRESS_SCALE, 5);
  });

  it('picks a spring for every transition direction', () => {
    expect(springForScale(CURSOR_DEFAULT_SCALE, CURSOR_HOVER_SCALE, false)).toBe(
      CURSOR_SPRINGS.hoverIn,
    );
    expect(springForScale(CURSOR_HOVER_SCALE, CURSOR_DEFAULT_SCALE, false)).toBe(
      CURSOR_SPRINGS.hoverOut,
    );
    expect(springForScale(CURSOR_PRESS_SCALE, CURSOR_HOVER_SCALE, false)).toBe(
      CURSOR_SPRINGS.release,
    );
    expect(springForScale(CURSOR_DEFAULT_SCALE, CURSOR_PRESS_SCALE, true)).toBe(
      CURSOR_SPRINGS.press,
    );
    // Re-entering an interactive element mid-contraction expands again.
    expect(springForScale(1.1, CURSOR_HOVER_SCALE, false)).toBe(CURSOR_SPRINGS.hoverIn);
  });
});

describe('cursor position smoothing', () => {
  it('covers the recommended fraction of the distance each 60Hz frame', () => {
    expect(POSITION_SMOOTHING).toBeGreaterThanOrEqual(0.18);
    expect(POSITION_SMOOTHING).toBeLessThanOrEqual(0.25);
    expect(smoothPosition(0, 100, 1 / 60)).toBeCloseTo(100 * POSITION_SMOOTHING, 5);
  });

  it('follows at the same physical speed on 60Hz and 144Hz displays', () => {
    let at60 = 0;
    for (let i = 0; i < 60; i += 1) at60 = smoothPosition(at60, 100, 1 / 60);

    let at144 = 0;
    for (let i = 0; i < 144; i += 1) at144 = smoothPosition(at144, 100, 1 / 144);

    expect(at60).toBeCloseTo(at144, 6);
    expect(at60).toBeGreaterThan(95);
    expect(at60).toBeLessThan(100);
  });

  it('caps a stalled frame instead of teleporting', () => {
    expect(smoothPosition(0, 100, 10)).toBeCloseTo(smoothPosition(0, 100, 1 / 30), 10);
  });
});

describe('cursor spring physics', () => {
  it('expands on hover in roughly 180–250ms without visible bounce', () => {
    const result = simulate(CURSOR_SPRINGS.hoverIn, 1, 1.7, 60);
    expect(result.settled).toBeGreaterThanOrEqual(0.17);
    expect(result.settled).toBeLessThanOrEqual(0.27);
    expect(result.overshoot).toBeLessThan(0.01);
  });

  it('contracts on hover-out in roughly 200–280ms', () => {
    const result = simulate(CURSOR_SPRINGS.hoverOut, 1.7, 1, 60);
    expect(result.settled).toBeGreaterThanOrEqual(0.21);
    expect(result.settled).toBeLessThanOrEqual(0.29);
  });

  it('expands on press quickly with a subtle spring settle', () => {
    const result = simulate(CURSOR_SPRINGS.press, 1, 2.5, 60);
    expect(result.ninety).toBeLessThan(0.1);
    expect(result.settled).toBeGreaterThanOrEqual(0.1);
    expect(result.settled).toBeLessThanOrEqual(0.16);
    expect(result.overshoot).toBeGreaterThan(0);
    expect(result.overshoot).toBeLessThan(0.03);
  });

  it('releases from press in roughly 180–250ms', () => {
    const result = simulate(CURSOR_SPRINGS.release, 2.5, 1.7, 60);
    expect(result.settled).toBeGreaterThanOrEqual(0.17);
    expect(result.settled).toBeLessThanOrEqual(0.26);
    expect(result.overshoot).toBeLessThan(0.01);
  });

  it('settles at the same time regardless of refresh rate', () => {
    for (const [from, to, spring] of [
      [1, 1.7, CURSOR_SPRINGS.hoverIn],
      [1, 2.5, CURSOR_SPRINGS.press],
      [2.5, 1.7, CURSOR_SPRINGS.release],
    ] as const) {
      const at60 = simulate(spring, from, to, 60);
      const at144 = simulate(spring, from, to, 144);
      expect(Math.abs(at60.settled - at144.settled)).toBeLessThan(0.02);
    }
  });
});

/* -------------------------------------------------------------------------
 * The stylesheet is part of the contract
 * ---------------------------------------------------------------------- */

describe('cursor stylesheet contract', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.custom-cursor'), css.indexOf('/* Scrollbars'));
  const declarations = block.replace(/\/\*[\s\S]*?\*\//g, '');

  it('paints a solid circle in the theme ink with no border', () => {
    expect(declarations).toMatch(/\.custom-cursor__dot\s*\{[^}]*border-radius:\s*50%/);
    expect(declarations).toMatch(/\.custom-cursor__dot\s*\{[^}]*background:\s*var\(--cursor-dot\)/);
    expect(declarations).not.toMatch(/(^|[^-])border:\s/);
  });

  it('keeps the dot solid and visible in both themes', () => {
    const light = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
    const dark = css.match(/\.dark\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(light).toMatch(new RegExp(`--cursor-dot:\\s*${CURSOR_LIGHT_INK}`, 'i'));
    expect(dark).toMatch(new RegExp(`--cursor-dot:\\s*${CURSOR_COLOR}`, 'i'));

    const dot = declarations.match(/\.custom-cursor__dot\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(dot).toMatch(/opacity:\s*1/);
    expect(dot).not.toMatch(/rgba?\(/);
    // No per-theme cursor rules may override the token.
    expect(declarations).not.toMatch(/\.dark[^{]*custom-cursor/);
    expect(css).not.toContain('--cursor-ink');
  });

  it('starts as a 10px dot and leaves scaling to the animation loop', () => {
    expect(declarations).toMatch(/--cursor-size:\s*10px/);
    expect(declarations).toMatch(/transform:\s*scale\(1\)/);
    expect(declarations).not.toContain('--cursor-scale');
    expect(declarations).not.toContain('--cursor-ease');
  });

  it('is fixed, covers the viewport, sits on top and never swallows input', () => {
    const base = declarations.match(/\.custom-cursor\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(base).toMatch(/position:\s*fixed/);
    expect(base).toMatch(/inset:\s*0/);
    expect(base).toMatch(/pointer-events:\s*none/);
    expect(base).toMatch(new RegExp(`z-index:\\s*${CURSOR_Z_INDEX}`));
  });

  it('never transitions transform — the animation loop owns motion', () => {
    expect(declarations).not.toMatch(/transition:[^;]*transform/);
    expect(declarations).not.toMatch(/transition:[^;]*(left|top)\b/);
  });

  it('promotes the anchor and the dot to the compositor', () => {
    expect(declarations.match(/will-change:\s*transform/g)?.length).toBe(2);
  });

  it('has no ring, caret, label, pulse or trailing layer', () => {
    for (const removed of ['cursor-ring', 'cursor-caret', 'cursor-label', 'cursor-pulse', 'cursor-anchor']) {
      expect(css).not.toContain(removed);
    }
  });

  it('has no glow, shadow, gradient, filter or blend mode', () => {
    expect(declarations).not.toContain('box-shadow');
    expect(declarations).not.toContain('gradient');
    expect(declarations).not.toContain('filter:');
    expect(declarations).not.toContain('mix-blend-mode');
  });

  it('only animates transforms and opacity, never layout', () => {
    const transitions = [...declarations.matchAll(/transition:[\s\S]*?;/g)].map((match) => match[0]);
    expect(transitions.length).toBeGreaterThan(0);
    for (const transition of transitions) {
      expect(transition).not.toMatch(/\b(width|height|top|left|margin|padding)\b/);
    }
  });

  it('only hides the native cursor while the custom one runs', () => {
    expect(declarations).toMatch(
      /html\[data-cursor='custom'\],[\s\S]*?cursor:\s*none !important/,
    );
    expect(declarations).not.toMatch(/^\s*\*?\s*\{[^}]*cursor:\s*none/m);
  });

  it('restores the native cursor for text fields and selectable content', () => {
    expect(declarations).toMatch(/textarea/);
    expect(declarations).toMatch(/\[contenteditable\]:not/);
    expect(declarations).toMatch(/\.select-text/);
    expect(declarations).toMatch(/\[data-cursor-native\]/);
    expect(declarations).toMatch(/cursor:\s*text !important/);
  });

  it('restores native cursors for specialised controls', () => {
    expect(declarations).toMatch(/select,\s*option/);
    expect(declarations).toMatch(/cursor:\s*not-allowed !important/);
    expect(declarations).toMatch(/\[draggable='true'\]/);
    expect(declarations).toMatch(/cursor:\s*grab !important/);
    expect(declarations).toMatch(/cursor:\s*col-resize !important/);
    expect(declarations).toMatch(/cursor:\s*zoom-in !important/);
  });
});

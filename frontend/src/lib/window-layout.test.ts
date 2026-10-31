import { describe, expect, it } from 'vitest';
import { WINDOW_PRESETS, clampWindowPosition } from '../components/productivity/FloatingWindow';

describe('floating window layout', () => {
  it('keeps the productivity windows compact', () => {
    expect(WINDOW_PRESETS.todo.width).toBeGreaterThanOrEqual(340);
    expect(WINDOW_PRESETS.todo.width).toBeLessThanOrEqual(400);
    expect(WINDOW_PRESETS.todo.maxVh).toBeLessThanOrEqual(70);
    expect(WINDOW_PRESETS.todo.height).toBeLessThanOrEqual(500);

    expect(WINDOW_PRESETS.daily.width).toBeGreaterThanOrEqual(420);
    expect(WINDOW_PRESETS.daily.width).toBeLessThanOrEqual(520);
    expect(WINDOW_PRESETS.daily.maxVh).toBeLessThanOrEqual(75);
    expect(WINDOW_PRESETS.daily.height).toBeLessThanOrEqual(600);
  });

  it('clamps a window to the viewport edges', () => {
    const bounds = {
      width: 380,
      height: 460,
      viewportWidth: 1280,
      viewportHeight: 800,
    };

    expect(clampWindowPosition({ x: -50, y: -20 }, bounds)).toEqual({ x: 8, y: 8 });
    expect(clampWindowPosition({ x: 5000, y: 5000 }, bounds)).toEqual({ x: 892, y: 332 });
  });

  it('leaves an in-bounds position untouched', () => {
    const bounds = {
      width: 480,
      height: 540,
      viewportWidth: 1440,
      viewportHeight: 900,
    };
    expect(clampWindowPosition({ x: 520, y: 96 }, bounds)).toEqual({ x: 520, y: 96 });
  });
});

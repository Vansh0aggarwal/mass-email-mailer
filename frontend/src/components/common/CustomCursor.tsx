import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useTheme } from '../../context/ThemeContext';
import {
  BUTTON_SELECTOR,
  CARD_SELECTOR,
  CURSOR_POINTER_QUERY,
  INTERACTIVE_SELECTOR,
  MEDIA_SELECTOR,
  NON_TEXT_INPUT_TYPES,
  REDUCED_MOTION_QUERY,
  clamp,
  damp,
  isCursorMode,
  isSettled,
  parseCssColor,
  relativeLuminance,
  resolveCursorLabel,
  resolveCursorMode,
  shouldInvertCursor,
  type CursorMode,
  type CursorTargetInfo,
  type RgbColor,
} from '../../lib/cursor';

/* -------------------------------------------------------------------------
 * Timing
 *
 * All constants are expressed in seconds and fed straight into the
 * frame rate independent smoothing, so the cursor feels identical on a
 * 60 Hz laptop and a 144 Hz monitor.
 * ---------------------------------------------------------------------- */

/**
 * The dot is essentially locked to the pointer — a couple of milliseconds of
 * smoothing is enough to take the edge off the sensor without ever feeling
 * like it lags behind.
 */
const DOT_TAU = 0.006;

/**
 * The ring follows a fraction of a frame later. That is the whole trick: the
 * two elements separate just enough to read as two layers, never enough to
 * read as a lag.
 */
const RING_TAU = 0.022;

/** A press that is never released (e.g. the pointer left the window). */
const PRESS_HOLD_MS = 120;

/** The click pulse — a single, restrained ring that fades out. */
const PULSE_DURATION = 480;
const PULSE_FROM_SCALE = 0.9;
const PULSE_TO_SCALE = 1.5;
const PULSE_MAX_OPACITY = 0.3;

interface CursorRuntime {
  /** Where the pointer actually is. */
  pointerX: number;
  pointerY: number;
  /** Where the dot is drawn (damped). */
  dotX: number;
  dotY: number;
  /** Where the ring is drawn (damped). */
  ringX: number;
  ringY: number;
  mode: CursorMode;
  pressed: boolean;
  pressedAt: number;
  visible: boolean;
  /** The cursor has been placed at least once, so it never flies in from 0,0. */
  placed: boolean;
  /** The user asked for less motion. */
  simplified: boolean;
  target: Element | null;
  /** The surface under the pointer has to be re-read (after a hover change). */
  surfaceDirty: boolean;
  frame: number | null;
  lastFrameAt: number;
  pulse: Animation | null;
}

function createRuntime(): CursorRuntime {
  return {
    pointerX: 0,
    pointerY: 0,
    dotX: 0,
    dotY: 0,
    ringX: 0,
    ringY: 0,
    mode: 'default',
    pressed: false,
    pressedAt: 0,
    visible: false,
    placed: false,
    simplified: false,
    target: null,
    surfaceDirty: false,
    frame: null,
    lastFrameAt: 0,
    pulse: null,
  };
}

/**
 * Collects everything the cursor needs to know about the element under the
 * pointer. The result is fed into `resolveCursorMode`, which owns the
 * precedence rules.
 *
 * The rule that matters: only elements that really do something enlarge the
 * cursor. A card that merely contains a link is not clickable itself, so
 * hovering its padding leaves the cursor alone.
 */
function readTargetInfo(element: Element | null): CursorTargetInfo {
  if (!element) {
    return { explicit: null };
  }

  const tag = element.tagName.toLowerCase();
  const explicitOwner = element.closest('[data-cursor]');
  const explicitRaw = explicitOwner?.getAttribute('data-cursor') ?? null;

  // A <label> behaves exactly like the control it is bound to.
  let probe: Element = element;
  if (tag === 'label') {
    const forId = element.getAttribute('for');
    const bound = forId
      ? document.getElementById(forId)
      : element.querySelector('input, textarea, select');
    if (bound) probe = bound;
  }

  const probeTag = probe.tagName.toLowerCase();
  const probeType = (probe.getAttribute('type') || '').toLowerCase();

  // The closest control that really does something.
  const control = probe.closest(INTERACTIVE_SELECTOR);

  const isTextInput =
    probeTag === 'textarea' ||
    (probeTag === 'input' && !NON_TEXT_INPUT_TYPES.includes(probeType)) ||
    (probe instanceof HTMLElement && probe.isContentEditable === true);

  const isButton = control !== null && control.matches(BUTTON_SELECTOR);
  const isLink = control !== null && control.matches('a[href]');

  // An image only counts when the image itself is the clickable thing.
  const isImage =
    element.matches(MEDIA_SELECTOR) &&
    control !== null &&
    (control === element || control.matches('a[href], button, [role="button"]'));

  // A card only counts when the card itself is the clickable thing.
  const card = element.closest(CARD_SELECTOR);
  const isCard =
    card !== null &&
    card.matches('a[href], button, [role="button"], [role="link"], [role="tab"], [data-cursor]');

  return {
    explicit: isCursorMode(explicitRaw) ? explicitRaw : null,
    isFrame: tag === 'iframe' || tag === 'embed' || tag === 'object',
    isDisabled: control !== null && control.closest('[disabled], [aria-disabled="true"]') !== null,
    isTextInput,
    isDragging: element.closest('[draggable="true"]') !== null,
    isButton,
    isLink,
    isImage,
    isCard,
  };
}

/**
 * The colour of the surface under the pointer, composed through all
 * translucent layers, expressed as relative luminance.
 */
function resolveSurfaceLuminance(element: Element | null): number | null {
  if (!element) return null;

  const layers: RgbColor[] = [];
  let node: Element | null = element;
  while (node) {
    const color = parseCssColor(window.getComputedStyle(node).backgroundColor);
    if (color && color.a > 0) layers.push(color);
    if (color && color.a >= 0.999) break;
    node = node.parentElement;
  }
  if (layers.length === 0) return null;

  // Composite from the bottom-most layer upwards.
  let result = layers[layers.length - 1];
  for (let index = layers.length - 2; index >= 0; index -= 1) {
    const top = layers[index];
    const alpha = top.a + result.a * (1 - top.a);
    if (alpha <= 0) continue;
    result = {
      r: (top.r * top.a + result.r * result.a * (1 - top.a)) / alpha,
      g: (top.g * top.a + result.g * result.a * (1 - top.a)) / alpha,
      b: (top.b * top.a + result.b * result.a * (1 - top.a)) / alpha,
      a: alpha,
    };
  }
  return relativeLuminance(result);
}

/**
 * A premium custom cursor: a small solid dot that stays exactly under the
 * pointer and a thin ring that follows a fraction of a frame behind it. Both
 * react to what is hovered — a genuine control enlarges them, a text field
 * turns the dot into a caret, a disabled control draws a dashed ring.
 *
 * It renders nothing but decoration, never intercepts a single click, and it
 * steps aside completely on touch devices or when the user prefers less
 * motion — in that case the native cursor is left completely untouched.
 */
export function CustomCursor() {
  const { resolvedTheme } = useTheme();
  const location = useLocation();

  const layerRef = useRef<HTMLDivElement | null>(null);
  const dotAnchorRef = useRef<HTMLDivElement | null>(null);
  const ringAnchorRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const pulseRef = useRef<HTMLDivElement | null>(null);
  /** Lets the route change re-use the exact same target logic. */
  const applyTargetRef = useRef<((target: Element | null) => void) | null>(null);

  const runtimeRef = useRef<CursorRuntime | null>(null);
  if (runtimeRef.current === null) runtimeRef.current = createRuntime();
  const runtime = runtimeRef.current;

  useEffect(() => {
    const layer = layerRef.current;
    const dotAnchor = dotAnchorRef.current;
    const ringAnchor = ringAnchorRef.current;
    const label = labelRef.current;
    if (!layer || !dotAnchor || !ringAnchor || !label) return;

    // The custom cursor is a pointer refinement — it needs a real mouse.
    if (typeof window.matchMedia !== 'function') return;
    const pointerQuery = window.matchMedia(CURSOR_POINTER_QUERY);
    if (!pointerQuery.matches) return;

    const motionQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const state = runtime;

    state.simplified = motionQuery.matches;
    state.mode = 'default';
    state.target = null;
    state.visible = false;
    state.placed = false;
    state.pressed = false;
    state.pulse?.cancel();
    state.pulse = null;
    layer.dataset.mode = 'default';
    layer.dataset.pressed = 'false';
    layer.dataset.visible = 'false';
    layer.dataset.invert = 'false';

    // Only now is it safe to take the native cursor away.
    document.documentElement.dataset.cursor = 'custom';

    const setMode = (mode: CursorMode) => {
      if (state.mode === mode) return;
      state.mode = mode;
      layer.dataset.mode = mode;
    };

    const setLabel = (text: string | undefined) => {
      if (text) {
        if (label.textContent !== text) label.textContent = text;
        label.dataset.visible = 'true';
      } else {
        if (label.textContent) label.textContent = '';
        label.dataset.visible = 'false';
      }
    };

    const applyTarget = (target: Element | null) => {
      const info = readTargetInfo(target);
      const mode = resolveCursorMode(info);
      setMode(mode);
      const labelOwner = target?.closest('[data-cursor-label]') ?? null;
      setLabel(resolveCursorLabel(mode, labelOwner?.getAttribute('data-cursor-label')));
      state.surfaceDirty = true;
    };
    applyTargetRef.current = applyTarget;

    const updateSurface = () => {
      const luminance = resolveSurfaceLuminance(state.target);
      layer.dataset.invert = shouldInvertCursor(luminance) ? 'true' : 'false';
    };

    /** The element that is really underneath the pointer right now. */
    const elementUnderPointer = (): Element | null => {
      if (!state.placed) return null;
      const element = document.elementFromPoint(state.pointerX, state.pointerY);
      return element instanceof Element ? element : null;
    };

    const spawnPulse = (x: number, y: number) => {
      const pulse = pulseRef.current;
      if (!pulse || state.simplified) return;
      // A new pulse replaces the running one, so rapid clicks never stack.
      state.pulse?.cancel();
      state.pulse = pulse.animate(
        [
          {
            transform: `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${PULSE_FROM_SCALE})`,
            opacity: PULSE_MAX_OPACITY,
          },
          {
            transform: `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${PULSE_TO_SCALE})`,
            opacity: 0,
          },
        ],
        { duration: PULSE_DURATION, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
    };

    const frame = (now: number) => {
      state.frame = null;
      const dt = clamp((now - state.lastFrameAt) / 1000, 0, 0.064);
      state.lastFrameAt = now;

      // The surface is read one frame after the pointer arrived, so a
      // :hover background is already applied.
      if (state.surfaceDirty) {
        state.surfaceDirty = false;
        updateSurface();
      }

      // A press that was never released (pointer left the window).
      if (state.pressed && now - state.pressedAt > PRESS_HOLD_MS) {
        state.pressed = false;
        layer.dataset.pressed = 'false';
      }

      const dotTau = state.simplified ? 0 : DOT_TAU;
      const ringTau = state.simplified ? 0 : RING_TAU;

      state.dotX = damp(state.dotX, state.pointerX, dotTau, dt);
      state.dotY = damp(state.dotY, state.pointerY, dotTau, dt);
      state.ringX = damp(state.ringX, state.pointerX, ringTau, dt);
      state.ringY = damp(state.ringY, state.pointerY, ringTau, dt);

      // The position and the scale live on separate elements, so growing the
      // cursor can never shift the point it points at.
      dotAnchor.style.transform = `translate3d(${state.dotX}px, ${state.dotY}px, 0)`;
      ringAnchor.style.transform = `translate3d(${state.ringX}px, ${state.ringY}px, 0)`;

      const settled =
        isSettled([state.dotX - state.pointerX, state.dotY - state.pointerY], 0.05) &&
        isSettled([state.ringX - state.pointerX, state.ringY - state.pointerY], 0.05);

      if (!settled) start();
    };

    const start = () => {
      if (state.frame !== null) return;
      state.lastFrameAt = performance.now();
      state.frame = requestAnimationFrame(frame);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      state.pointerX = event.clientX;
      state.pointerY = event.clientY;

      if (!state.placed) {
        state.placed = true;
        state.dotX = state.ringX = state.pointerX;
        state.dotY = state.ringY = state.pointerY;
      }

      if (!state.visible) {
        state.visible = true;
        layer.dataset.visible = 'true';
      }

      const target = event.target instanceof Element ? event.target : null;
      if (target !== state.target) {
        state.target = target;
        applyTarget(target);
      }
      start();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      if (event.button !== 0) return;
      state.pointerX = event.clientX;
      state.pointerY = event.clientY;
      state.pressed = true;
      state.pressedAt = performance.now();
      layer.dataset.pressed = 'true';
      spawnPulse(event.clientX, event.clientY);
      start();
    };

    const onPointerUp = () => {
      if (!state.pressed) return;
      state.pressed = false;
      layer.dataset.pressed = 'false';
      start();
    };

    const onPointerLeave = () => {
      state.visible = false;
      layer.dataset.visible = 'false';
    };

    const onPointerEnter = () => {
      state.visible = true;
      layer.dataset.visible = 'true';
      start();
    };

    const onBlur = () => {
      state.pressed = false;
      layer.dataset.pressed = 'false';
      onPointerLeave();
    };

    const onVisibilityChange = () => {
      if (document.hidden) onBlur();
    };

    /** The page moved under the pointer — find out what is underneath now. */
    const onScroll = () => {
      const element = elementUnderPointer();
      if (element !== state.target) {
        state.target = element;
        applyTarget(element);
      }
      start();
    };

    const onResize = () => {
      const element = elementUnderPointer();
      if (element !== state.target) {
        state.target = element;
        applyTarget(element);
      }
      start();
    };

    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      state.simplified = event.matches;
      start();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    document.documentElement.addEventListener('pointerenter', onPointerEnter);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    motionQuery.addEventListener('change', onMotionPreferenceChange);

    return () => {
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = null;
      state.pulse?.cancel();
      state.pulse = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      document.documentElement.removeEventListener('pointerenter', onPointerEnter);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      motionQuery.removeEventListener('change', onMotionPreferenceChange);
      delete document.documentElement.dataset.cursor;
      applyTargetRef.current = null;
      state.visible = false;
      state.placed = false;
      state.target = null;
    };
  }, [runtime]);

  // A route change replaces the markup under the pointer — re-read it.
  useEffect(() => {
    if (!runtime.placed) return;
    const element = document.elementFromPoint(runtime.pointerX, runtime.pointerY);
    const next = element instanceof Element ? element : null;
    if (next === runtime.target) return;
    runtime.target = next;
    applyTargetRef.current?.(next);
  }, [location, runtime]);

  return (
    <div
      ref={layerRef}
      className="cursor-layer"
      data-mode="default"
      data-pressed="false"
      data-visible="false"
      data-invert="false"
      data-theme={resolvedTheme}
      aria-hidden="true"
    >
      <div ref={ringAnchorRef} className="cursor-anchor">
        <div className="cursor-ring" />
      </div>
      <div ref={dotAnchorRef} className="cursor-anchor">
        <div className="cursor-dot" />
        <div className="cursor-caret" />
        <div ref={labelRef} className="cursor-label" data-visible="false" />
      </div>
      <div ref={pulseRef} className="cursor-pulse" />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  CURSOR_DEFAULT_SCALE,
  CURSOR_MAX_FRAME_SECONDS,
  CURSOR_POINTER_QUERY,
  EMBEDDED_SELECTOR,
  INTERACTIVE_SELECTOR,
  NATIVE_CURSOR_SELECTOR,
  REDUCED_MOTION_QUERY,
  resolveCursorScale,
  resolveCursorState,
  smoothPosition,
  springForScale,
  springStep,
  type CursorState,
} from '../../lib/cursor';

/** Below these distances the animation is visually finished. */
const POSITION_REST = 0.1;
const SCALE_REST = 0.002;
const SCALE_VELOCITY_REST = 0.05;

/**
 * A single solid #CCD0CF dot that follows the pointer. It grows to 17px over
 * anything interactive and to 25px while the primary button is held.
 *
 * Performance: React never re-renders on pointer movement. Listeners only
 * record the pointer target; one requestAnimationFrame loop eases the anchor
 * toward it, springs the dot's scale toward its target and writes both
 * transforms directly to the DOM. The loop parks itself once position and
 * scale are at rest, so an idle cursor costs nothing.
 *
 * The native cursor is only removed once the capability checks pass, and it
 * is restored for text fields, selectable regions, disabled controls,
 * draggable elements and native resize handles via the stylesheet.
 */
export function CustomCursor() {
  const location = useLocation();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const dotRef = useRef<HTMLDivElement | null>(null);
  const reevaluateRef = useRef<(() => void) | null>(null);
  const [enabled, setEnabled] = useState(false);

  // Touch devices and reduced-motion users never get the custom cursor.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const pointerQuery = window.matchMedia(CURSOR_POINTER_QUERY);
    const motionQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = () => setEnabled(pointerQuery.matches && !motionQuery.matches);

    sync();
    pointerQuery.addEventListener('change', sync);
    motionQuery.addEventListener('change', sync);

    return () => {
      pointerQuery.removeEventListener('change', sync);
      motionQuery.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const layer = layerRef.current;
    const anchor = anchorRef.current;
    const dot = dotRef.current;
    if (!layer || !anchor || !dot) return;

    const root = document.documentElement;
    root.dataset.cursor = 'custom';

    let visible = false;
    let placed = false;
    let pressed = false;
    let state: CursorState = 'default';
    let lastTarget: Element | null = null;

    // Where the pointer is versus where the dot is currently drawn.
    let pointerX = 0;
    let pointerY = 0;
    let renderedX = 0;
    let renderedY = 0;

    let scale = CURSOR_DEFAULT_SCALE;
    let scaleVelocity = 0;
    let scaleTarget = CURSOR_DEFAULT_SCALE;

    // Last values handed to the browser, so a settled cursor writes nothing.
    let paintedX = Number.NaN;
    let paintedY = Number.NaN;
    let paintedScale = Number.NaN;

    let frame = 0;
    let lastFrame = 0;

    layer.dataset.state = 'default';
    layer.dataset.pressed = 'false';
    layer.dataset.visible = 'false';

    const paint = () => {
      if (renderedX !== paintedX || renderedY !== paintedY) {
        anchor.style.transform = `translate3d(${renderedX}px, ${renderedY}px, 0)`;
        paintedX = renderedX;
        paintedY = renderedY;
      }
      if (scale !== paintedScale) {
        dot.style.transform = `scale(${scale})`;
        paintedScale = scale;
      }
    };

    const tick = (now: number) => {
      frame = 0;

      const delta = Math.min(
        Math.max((now - lastFrame) / 1000, 0),
        CURSOR_MAX_FRAME_SECONDS,
      );
      lastFrame = now;

      renderedX = smoothPosition(renderedX, pointerX, delta);
      renderedY = smoothPosition(renderedY, pointerY, delta);

      const spring = springForScale(scale, scaleTarget, pressed);
      const next = springStep(scale, scaleVelocity, scaleTarget, spring, delta);
      scale = next.value;
      scaleVelocity = next.velocity;

      const positionSettled =
        Math.abs(pointerX - renderedX) <= POSITION_REST &&
        Math.abs(pointerY - renderedY) <= POSITION_REST;
      const scaleSettled =
        Math.abs(scaleTarget - scale) <= SCALE_REST &&
        Math.abs(scaleVelocity) <= SCALE_VELOCITY_REST;

      if (positionSettled) {
        renderedX = pointerX;
        renderedY = pointerY;
      }
      if (scaleSettled) {
        scale = scaleTarget;
        scaleVelocity = 0;
      }

      paint();

      if (!positionSettled || !scaleSettled) {
        frame = requestAnimationFrame(tick);
      }
    };

    const wake = () => {
      if (frame !== 0) return;
      lastFrame = performance.now();
      frame = requestAnimationFrame(tick);
    };

    const syncScaleTarget = () => {
      const next = resolveCursorScale(state, pressed);
      if (next === scaleTarget) return;
      scaleTarget = next;
      wake();
    };

    const setVisible = (next: boolean) => {
      if (visible === next) return;
      visible = next;
      layer.dataset.visible = next ? 'true' : 'false';
    };

    const setPressed = (next: boolean) => {
      if (pressed === next) return;
      pressed = next;
      layer.dataset.pressed = next ? 'true' : 'false';
      syncScaleTarget();
    };

    const setState = (next: CursorState) => {
      if (state === next) return;
      state = next;
      layer.dataset.state = next;
      syncScaleTarget();
    };

    const evaluate = (target: Element | null) => {
      if (!target || !target.isConnected) {
        setState('default');
        return;
      }
      setState(
        resolveCursorState({
          isEmbedded: target.closest(EMBEDDED_SELECTOR) !== null,
          isNative: target.closest(NATIVE_CURSOR_SELECTOR) !== null,
          isInteractive: target.closest(INTERACTIVE_SELECTOR) !== null,
        }),
      );
    };

    /** The markup can change without the pointer moving (scroll, modals, routes). */
    const reevaluate = () => {
      if (!placed) return;
      const target = document.elementFromPoint(pointerX, pointerY);
      if (!(target instanceof Element) || target === lastTarget) return;
      evaluate(target);
    };
    reevaluateRef.current = reevaluate;

    // Re-entering the window must never glide in from wherever the dot was
    // parked; the first frame after entry appears under the pointer.
    const snapToPointer = () => {
      renderedX = pointerX;
      renderedY = pointerY;
      paint();
    };

    // The dot was invisible while the pointer was away, so it should reappear
    // at the size the new element calls for rather than finishing an old
    // hover transition.
    const settleScale = () => {
      scale = scaleTarget;
      scaleVelocity = 0;
      paint();
    };

    const trackPointer = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!placed || !visible) {
        snapToPointer();
        placed = true;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;

      const wasVisible = visible;
      trackPointer(event);
      setVisible(true);

      const target = event.target;
      if (target instanceof Element && target !== lastTarget) evaluate(target);

      if (!wasVisible) settleScale();
      wake();
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      if (event.target instanceof Element) evaluate(event.target);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      if (event.button !== 0) return;

      const wasVisible = visible;
      trackPointer(event);
      evaluate(event.target instanceof Element ? event.target : null);
      setPressed(true);
      setVisible(true);
      if (!wasVisible) settleScale();
      wake();
    };

    const onPointerUp = () => setPressed(false);
    const onPointerCancel = () => setPressed(false);

    const onPointerLeave = () => {
      setPressed(false);
      setVisible(false);
    };

    const onPointerEnter = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;

      trackPointer(event);
      placed = true;
      snapToPointer();
      setPressed(false);
      setVisible(true);
      reevaluate();
      settleScale();
      wake();
    };

    const onBlur = () => {
      setPressed(false);
      setVisible(false);
    };

    const onVisibilityChange = () => {
      if (document.hidden) onBlur();
    };

    const onScroll = () => reevaluate();
    const onResize = () => reevaluate();

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerover', onPointerOver, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    document.documentElement.addEventListener('pointerenter', onPointerEnter);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerover', onPointerOver);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      document.documentElement.removeEventListener('pointerenter', onPointerEnter);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);

      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;

      delete root.dataset.cursor;
      anchor.style.transform = '';
      dot.style.transform = '';
      layer.dataset.state = 'default';
      layer.dataset.pressed = 'false';
      layer.dataset.visible = 'false';
      reevaluateRef.current = null;
      lastTarget = null;
    };
  }, [enabled]);

  // A route change replaces the markup underneath a stationary pointer.
  useEffect(() => {
    reevaluateRef.current?.();
  }, [location.key]);

  return (
    <div
      ref={layerRef}
      className="custom-cursor"
      data-state="default"
      data-pressed="false"
      data-visible="false"
      aria-hidden="true"
    >
      <div ref={anchorRef} className="custom-cursor__anchor">
        <div ref={dotRef} className="custom-cursor__dot" />
      </div>
    </div>
  );
}

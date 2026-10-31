import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minus, X } from 'lucide-react';
import { clsx } from 'clsx';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const layerStack: symbol[] = [];
let nextZIndex = 60;
let openModalCount = 0;
let previousBodyOverflow = '';

function pushLayer(id: symbol): void {
  layerStack.push(id);
}

function moveLayerToTop(id: symbol): void {
  const index = layerStack.indexOf(id);
  if (index >= 0 && index !== layerStack.length - 1) {
    const [layer] = layerStack.splice(index, 1);
    layerStack.push(layer);
  }
}

function popLayer(id: symbol): void {
  const index = layerStack.indexOf(id);
  if (index >= 0) layerStack.splice(index, 1);
}

function isTopLayer(id: symbol): boolean {
  return layerStack[layerStack.length - 1] === id;
}

function lockBodyScroll(): void {
  if (openModalCount === 0 && typeof document !== 'undefined') {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  openModalCount += 1;
}

function unlockBodyScroll(): void {
  openModalCount = Math.max(0, openModalCount - 1);
  if (openModalCount === 0 && typeof document !== 'undefined') {
    document.body.style.overflow = previousBodyOverflow;
  }
}

export type FloatingWindowSize = 'todo' | 'daily' | 'panel' | 'compact';

export const WINDOW_PRESETS: Record<
  FloatingWindowSize,
  { width: number; minWidth: number; height?: number; maxVh: number }
> = {
  todo: { width: 380, minWidth: 320, height: 460, maxVh: 70 },
  daily: { width: 480, minWidth: 380, height: 540, maxVh: 75 },
  panel: { width: 420, minWidth: 320, maxVh: 75 },
  compact: { width: 360, minWidth: 320, maxVh: 70 },
};

interface WindowBounds {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}

/** Keeps a floating window inside the viewport while it is dragged or resized. */
export function clampWindowPosition(
  position: { x: number; y: number },
  bounds: WindowBounds
): { x: number; y: number } {
  const margin = bounds.margin ?? 8;
  const maxX = Math.max(margin, bounds.viewportWidth - bounds.width - margin);
  const maxY = Math.max(
    margin,
    bounds.viewportHeight - Math.min(bounds.height, bounds.viewportHeight - margin * 2) - margin
  );
  return {
    x: Math.min(Math.max(margin, position.x), maxX),
    y: Math.min(Math.max(margin, position.y), maxY),
  };
}

function useViewport(): { width: number; height: number } {
  const [viewport, setViewport] = useState(() =>
    typeof window === 'undefined'
      ? { width: 1280, height: 800 }
      : { width: window.innerWidth, height: window.innerHeight }
  );

  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return viewport;
}

export interface FloatingWindowProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  headerActions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: FloatingWindowSize;
  /** Right inset of the default desktop position in px (before viewport clamping). */
  defaultRight?: number;
  defaultTop?: number;
  /** Nested dialog: small scrim, centered, focus-trapped. */
  modal?: boolean;
  /** Show a minimize control in the header. Defaults to true for utilities. */
  collapsible?: boolean;
  /** Called when the user interacts with the window, so the owner can raise it. */
  onActivate?: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  ariaLabel?: string;
}

/**
 * Compact macOS-style utility window.
 *
 * Utilities float above the dashboard without a full-screen scrim, can be
 * dragged by their header on desktop, and stack independently. Nested dialogs
 * opt into `modal` for a light scrim and focus trapping. Below `sm` the same
 * window becomes a bottom sheet.
 */
export function FloatingWindow({
  open,
  onClose,
  title,
  subtitle,
  icon: Icon,
  headerActions,
  children,
  footer,
  size = 'panel',
  defaultRight = 96,
  defaultTop = 88,
  modal = false,
  collapsible,
  onActivate,
  initialFocusRef,
  ariaLabel,
}: FloatingWindowProps) {
  const titleId = useId();
  const layerId = useRef(Symbol('floating-window')).current;
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const activateRef = useRef(onActivate);
  const movedRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const [zIndex, setZIndex] = useState(60);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  const viewport = useViewport();
  const isDesktop = viewport.width >= 640;
  const preset = WINDOW_PRESETS[size];
  const panelWidth = Math.min(preset.width, Math.max(280, viewport.width - 16));
  const estimatedHeight = preset.height ?? Math.min(520, viewport.height - 32);
  const minimizable = collapsible ?? !modal;

  closeRef.current = onClose;
  activateRef.current = onActivate;

  const defaultPosition = useCallback(() => {
    const inset =
      viewport.width >= 1024 ? defaultRight : Math.max(16, defaultRight - 80);
    const x = viewport.width - panelWidth - inset;
    return clampWindowPosition(
      { x, y: defaultTop },
      {
        width: panelWidth,
        height: estimatedHeight,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      }
    );
  }, [viewport.width, viewport.height, panelWidth, estimatedHeight, defaultRight, defaultTop]);

  // Utilities keep their position while open; a fresh open returns to the slot
  // its owner asked for unless the user has already dragged this window.
  useEffect(() => {
    if (!open || !isDesktop || modal) return;
    setPosition((current) => {
      if (!current || !movedRef.current) return defaultPosition();
      return clampWindowPosition(current, {
        width: panelWidth,
        height: estimatedHeight,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
    });
  }, [open, isDesktop, modal, defaultPosition, panelWidth, estimatedHeight, viewport.width, viewport.height]);

  useEffect(() => {
    if (!open) return;

    pushLayer(layerId);
    setZIndex(++nextZIndex);
    if (modal) lockBodyScroll();

    const previouslyFocused =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

    let focusTimer: number | undefined;
    if (modal) {
      focusTimer = window.setTimeout(() => {
        const target =
          initialFocusRef?.current ||
          panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ||
          panelRef.current;
        target?.focus();
      }, 30);
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopLayer(layerId)) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }

      if (!modal || event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((element) => element.offsetParent !== null || element === document.activeElement);

      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      if (focusTimer) window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      popLayer(layerId);
      if (modal) {
        unlockBodyScroll();
        if (previouslyFocused?.isConnected) {
          previouslyFocused.focus({ preventScroll: true });
        }
      } else if (
        previouslyFocused?.isConnected &&
        panelRef.current?.contains(document.activeElement)
      ) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open, modal, initialFocusRef, layerId]);

  const activate = useCallback(() => {
    if (!isTopLayer(layerId)) {
      moveLayerToTop(layerId);
      setZIndex(++nextZIndex);
    }
    activateRef.current?.();
  }, [layerId]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDesktop || modal || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, [data-no-drag]')) return;

    const origin = position ?? defaultPosition();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    activate();
  };

  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampWindowPosition(
      {
        x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY,
      },
      {
        width: panelWidth,
        height: estimatedHeight,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      }
    );
    if (
      Math.abs(event.clientX - drag.startX) > 2 ||
      Math.abs(event.clientY - drag.startY) > 2
    ) {
      movedRef.current = true;
    }
    setPosition(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  if (!open || typeof document === 'undefined') return null;

  const resolvedPosition = position ?? defaultPosition();
  const panelStyle: CSSProperties = isDesktop
    ? {
        left: modal ? undefined : resolvedPosition.x,
        top: modal ? undefined : resolvedPosition.y,
        width: panelWidth,
        height: collapsed ? undefined : preset.height,
        maxHeight: collapsed ? undefined : `${preset.maxVh}dvh`,
      }
    : { maxHeight: '85dvh' };

  return createPortal(
    <div style={{ zIndex }} className="pointer-events-none fixed inset-0">
      {modal && (
        <div
          className="pointer-events-auto absolute inset-0 bg-overlay/20 backdrop-blur-[2px] animate-fade-in"
          onPointerDown={() => {
            if (isTopLayer(layerId)) onClose();
          }}
          aria-hidden="true"
        />
      )}

      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal || undefined}
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-label={ariaLabel}
        tabIndex={-1}
        onPointerDownCapture={activate}
        onFocusCapture={activate}
        style={panelStyle}
        className={clsx(
          'floating-utility pointer-events-auto flex flex-col overflow-hidden border border-line/80 outline-none animate-window-in',
          isDesktop && !modal && 'absolute rounded-2xl',
          isDesktop && modal && 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-2xl',
          !isDesktop && 'absolute inset-x-2 bottom-2 rounded-2xl'
        )}
      >
        <header
          onPointerDown={startDrag}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={clsx(
            'flex shrink-0 select-none items-center justify-between gap-2 border-b border-line/70 px-3 py-2',
            isDesktop && !modal && 'cursor-grab touch-none',
            dragging && 'cursor-grabbing'
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {Icon && (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-muted">
                <Icon className="h-3.5 w-3.5" />
              </span>
            )}
            <div className="min-w-0">
              <h2
                id={titleId}
                className="truncate text-[13px] font-semibold leading-tight tracking-tight text-ink"
              >
                {title}
              </h2>
              {subtitle && (
                <p className="mt-0.5 truncate text-[10px] leading-tight text-ink-muted">
                  {subtitle}
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {headerActions}
            {minimizable && (
              <button
                type="button"
                onClick={() => setCollapsed((current) => !current)}
                aria-label={collapsed ? 'Expand window' : 'Minimize window'}
                title={collapsed ? 'Expand window' : 'Minimize window'}
                className="rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
              >
                {collapsed ? <Maximize2 className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close window"
              title="Close window"
              className="rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {!collapsed && (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
            {footer && (
              <footer className="shrink-0 border-t border-line/70 bg-surface/40 px-3 py-2.5">
                {footer}
              </footer>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

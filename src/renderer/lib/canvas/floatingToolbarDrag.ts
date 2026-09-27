/**
 * Drag for a board's floating side toolbar (Mind Map, Kanban, Task List).
 *
 * The toolbar moves by its background only: a press on a button or an open
 * menu never starts a drag, so clicks keep working. A pinned toolbar never
 * starts one either. Positions are window pixels of the toolbar's top-left,
 * clamped so the toolbar can't be dropped out of reach.
 */

/** Where a floating board toolbar sits, in window pixels. */
export interface ToolbarPosition {
  x: number;
  y: number;
}

/** How much of the toolbar stays inside the window at the right and bottom edges. */
export const TOOLBAR_KEEP_VISIBLE_PX = 60;

export interface FloatingToolbarDragOptions {
  /** Presses inside an element matching this never start a drag. */
  ignoreSelector: string;
  /** A pinned toolbar ignores presses on its background. */
  isPinned: () => boolean;
  onStart: () => void;
  onMove: (position: ToolbarPosition) => void;
  /**
   * The drag is over. `position` is where it was let go, or null when it never
   * moved or the browser cancelled it (the toolbar goes back where it was).
   */
  onEnd: (position: ToolbarPosition | null) => void;
}

export interface FloatingToolbarDragHandlers {
  onpointerdown: (e: PointerEvent) => void;
  onpointermove: (e: PointerEvent) => void;
  onpointerup: (e: PointerEvent) => void;
  onpointercancel: (e: PointerEvent) => void;
}

export function clampToolbarPosition(
  position: ToolbarPosition,
  viewportWidth: number,
  viewportHeight: number,
): ToolbarPosition {
  return {
    x: Math.max(0, Math.min(viewportWidth - TOOLBAR_KEEP_VISIBLE_PX, position.x)),
    y: Math.max(0, Math.min(viewportHeight - TOOLBAR_KEEP_VISIBLE_PX, position.y)),
  };
}

/**
 * Inline style for a toolbar at `position` (clamped to the current window), or
 * '' to leave it docked where its stylesheet puts it.
 */
export function floatingToolbarStyle(position: ToolbarPosition | null): string {
  if (!position) return '';
  const { x, y } = clampToolbarPosition(position, window.innerWidth, window.innerHeight);
  return `position: fixed; left: ${x}px; top: ${y}px; right: auto; bottom: auto; transform: none;`;
}

export function createFloatingToolbarDrag(options: FloatingToolbarDragOptions): FloatingToolbarDragHandlers {
  let pointerId: number | null = null;
  let offset: ToolbarPosition = { x: 0, y: 0 };
  let last: ToolbarPosition | null = null;

  function release(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement | null;
    if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    pointerId = null;
  }

  return {
    onpointerdown(e) {
      if (e.button !== 0 || pointerId !== null || options.isPinned()) return;
      const target = e.target as Element | null;
      if (target?.closest(options.ignoreSelector)) return;
      const el = e.currentTarget as HTMLElement;
      const rect = el.getBoundingClientRect();
      offset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      pointerId = e.pointerId;
      last = null;
      el.setPointerCapture?.(e.pointerId);
      options.onStart();
    },
    onpointermove(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      last = clampToolbarPosition(
        { x: Math.round(e.clientX - offset.x), y: Math.round(e.clientY - offset.y) },
        window.innerWidth,
        window.innerHeight,
      );
      options.onMove(last);
    },
    onpointerup(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      release(e);
      options.onEnd(last);
      last = null;
    },
    onpointercancel(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      release(e);
      last = null;
      options.onEnd(null);
    },
  };
}

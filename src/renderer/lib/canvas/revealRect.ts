/**
 * How far the view must move to show a rectangle: what keyboard selection on
 * the Mind Map uses, so a tile the arrow keys select off screen is brought
 * into view, and one already in view leaves the view where it is.
 */
import type { ViewportRect } from '../../stores/canvas.svelte';

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The move (in canvas units) that puts `rect` inside `view` with `margin`
 * around it: zero on an axis where it already fits. A rect wider or taller
 * than the view lines up with its top-left edge on that axis.
 */
export function revealOffset(view: ViewportRect, rect: CanvasRect, margin = 40): { dx: number; dy: number } {
  const axis = (start: number, size: number, viewStart: number, viewEnd: number): number => {
    const lo = start - margin;
    const hi = start + size + margin;
    if (lo < viewStart) return lo - viewStart;
    if (hi > viewEnd) return Math.min(hi - viewEnd, lo - viewStart);
    return 0;
  };
  return {
    dx: axis(rect.x, rect.width, view.left, view.right),
    dy: axis(rect.y, rect.height, view.top, view.bottom),
  };
}

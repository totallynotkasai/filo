/**
 * Shared anchor calculation for popovers (tag editor, context menus,
 * style popups, etc.).
 *
 * Replaces the scattered `rect.left, rect.bottom + 4` calls that every
 * popover site re-implemented independently. Centralising the offset
 * means a future "tighter / looser anchor" change is one edit and every
 * popover stays visually consistent.
 */

export interface AnchorPoint {
  x: number;
  y: number;
}

export interface AnchorBelowOptions {
  /** Pixels between the element's bottom edge and the popover. Default `4`. */
  offset?: number;
  /** Horizontal alignment relative to the element. Default `'start'` (left edge). */
  align?: 'start' | 'end';
}

/**
 * Returns an `{x, y}` viewport point just below the given element, suitable
 * for positioning a popover that anchors to the element's bottom-left (or
 * bottom-right with `align: 'end'`) corner.
 */
export function getAnchorBelow(el: HTMLElement, opts: AnchorBelowOptions = {}): AnchorPoint {
  const offset = opts.offset ?? 4;
  const rect = el.getBoundingClientRect();
  const x = opts.align === 'end' ? rect.right : rect.left;
  return { x, y: rect.bottom + offset };
}

export interface ClampToViewportOptions {
  /** Minimum gap kept between the box and each viewport edge. Default `8`. */
  margin?: number;
}

/**
 * Clamps a popover's top-left corner so a `width`×`height` box stays fully
 * inside the viewport with at least `margin` px from every edge. Used by the
 * context menu (L4b) to reposition after measuring its *real* rendered size,
 * replacing the old `items.length * 32` height guess that overflowed when a
 * menu opened near the bottom edge.
 *
 * When the box is larger than the viewport along an axis, the top-left pins to
 * `margin` on that axis (the overflow then bleeds off the far edge, which is
 * unavoidable for an oversized box).
 */
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  opts: ClampToViewportOptions = {},
): AnchorPoint {
  const margin = opts.margin ?? 8;
  const maxX = Math.max(margin, viewportWidth - width - margin);
  const maxY = Math.max(margin, viewportHeight - height - margin);
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}

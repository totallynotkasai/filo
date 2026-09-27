/**
 * Where the Task List's floating Table of Contents first opens, before the
 * user has moved it (then its own bounds are saved on the board).
 *
 * Top right, clear of the side toolbar. When the list column leaves room
 * beside it, the panel sits in that space, narrowed as far as a readable
 * width, so it doesn't cover the tasks or the progress count.
 */

export interface TocBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TOC_DEFAULTS = {
  width: 220,
  /** Narrowest the panel is made to fit beside the list. */
  minWidth: 180,
  height: 320,
  top: 100,
  /** Clears the side toolbar (~48px wide at right: 16px) with a 16px gap. */
  rightMargin: 80,
  /** Gap between the list column and the panel. */
  gap: 12,
} as const;

/**
 * The first bounds for a viewport `viewportWidth` wide, with the list
 * column's right edge at `listRight` (null when it isn't laid out).
 */
export function tocDefaultBounds(viewportWidth: number, listRight: number | null): TocBounds {
  const rightEdge = viewportWidth - TOC_DEFAULTS.rightMargin;
  const corner: TocBounds = {
    x: Math.max(8, rightEdge - TOC_DEFAULTS.width),
    y: TOC_DEFAULTS.top,
    width: TOC_DEFAULTS.width,
    height: TOC_DEFAULTS.height,
  };
  if (listRight === null || corner.x >= listRight + TOC_DEFAULTS.gap) return corner;
  const x = Math.ceil(listRight + TOC_DEFAULTS.gap);
  const width = Math.min(TOC_DEFAULTS.width, rightEdge - x);
  return width >= TOC_DEFAULTS.minWidth ? { ...corner, x, width } : corner;
}

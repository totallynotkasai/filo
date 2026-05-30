/**
 * Smart guides computation — detects alignment between tiles during drag/resize
 * and suggests snap positions for precise alignment.
 */

export interface Guide {
  /** Whether this guide line is horizontal or vertical. */
  type: 'horizontal' | 'vertical';
  /** Canvas coordinate of the guide (x for vertical, y for horizontal). */
  position: number;
  /** Which edge of the dragged tile matched. */
  sourceEdge: string;
  /** ID of the tile this guide aligns with. */
  targetTileId: string;
}

export interface SnapResult {
  /** Guide lines to display. */
  guides: Guide[];
  /** Suggested X snap position, or null if no horizontal snap. */
  snapX: number | null;
  /** Suggested Y snap position, or null if no vertical snap. */
  snapY: number | null;
}

export interface TileBounds {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_THRESHOLD = 8; // pixels in canvas space
const MAX_GUIDES = 6;

/**
 * Sprint B / B7 — keep only the N other-tiles closest to the dragged tile
 * by L∞ distance (max of |Δx|, |Δy|) between tile centres. Mutates `tiles`
 * in place when it exceeds `max`; otherwise leaves it untouched. Returning
 * void rather than a new array keeps the GC pressure low — this runs every
 * frame of a drag on dense boards.
 *
 * `computeGuides` is O(n × 36) (3 vertical × 3 horizontal edges per other
 * tile), so capping at ~100 keeps a 1000-tile drag under 16 ms while still
 * surfacing every alignment opportunity the user typically cares about
 * (alignment is dominated by the few nearest neighbours in practice).
 */
export function capCandidatesByDistance(
  dragged: TileBounds,
  tiles: TileBounds[],
  max: number,
): void {
  if (tiles.length <= max) return;
  const px = dragged.x + dragged.width / 2;
  const py = dragged.y + dragged.height / 2;
  tiles.sort((a, b) => {
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2;
    const by = b.y + b.height / 2;
    return (
      Math.max(Math.abs(ax - px), Math.abs(ay - py)) -
      Math.max(Math.abs(bx - px), Math.abs(by - py))
    );
  });
  tiles.length = max;
}

/**
 * Computes alignment guides and snap positions for a dragged tile against other tiles.
 *
 * Checks 3 vertical alignment points (left, centerX, right) and
 * 3 horizontal alignment points (top, centerY, bottom) of the dragged tile
 * against the same points of every other tile.
 */
export function computeGuides(
  dragged: TileBounds,
  otherTiles: TileBounds[],
  threshold: number = DEFAULT_THRESHOLD,
): SnapResult {
  const guides: Guide[] = [];
  let snapX: number | null = null;
  let snapY: number | null = null;
  let bestDx = threshold + 1;
  let bestDy = threshold + 1;

  // Dragged tile alignment points
  const dragLeft = dragged.x;
  const dragCenterX = dragged.x + dragged.width / 2;
  const dragRight = dragged.x + dragged.width;
  const dragTop = dragged.y;
  const dragCenterY = dragged.y + dragged.height / 2;
  const dragBottom = dragged.y + dragged.height;

  const verticalEdges = [
    { value: dragLeft, edge: 'left', offset: 0 },
    { value: dragCenterX, edge: 'centerX', offset: dragged.width / 2 },
    { value: dragRight, edge: 'right', offset: dragged.width },
  ];

  const horizontalEdges = [
    { value: dragTop, edge: 'top', offset: 0 },
    { value: dragCenterY, edge: 'centerY', offset: dragged.height / 2 },
    { value: dragBottom, edge: 'bottom', offset: dragged.height },
  ];

  for (const other of otherTiles) {
    if (other.id === dragged.id) continue;

    const otherLeft = other.x;
    const otherCenterX = other.x + other.width / 2;
    const otherRight = other.x + other.width;
    const otherTop = other.y;
    const otherCenterY = other.y + other.height / 2;
    const otherBottom = other.y + other.height;

    const otherVerts = [otherLeft, otherCenterX, otherRight];
    const otherHoris = [otherTop, otherCenterY, otherBottom];

    // Check vertical alignment (x-axis snap)
    for (const dragEdge of verticalEdges) {
      for (const otherVal of otherVerts) {
        const dx = Math.abs(dragEdge.value - otherVal);
        if (dx <= threshold) {
          guides.push({
            type: 'vertical',
            position: otherVal,
            sourceEdge: dragEdge.edge,
            targetTileId: other.id,
          });
          if (dx < bestDx) {
            bestDx = dx;
            // Snap X is the value that makes this edge align
            snapX = otherVal - dragEdge.offset;
          }
        }
      }
    }

    // Check horizontal alignment (y-axis snap)
    for (const dragEdge of horizontalEdges) {
      for (const otherVal of otherHoris) {
        const dy = Math.abs(dragEdge.value - otherVal);
        if (dy <= threshold) {
          guides.push({
            type: 'horizontal',
            position: otherVal,
            sourceEdge: dragEdge.edge,
            targetTileId: other.id,
          });
          if (dy < bestDy) {
            bestDy = dy;
            // Snap Y is the value that makes this edge align
            snapY = otherVal - dragEdge.offset;
          }
        }
      }
    }
  }

  // Deduplicate guides by position+type and limit count
  const seen = new Set<string>();
  const uniqueGuides = guides.filter(g => {
    const key = `${g.type}:${g.position}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_GUIDES);

  return { guides: uniqueGuides, snapX, snapY };
}

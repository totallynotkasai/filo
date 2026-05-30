/**
 * Connection point (bubble) positions around a tile.
 *
 * Bubble index layout:
 *   0 ── 1 ── 2
 *   │           │
 *   7           3
 *   │           │
 *   6 ── 5 ── 4
 */

export interface BubblePosition {
  x: number;
  y: number;
  index: number;
}

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Returns the 8 bubble positions for a tile given its rect.
 */
export function getBubblePositions(rect: TileRect): BubblePosition[] {
  const { x, y, width, height } = rect;
  const cx = x + width / 2;
  const cy = y + height / 2;

  return [
    { x, y, index: 0 },                           // top-left
    { x: cx, y, index: 1 },                       // top-center
    { x: x + width, y, index: 2 },                // top-right
    { x: x + width, y: cy, index: 3 },            // middle-right
    { x: x + width, y: y + height, index: 4 },    // bottom-right
    { x: cx, y: y + height, index: 5 },           // bottom-center
    { x, y: y + height, index: 6 },               // bottom-left
    { x, y: cy, index: 7 },                       // middle-left
  ];
}

/**
 * Gets a single bubble position by index.
 */
export function getBubblePosition(rect: TileRect, bubbleIndex: number): { x: number; y: number } {
  const positions = getBubblePositions(rect);
  return positions[bubbleIndex] ?? positions[1];
}

/**
 * Returns the normal direction (unit vector) pointing outward from a bubble.
 */
export function getBubbleNormal(bubbleIndex: number): { nx: number; ny: number } {
  const normals = [
    { nx: -1, ny: -1 }, // 0: top-left
    { nx: 0, ny: -1 },  // 1: top-center
    { nx: 1, ny: -1 },  // 2: top-right
    { nx: 1, ny: 0 },   // 3: middle-right
    { nx: 1, ny: 1 },   // 4: bottom-right
    { nx: 0, ny: 1 },   // 5: bottom-center
    { nx: -1, ny: 1 },  // 6: bottom-left
    { nx: -1, ny: 0 },  // 7: middle-left
  ];
  return normals[bubbleIndex] ?? normals[1];
}

/**
 * Finds the nearest bubble on a tile to a given point.
 */
export function findNearestBubble(rect: TileRect, px: number, py: number): number {
  const positions = getBubblePositions(rect);
  let minDist = Infinity;
  let nearest = 1;

  for (const pos of positions) {
    const dx = pos.x - px;
    const dy = pos.y - py;
    const dist = dx * dx + dy * dy;
    if (dist < minDist) {
      minDist = dist;
      nearest = pos.index;
    }
  }

  return nearest;
}

/**
 * Returns the optimal pair of bubbles connecting two tile rects.
 * Picks the pair with the shortest distance.
 */
export function findOptimalBubbles(
  rectA: TileRect,
  rectB: TileRect,
): { fromBubble: number; toBubble: number } {
  const bubblesA = getBubblePositions(rectA);
  const bubblesB = getBubblePositions(rectB);

  let minDist = Infinity;
  let best = { fromBubble: 1, toBubble: 5 };

  for (const a of bubblesA) {
    for (const b of bubblesB) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = dx * dx + dy * dy;
      if (dist < minDist) {
        minDist = dist;
        best = { fromBubble: a.index, toBubble: b.index };
      }
    }
  }

  return best;
}

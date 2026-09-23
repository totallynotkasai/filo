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
  return positions[bubbleIndex] ?? positions[1] ?? { x: 0, y: 0 };
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
  return normals[bubbleIndex] ?? normals[1] ?? { nx: 0, ny: -1 };
}

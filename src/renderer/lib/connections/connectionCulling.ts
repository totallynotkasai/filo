/**
 * 3.3 — viewport culling for connections.
 *
 * `ConnectionLayer` previously rendered every connection (and recomputed
 * every label's path) on every drag frame with no viewport filter — an
 * O(connections) cost per frame that becomes the perf cliff on the large
 * boards we care about. Tiles are culled via the rbush spatial index;
 * connections were the blind spot.
 *
 * A connection is kept if the axis-aligned bounding box spanning its two
 * endpoint tiles intersects the buffered viewport. Because any routed
 * segment between the endpoints is wholly contained in that AABB, an AABB
 * miss proves the whole path is off-screen — so this never culls a path the
 * user can actually see (conservative). It mirrors how tiles are culled
 * (AABB + buffer), keeping the rendered connection set consistent with the
 * rendered tile set.
 */

export interface TileRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function connectionIntersectsViewport(
  fromRect: TileRectLike | null | undefined,
  toRect: TileRectLike | null | undefined,
  viewport: ViewportBounds,
  buffer: number,
): boolean {
  if (!fromRect || !toRect) return false;
  const left = Math.min(fromRect.x, toRect.x);
  const top = Math.min(fromRect.y, toRect.y);
  const right = Math.max(fromRect.x + fromRect.width, toRect.x + toRect.width);
  const bottom = Math.max(fromRect.y + fromRect.height, toRect.y + toRect.height);
  return !(
    right < viewport.left - buffer ||
    left > viewport.right + buffer ||
    bottom < viewport.top - buffer ||
    top > viewport.bottom + buffer
  );
}

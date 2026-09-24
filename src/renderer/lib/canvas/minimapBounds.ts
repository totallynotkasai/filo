/**
 * Minimap bounds math, split out so the all-tiles AABB can be
 * memoized independently of the viewport.
 *
 * The minimap's drawable region is the union of every tile's extent and the
 * current viewport rect, plus padding. A single derived would recompute the
 * WHOLE thing — including walking all tiles — on every pan/zoom frame (because
 * it reads `viewportRect`). A pure pan doesn't move any tile, so the tiles' AABB
 * is unchanged; only the cheap viewport union needs to re-run.
 *
 * `Minimap.svelte` keeps `tilesAABB = $derived(computeTilesAABB(tiles))` (keyed
 * on the tile set only — NOT the viewport) and
 * `bounds = $derived(computeMinimapBounds(tilesAABB, viewportRect))` (cheap
 * union + padding). On pan, only `bounds` re-runs; the tile walk is cached.
 */

export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MinimapTileLike {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

export interface MinimapViewportLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MinimapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
}

/**
 * Axis-aligned bounding box enclosing every tile, or `null` when there are no
 * tiles. Depends only on the tiles' positions/sizes, so a `$derived` wrapping
 * this never re-runs on a pan.
 */
export function computeTilesAABB(tiles: MinimapTileLike[]): AABB | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    if (t.position.x < minX) minX = t.position.x;
    if (t.position.y < minY) minY = t.position.y;
    const right = t.position.x + t.size.width;
    const bottom = t.position.y + t.size.height;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Unions the cached tiles AABB with the current viewport rect and applies the
 * 10% + 100px padding the minimap renders. Cheap — four min/max ops + the
 * padding — so re-running it per pan frame is negligible.
 */
export function computeMinimapBounds(
  aabb: AABB | null,
  vp: MinimapViewportLike,
): MinimapBounds {
  let minX = vp.left;
  let minY = vp.top;
  let maxX = vp.right;
  let maxY = vp.bottom;
  if (aabb) {
    if (aabb.minX < minX) minX = aabb.minX;
    if (aabb.minY < minY) minY = aabb.minY;
    if (aabb.maxX > maxX) maxX = aabb.maxX;
    if (aabb.maxY > maxY) maxY = aabb.maxY;
  }

  // 10% + 100px padding (preserves the prior single-derived behaviour).
  const rangeX = maxX - minX || 1000;
  const rangeY = maxY - minY || 1000;
  const padX = rangeX * 0.1 + 100;
  const padY = rangeY * 0.1 + 100;
  minX -= padX;
  minY -= padY;
  maxX += padX;
  maxY += padY;

  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

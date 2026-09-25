/**
 * Minimap bounds math.
 *
 * The minimap shows a *local window* around the viewport, not the whole board:
 * fitting every tile lets one far-away tile shrink everything else to dots and
 * the viewport box to its minimum size. The window is `LOCAL_FACTOR` times the
 * viewport's canvas extent, so it widens as the user zooms out and narrows as
 * they zoom in, and the viewport box stays one readable size.
 *
 * The tiles AABB is computed separately from the viewport so a `$derived`
 * wrapping it never re-walks every tile on a pan: `Minimap.svelte` keeps
 * `tilesAABB = $derived(computeTilesAABB(tiles))` and only the cheap window
 * math re-runs per pan frame.
 */

/** Window size as a multiple of the viewport's canvas width / height. */
export const LOCAL_FACTOR = 4;

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
 * True when a tile has a finite position and size. A NaN or Infinity anywhere
 * would turn every pip's style into `NaNpx` and blank the whole minimap.
 */
export function isFiniteTile(t: MinimapTileLike): boolean {
  return (
    Number.isFinite(t.position.x) &&
    Number.isFinite(t.position.y) &&
    Number.isFinite(t.size.width) &&
    Number.isFinite(t.size.height)
  );
}

/**
 * Axis-aligned bounding box enclosing every finite tile, or `null` when there
 * are none. Depends only on the tiles, so a `$derived` wrapping this never
 * re-runs on a pan.
 */
export function computeTilesAABB(tiles: MinimapTileLike[]): AABB | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    if (!isFiniteTile(t)) continue;
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
 * The whole board: the tiles AABB unioned with the viewport, padded by
 * 10% + 100px. The local window never strays outside this, so the minimap
 * shows no empty canvas beyond the board's edge when it can avoid it.
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

/**
 * Places a window of `size` on one axis. When the board is smaller than the
 * window, the window is centred on the board so all of it shows. Otherwise it
 * is centred on the viewport, but slid back inside the board near an edge.
 * Both branches agree when the board is exactly the window's size, so the
 * minimap never jumps as the user zooms across that point.
 */
function placeAxis(
  size: number,
  vpMin: number,
  vpMax: number,
  boardMin: number,
  boardMax: number,
): [number, number] {
  const boardExtent = boardMax - boardMin;
  let centre: number;
  if (boardExtent <= size) {
    centre = (boardMin + boardMax) / 2;
  } else {
    const vpCentre = (vpMin + vpMax) / 2;
    centre = Math.min(Math.max(vpCentre, boardMin + size / 2), boardMax - size / 2);
  }
  return [centre - size / 2, centre + size / 2];
}

/**
 * The canvas region the minimap draws: `LOCAL_FACTOR` times the viewport,
 * shaped to the map's aspect ratio so a uniform scale fills it with no blank
 * bands. The viewport always lies inside it (the board bounds contain the
 * viewport, and the window is at least four viewports wide).
 */
export function computeMinimapWindow(
  aabb: AABB | null,
  vp: MinimapViewportLike,
  mapW: number,
  mapH: number,
): MinimapBounds {
  const board = computeMinimapBounds(aabb, vp);
  const vpW = Math.max(1, vp.right - vp.left);
  const vpH = Math.max(1, vp.bottom - vp.top);
  const aspect = mapW > 0 && mapH > 0 ? mapW / mapH : vpW / vpH;
  const w = LOCAL_FACTOR * Math.max(vpW, vpH * aspect);
  const h = w / aspect;
  const [minX, maxX] = placeAxis(w, vp.left, vp.right, board.minX, board.maxX);
  const [minY, maxY] = placeAxis(h, vp.top, vp.bottom, board.minY, board.maxY);
  return { minX, minY, maxX, maxY, w, h };
}

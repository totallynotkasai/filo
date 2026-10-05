/**
 * Where a new Mind Map tile goes when the user didn't point at a spot (the
 * side toolbar, Ctrl+N, N): the middle of the view, or beside the selected
 * tile. A tile already there would hide the new one, or be hidden by it, and
 * five new tiles would be one pile. So the tile steps clear, to the nearest
 * spot a tile's width (or height) and a gap at a time that overlaps nothing:
 * beside the wanted spot first, then around it, as cards are dealt round a
 * table. A spot inside the view wins over a nearer one outside it, so the new
 * tile is where the user is looking. A tile made from the canvas menu goes
 * where it was asked for.
 */

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

/** A tile's place on the canvas. */
export interface PlacedRect extends Point, Size {}

/** Space kept between a new tile and its neighbours. */
export const NEW_TILE_GAP = 24;
/** How many steps out from the wanted spot the search goes. */
const REACH = 6;

function overlaps(a: PlacedRect, b: PlacedRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(a: PlacedRect, view: PlacedRect): boolean {
  return a.x >= view.x && a.y >= view.y && a.x + a.width <= view.x + view.width && a.y + a.height <= view.y + view.height;
}

/**
 * Grid steps around the wanted spot, nearest first. Among equally near ones
 * the same row comes first, then right before left and down before up.
 */
const STEPS: ReadonlyArray<readonly [number, number]> = (() => {
  const out: Array<[number, number]> = [];
  for (let row = -REACH; row <= REACH; row++) for (let col = -REACH; col <= REACH; col++) out.push([col, row]);
  const rank = ([col, row]: readonly [number, number]): number[] =>
    [col * col + row * row, Math.abs(row), col < 0 ? 1 : 0, row < 0 ? 1 : 0];
  return out.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return 0;
  });
})();

/**
 * The nearest spot to `wanted` (a tile's top-left corner) where a tile of
 * `size`, with `NEW_TILE_GAP` around it, overlaps none of `occupied`;
 * inside `view` (the visible canvas) when one there is free. When every spot
 * in reach is taken it stays at `wanted`.
 */
export function placeClear(wanted: Point, size: Size, occupied: readonly PlacedRect[], view?: PlacedRect): Point {
  const stepX = size.width + NEW_TILE_GAP;
  const stepY = size.height + NEW_TILE_GAP;
  const visible = view && view.width > 0 && view.height > 0 ? view : null;
  let firstFree: Point | null = null;
  for (const [col, row] of STEPS) {
    const spot = { x: wanted.x + col * stepX, y: wanted.y + row * stepY };
    const padded: PlacedRect = {
      x: spot.x - NEW_TILE_GAP / 2,
      y: spot.y - NEW_TILE_GAP / 2,
      width: size.width + NEW_TILE_GAP,
      height: size.height + NEW_TILE_GAP,
    };
    if (occupied.some((r) => overlaps(padded, r))) continue;
    if (!visible || inside({ ...spot, ...size }, visible)) return spot;
    firstFree ??= spot;
  }
  return firstFree ?? wanted;
}

/** The tiles of a board as places, for `placeClear`. */
export function tileRects(tiles: Readonly<Record<string, { position: Point; size: Size }>>): PlacedRect[] {
  return Object.values(tiles).map((t) => ({ x: t.position.x, y: t.position.y, width: t.size.width, height: t.size.height }));
}

/** The visible canvas, as `canvas.viewportRect` gives it, for `placeClear`. */
export function viewRect(vp: { left: number; top: number; width: number; height: number }): PlacedRect {
  return { x: vp.left, y: vp.top, width: vp.width, height: vp.height };
}

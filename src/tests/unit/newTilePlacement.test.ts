import { describe, it, expect } from 'vitest';
import { NEW_TILE_GAP, placeClear, tileRects, viewRect, type PlacedRect } from '@renderer/lib/canvas/newTilePlacement';

const size = { width: 300, height: 200 };
const stepX = size.width + NEW_TILE_GAP;
const stepY = size.height + NEW_TILE_GAP;

function apart(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x + size.width <= b.x || b.x + size.width <= a.x || a.y + size.height <= b.y || b.y + size.height <= a.y;
}

/** Places `n` tiles one after another, each clear of those before it. */
function deal(n: number, view?: PlacedRect): Array<{ x: number; y: number }> {
  const taken: PlacedRect[] = [];
  const placed: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const at = placeClear({ x: 0, y: 0 }, size, taken, view);
    placed.push(at);
    taken.push({ ...at, ...size });
  }
  return placed;
}

describe('placeClear: a new tile steps clear of the tiles already there', () => {
  it('stays where it was wanted on an empty spot', () => {
    expect(placeClear({ x: 100, y: 50 }, size, [])).toEqual({ x: 100, y: 50 });
    // A tile well away doesn't count.
    expect(placeClear({ x: 100, y: 50 }, size, [{ x: 1000, y: 1000, ...size }])).toEqual({ x: 100, y: 50 });
  });

  it('takes the nearest free spot: beside, then the other side, then below and above', () => {
    expect(deal(5)).toEqual([
      { x: 0, y: 0 },
      { x: stepX, y: 0 },
      { x: -stepX, y: 0 },
      { x: 0, y: stepY },
      { x: 0, y: -stepY },
    ]);
  });

  it('never overlaps a tile, for many tiles', () => {
    const placed = deal(30);
    for (let a = 0; a < placed.length; a++) {
      for (let b = a + 1; b < placed.length; b++) expect(apart(placed[a]!, placed[b]!), `${a} and ${b}`).toBe(true);
    }
  });

  it('prefers a free spot inside the view to a nearer one outside it', () => {
    // A view whose left edge is the wanted spot's: the spot to the left is
    // outside it, so the third tile goes below instead.
    const view = viewRect({ left: 0, top: -1000, width: 2 * stepX, height: 2000 });
    expect(deal(3, view)).toEqual([{ x: 0, y: 0 }, { x: stepX, y: 0 }, { x: 0, y: stepY }]);
    // With no room in the view at all, the nearest free spot still wins.
    const tiny = viewRect({ left: 0, top: 0, width: 10, height: 10 });
    expect(placeClear({ x: 0, y: 0 }, size, [{ x: 0, y: 0, ...size }], tiny)).toEqual({ x: stepX, y: 0 });
  });

  it('keeps a gap: a tile touching the spot moves the new one on', () => {
    expect(placeClear({ x: 0, y: 0 }, size, [{ x: 310, y: 0, width: 50, height: 50 }])).not.toEqual({ x: 0, y: 0 });
  });

  it("reads a board's tiles as places", () => {
    expect(tileRects({ a: { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } } })).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
  });
});

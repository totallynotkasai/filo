import { describe, it, expect } from 'vitest';
import {
  computeTilesAABB,
  computeMinimapBounds,
  computeMinimapWindow,
  isFiniteTile,
  LOCAL_FACTOR,
  type MinimapTileLike,
  type MinimapViewportLike,
} from '@renderer/lib/canvas/minimapBounds';

/**
 * The minimap's all-tiles AABB is split out of the viewport-keyed
 * `bounds` derived so a pure pan doesn't re-walk every tile. These tests pin the
 * pure math; the "no recompute on pan" property is structural in Minimap.svelte
 * (tilesAABB is `$derived(computeTilesAABB(tiles))` — it never reads viewportRect).
 */

const tile = (x: number, y: number, w: number, h: number): MinimapTileLike => ({
  position: { x, y },
  size: { width: w, height: h },
});

describe('computeTilesAABB', () => {
  it('returns null for an empty board', () => {
    expect(computeTilesAABB([])).toBeNull();
  });

  it('encloses every tile', () => {
    const aabb = computeTilesAABB([
      tile(100, 100, 50, 50), // 100..150
      tile(-20, 30, 40, 40), // -20..20 × 30..70
      tile(300, 200, 100, 80), // 300..400 × 200..280
    ]);
    expect(aabb).toEqual({ minX: -20, minY: 30, maxX: 400, maxY: 280 });
  });

  it('does not depend on the viewport (a pan cannot change it)', () => {
    const tiles = [tile(0, 0, 100, 100), tile(500, 500, 100, 100)];
    // Same tiles → identical AABB regardless of where the camera is.
    expect(computeTilesAABB(tiles)).toEqual(computeTilesAABB(tiles));
  });
});

describe('computeMinimapBounds', () => {
  const vp: MinimapViewportLike = { left: 0, top: 0, right: 800, bottom: 600 };

  it('unions tiles AABB with the viewport, then pads 10% + 100px', () => {
    // Tiles extend past the viewport on the right/bottom.
    const aabb = { minX: 200, minY: 150, maxX: 1200, maxY: 1000 };
    const b = computeMinimapBounds(aabb, vp);
    // Union: minX=0, minY=0, maxX=1200, maxY=1000.
    // rangeX=1200 → padX=120+100=220; rangeY=1000 → padY=100+100=200.
    expect(b.minX).toBe(-220);
    expect(b.minY).toBe(-200);
    expect(b.maxX).toBe(1420);
    expect(b.maxY).toBe(1200);
    expect(b.w).toBe(b.maxX - b.minX);
    expect(b.h).toBe(b.maxY - b.minY);
  });

  it('falls back to the viewport alone when there are no tiles', () => {
    const b = computeMinimapBounds(null, vp);
    // rangeX=800 → padX=80+100=180; rangeY=600 → padY=60+100=160.
    expect(b.minX).toBe(-180);
    expect(b.maxX).toBe(980);
    expect(b.minY).toBe(-160);
    expect(b.maxY).toBe(760);
  });

  it('matches the pre-split single-derived result (regression)', () => {
    // Reference implementation = the original inline bounds math.
    const tiles = [tile(50, 50, 100, 100), tile(900, 700, 100, 100)];
    const reference = (() => {
      let minX = vp.left, minY = vp.top, maxX = vp.right, maxY = vp.bottom;
      for (const t of tiles) {
        minX = Math.min(minX, t.position.x);
        minY = Math.min(minY, t.position.y);
        maxX = Math.max(maxX, t.position.x + t.size.width);
        maxY = Math.max(maxY, t.position.y + t.size.height);
      }
      const rangeX = maxX - minX || 1000;
      const rangeY = maxY - minY || 1000;
      const padX = rangeX * 0.1 + 100;
      const padY = rangeY * 0.1 + 100;
      minX -= padX; minY -= padY; maxX += padX; maxY += padY;
      return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
    })();

    expect(computeMinimapBounds(computeTilesAABB(tiles), vp)).toEqual(reference);
  });
});

describe('computeTilesAABB with non-finite tiles', () => {
  it('skips a tile with a NaN or Infinity position or size', () => {
    const aabb = computeTilesAABB([
      tile(0, 0, 100, 100),
      tile(NaN, 50, 10, 10),
      tile(50, Infinity, 10, 10),
      tile(20, 20, -Infinity, 10),
    ]);
    expect(aabb).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(isFiniteTile(tile(NaN, 0, 1, 1))).toBe(false);
  });

  it('returns null when every tile is non-finite', () => {
    expect(computeTilesAABB([tile(NaN, NaN, 10, 10)])).toBeNull();
  });
});

describe('computeMinimapWindow', () => {
  // A 1600x900 viewport at scale 1, looking at canvas 0..1600 × 0..900.
  const MAP_W = 320;
  const MAP_H = 180;
  const viewport = (left: number, top: number, w: number, h: number): MinimapViewportLike => ({
    left, top, right: left + w, bottom: top + h,
  });
  const bigBoard = { minX: -50_000, minY: -50_000, maxX: 50_000, maxY: 50_000 };

  it('is LOCAL_FACTOR viewports wide, shaped to the map', () => {
    const w = computeMinimapWindow(bigBoard, viewport(0, 0, 1600, 900), MAP_W, MAP_H);
    expect(w.w).toBe(LOCAL_FACTOR * 1600);
    expect(w.w / w.h).toBeCloseTo(MAP_W / MAP_H);
  });

  it('is centred on the viewport inside a big board and follows a pan', () => {
    const a = computeMinimapWindow(bigBoard, viewport(0, 0, 1600, 900), MAP_W, MAP_H);
    expect((a.minX + a.maxX) / 2).toBe(800);
    expect((a.minY + a.maxY) / 2).toBe(450);
    const b = computeMinimapWindow(bigBoard, viewport(5000, -2000, 1600, 900), MAP_W, MAP_H);
    expect((b.minX + b.maxX) / 2).toBe(5800);
    expect((b.minY + b.maxY) / 2).toBe(-1550);
    expect(b.w).toBe(a.w);
  });

  it('scales with zoom: zooming out widens it, zooming in narrows it', () => {
    const at1 = computeMinimapWindow(bigBoard, viewport(0, 0, 1600, 900), MAP_W, MAP_H);
    const zoomedOut = computeMinimapWindow(bigBoard, viewport(-800, -450, 3200, 1800), MAP_W, MAP_H);
    const zoomedIn = computeMinimapWindow(bigBoard, viewport(400, 225, 800, 450), MAP_W, MAP_H);
    expect(zoomedOut.w).toBe(at1.w * 2);
    expect(zoomedIn.w).toBe(at1.w / 2);
    // The viewport box is the same size on the map at every zoom.
    for (const [win, vpW] of [[at1, 1600], [zoomedOut, 3200], [zoomedIn, 800]] as const) {
      expect((vpW * MAP_W) / win.w).toBeCloseTo(MAP_W / LOCAL_FACTOR);
    }
  });

  it('a far-away tile does not change the scale or the window', () => {
    const vp = viewport(0, 0, 1600, 900);
    const near = computeTilesAABB([tile(-20_000, -20_000, 200, 200), tile(20_000, 20_000, 200, 200)]);
    const far = computeTilesAABB([
      tile(-20_000, -20_000, 200, 200), tile(20_000, 20_000, 200, 200), tile(1_000_000, 1_000_000, 200, 200),
    ]);
    const a = computeMinimapWindow(near, vp, MAP_W, MAP_H);
    const b = computeMinimapWindow(far, vp, MAP_W, MAP_H);
    expect(b.w).toBe(a.w);
    expect(b.h).toBe(a.h);
    expect(b.minX).toBe(a.minX);
    expect(b.minY).toBe(a.minY);
  });

  it('shows a small board whole', () => {
    const tiles = computeTilesAABB([tile(1700, 0, 300, 200), tile(-400, 700, 200, 200)])!;
    const w = computeMinimapWindow(tiles, viewport(0, 0, 1600, 900), MAP_W, MAP_H);
    expect(w.minX).toBeLessThanOrEqual(tiles.minX);
    expect(w.maxX).toBeGreaterThanOrEqual(tiles.maxX);
    expect(w.minY).toBeLessThanOrEqual(tiles.minY);
    expect(w.maxY).toBeGreaterThanOrEqual(tiles.maxY);
  });

  it('stays inside the board near its edge and always contains the viewport', () => {
    const board = { minX: 0, minY: 0, maxX: 20_000, maxY: 20_000 };
    for (const vp of [viewport(0, 0, 1600, 900), viewport(18_400, 19_100, 1600, 900), viewport(9000, 100, 1600, 900)]) {
      const w = computeMinimapWindow(board, vp, MAP_W, MAP_H);
      const padded = computeMinimapBounds(board, vp);
      expect(w.minX).toBeGreaterThanOrEqual(padded.minX);
      expect(w.maxX).toBeLessThanOrEqual(padded.maxX);
      expect(w.minX).toBeLessThanOrEqual(vp.left);
      expect(w.maxX).toBeGreaterThanOrEqual(vp.right);
      expect(w.minY).toBeLessThanOrEqual(vp.top);
      expect(w.maxY).toBeGreaterThanOrEqual(vp.bottom);
    }
  });

  it('does not jump when the board crosses the window size', () => {
    // Board exactly the window's width: centring on the board and clamping
    // to it give the same window.
    const vp = viewport(0, 0, 1600, 900);
    const winW = LOCAL_FACTOR * 1600;
    const unpadded = (r: number): number => (r - 200) / 1.2; // inverse of 10% + 100px each side
    const range = unpadded(winW);
    const justUnder = computeMinimapWindow({ minX: 0, minY: 0, maxX: range - 1, maxY: 900 }, vp, MAP_W, MAP_H);
    const justOver = computeMinimapWindow({ minX: 0, minY: 0, maxX: range + 1, maxY: 900 }, vp, MAP_W, MAP_H);
    expect(Math.abs(justOver.minX - justUnder.minX)).toBeLessThan(2);
  });
});

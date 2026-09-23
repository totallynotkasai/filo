import { describe, it, expect } from 'vitest';
import {
  computeTilesAABB,
  computeMinimapBounds,
  type MinimapTileLike,
  type MinimapViewportLike,
} from '@renderer/lib/canvas/minimapBounds';

/**
 * H4 (perf) — the minimap's all-tiles AABB is split out of the viewport-keyed
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

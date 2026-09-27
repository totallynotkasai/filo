import { describe, it, expect } from 'vitest';
import { computePath } from '@renderer/lib/connections/pathRouter';
import { SpatialIndex } from '@renderer/lib/spatialIndex';

/**
 * Audit 5.6 — claim: `computeSmartPath` includes the connection's own
 * source/target tiles in the A* obstacle set, so the first/last segments graze
 * their own tiles, A* exhausts MAX_ITER, and the path falls back to a curve,
 * defeating obstacle avoidance.
 *
 * These tests probe whether routing is actually defeated by the source/target
 * being obstacles. A `' C '` in the `d` string is the curved fallback; a
 * `' L '` polyline means A* succeeded.
 */

const isCurveFallback = (d: string): boolean => d.includes(' C ');
const isPolyline = (d: string): boolean => d.includes(' L ');

describe('smart path routing with source/target in the obstacle set (audit 5.6)', () => {
  it('routes a clear direct path as a polyline (not a curve) with both tiles present', () => {
    const idx = new SpatialIndex();
    idx.insert('A', 0, 0, 100, 100); // source [0..100]
    idx.insert('B', 400, 0, 100, 100); // target [400..500]
    const from = { x: 100, y: 50 }; // A right-edge bubble
    const to = { x: 400, y: 50 }; // B left-edge bubble
    const d = computePath(from, to, 3, 7, 'smart', idx);
    expect(isPolyline(d)).toBe(true);
    expect(isCurveFallback(d)).toBe(false);
  });

  it('routes AROUND a middle obstacle even though source+target are obstacles', () => {
    const idx = new SpatialIndex();
    idx.insert('A', 0, 0, 100, 100); // source [0..100]
    idx.insert('B', 400, 0, 100, 100); // target [400..500]
    idx.insert('M', 200, -20, 100, 140); // blocks the straight y=50 line
    const from = { x: 100, y: 50 };
    const to = { x: 400, y: 50 };
    const d = computePath(from, to, 3, 7, 'smart', idx);
    // A* found a routed polyline despite A and B being in the obstacle set —
    // obstacle avoidance is not defeated.
    expect(isPolyline(d)).toBe(true);
    expect(isCurveFallback(d)).toBe(false);
  });
});

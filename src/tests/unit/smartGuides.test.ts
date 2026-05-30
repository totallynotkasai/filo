import { describe, it, expect } from 'vitest';
import {
  computeGuides,
  capCandidatesByDistance,
  type TileBounds,
} from '@renderer/lib/canvas/smartGuides';

function bounds(id: string, x: number, y: number, w = 100, h = 80): TileBounds {
  return { id, x, y, width: w, height: h };
}

describe('computeGuides', () => {
  it('returns empty guides and no snap when no tiles are aligned', () => {
    const dragged = bounds('d', 0, 0);
    const others = [bounds('a', 500, 500)];
    const result = computeGuides(dragged, others);
    expect(result.guides).toEqual([]);
    expect(result.snapX).toBeNull();
    expect(result.snapY).toBeNull();
  });

  it('snaps left edge to left edge when within threshold', () => {
    const dragged = bounds('d', 3, 200); // left edge at x=3
    const others = [bounds('a', 0, 500)]; // left edge at x=0
    const result = computeGuides(dragged, others, 8);
    expect(result.snapX).toBe(0);
    expect(result.guides.some((g) => g.type === 'vertical' && g.position === 0)).toBe(true);
  });

  it('snaps centre-to-centre on both axes', () => {
    const dragged = bounds('d', 100 + 3, 100 + 3); // centre near (153, 143)
    const others = [bounds('a', 100, 100)]; // centre at (150, 140)
    const result = computeGuides(dragged, others, 8);
    expect(result.snapX).toBe(100); // so dragged centre becomes 150
    expect(result.snapY).toBe(100); // so dragged centre becomes 140
  });

  it('snaps right-edge to right-edge', () => {
    // dragged right = 100 + 104 = 204, other right = 100 + 200 = 300 — delta 96, outside.
    // Shift dragged right to within threshold of 300: x = 300 - 100 - 3 = 197.
    const dragged = bounds('d', 197, 0);
    const others = [bounds('a', 100, 0, 200, 80)];
    const result = computeGuides(dragged, others, 8);
    // dragged should snap so its right edge aligns to 300, i.e. x = 200.
    expect(result.snapX).toBe(200);
  });

  it('ignores the dragged tile in the other-tiles list', () => {
    const dragged = bounds('d', 0, 0);
    const others = [bounds('d', 0, 0)]; // same id as dragged
    const result = computeGuides(dragged, others, 8);
    expect(result.guides).toEqual([]);
    expect(result.snapX).toBeNull();
    expect(result.snapY).toBeNull();
  });

  it('respects a smaller threshold', () => {
    const dragged = bounds('d', 5, 0); // 5px from x=0
    const others = [bounds('a', 0, 0)];
    // Threshold 3 — 5px is outside.
    const tight = computeGuides(dragged, others, 3);
    expect(tight.snapX).toBeNull();
    // Threshold 8 — 5px is inside.
    const loose = computeGuides(dragged, others, 8);
    expect(loose.snapX).toBe(0);
  });

  it('zoom-aware threshold: 8 / scale grows the snap range at low zoom', () => {
    // Simulates the call-site scaling in tileDrag.ts. At scale=0.25, threshold
    // becomes 32 in canvas units, so a 20-unit delta should snap.
    const dragged = bounds('d', 20, 0);
    const others = [bounds('a', 0, 0)];
    const scale = 0.25;
    const result = computeGuides(dragged, others, 8 / scale);
    expect(result.snapX).toBe(0);
  });
});

describe('smart guides: Alt-key disables guides in tileDrag', () => {
  // The Alt toggle is implemented in tileDrag (it skips computeGuides when
  // e.altKey is true). This test documents that contract: computeGuides itself
  // always produces guides — tileDrag is the layer that suppresses them.
  it('computeGuides itself does not consult any Alt flag', () => {
    const dragged = bounds('d', 3, 0);
    const others = [bounds('a', 0, 0)];
    const result = computeGuides(dragged, others, 8);
    expect(result.snapX).toBe(0);
  });
});

describe('capCandidatesByDistance — Sprint B / B7', () => {
  it('is a no-op when the input is already at or below the cap', () => {
    const dragged = bounds('d', 0, 0);
    const tiles = [bounds('a', 10, 10), bounds('b', 20, 20)];
    const snapshot = tiles.slice();
    capCandidatesByDistance(dragged, tiles, 100);
    expect(tiles).toEqual(snapshot);
  });

  it('truncates to the N closest tiles by L∞ centre distance', () => {
    const dragged = bounds('d', 0, 0); // centre (50, 40)
    // Far-away tile first so we can verify sorting moved it past the cut.
    const tiles: TileBounds[] = [
      bounds('far', 10000, 0),
      bounds('near-1', 60, 50), // centre (110, 90) — L∞ = max(60, 50) = 60
      bounds('near-2', 100, 0), // centre (150, 40) — L∞ = max(100, 0) = 100
      bounds('near-3', 0, 200), // centre (50, 240) — L∞ = max(0, 200) = 200
    ];
    capCandidatesByDistance(dragged, tiles, 2);
    expect(tiles.length).toBe(2);
    const ids = tiles.map((t) => t.id);
    expect(ids).toContain('near-1');
    expect(ids).toContain('near-2');
    expect(ids).not.toContain('far');
    expect(ids).not.toContain('near-3');
  });

  it('keeps O(n log n) sort + slice on a 1000-tile board cheap enough for a frame', () => {
    // Not a true perf test — the production budget is 16ms, but jsdom + Vitest
    // adds overhead. We just verify the cap fires (length truncated to 100)
    // and the result is the 100 closest tiles, with a soft wall-clock ceiling
    // to catch a regression that turns the sort into O(n²).
    const dragged = bounds('d', 0, 0);
    const tiles: TileBounds[] = [];
    for (let i = 0; i < 1000; i++) {
      tiles.push(bounds(`t${i}`, i * 5, i * 5));
    }
    const t0 = performance.now();
    capCandidatesByDistance(dragged, tiles, 100);
    const elapsed = performance.now() - t0;
    expect(tiles.length).toBe(100);
    // First 100 tiles by centre distance are t0..t99 (linearly increasing
    // distance from the origin).
    expect(tiles[0].id).toBe('t0');
    expect(tiles[99].id).toBe('t99');
    // Generous ceiling for a sort + slice over 1000 entries — flags an
    // accidental O(n²) regression while tolerating CI noise.
    expect(elapsed).toBeLessThan(50);
  });
});

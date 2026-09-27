import { describe, it, expect } from 'vitest';
import { computePath, computeArrowHead } from '@renderer/lib/connections/pathRouter';
import { SpatialIndex } from '@renderer/lib/spatialIndex';

describe('pathCalc', () => {
  const from = { x: 100, y: 100 };
  const to = { x: 400, y: 300 };

  describe('computePath', () => {
    it('computes a straight path', () => {
      const d = computePath(from, to, 2, 6, 'straight');
      expect(d).toBe('M 100 100 L 400 300');
    });

    it('computes a curved path', () => {
      const d = computePath(from, to, 2, 6, 'curved');
      expect(d).toMatch(/^M 100 100 C /);
      expect(d).toMatch(/400 300$/);
    });

    it('computes an elbow path', () => {
      const d = computePath(from, to, 2, 6, 'elbow');
      expect(d).toContain('M 100 100');
      expect(d).toContain('L');
      expect(d).toContain('400 300');
    });

    it('computes a smart path (falls back to curved without spatial index)', () => {
      const d = computePath(from, to, 2, 6, 'smart');
      // Without spatial index, falls back to curved
      expect(d).toMatch(/^M 100 100 C /);
    });

    it('handles same-point paths', () => {
      const p = { x: 200, y: 200 };
      const d = computePath(p, p, 0, 0, 'straight');
      expect(d).toBe('M 200 200 L 200 200');
    });
  });

  describe('smart routing obstacle avoidance', () => {
    // Parses the `d` attribute into an ordered list of points for inspection.
    // Supports only M / L / C segments produced by pathRouter; returns the
    // anchor points (not bezier control points).
    function pathAnchors(d: string): Array<{ x: number; y: number }> {
      const pts: Array<{ x: number; y: number }> = [];
      const tokens = d.trim().split(/\s+/);
      let i = 0;
      while (i < tokens.length) {
        const cmd = tokens[i];
        if (cmd === 'M' || cmd === 'L') {
          pts.push({ x: parseFloat(tokens[i + 1]), y: parseFloat(tokens[i + 2]) });
          i += 3;
        } else if (cmd === 'C') {
          // skip the two control points, keep the end anchor
          pts.push({ x: parseFloat(tokens[i + 5]), y: parseFloat(tokens[i + 6]) });
          i += 7;
        } else {
          i += 1;
        }
      }
      return pts;
    }

    // Returns true if the straight segment a→b passes through the rect.
    function segmentHitsRect(
      a: { x: number; y: number },
      b: { x: number; y: number },
      rect: { minX: number; minY: number; maxX: number; maxY: number },
    ): boolean {
      // Liang-Barsky clip against the rect.
      let t0 = 0;
      let t1 = 1;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const ps = [-dx, dx, -dy, dy];
      const qs = [a.x - rect.minX, rect.maxX - a.x, a.y - rect.minY, rect.maxY - a.y];
      for (let k = 0; k < 4; k++) {
        const p = ps[k];
        const q = qs[k];
        if (p === 0) {
          if (q < 0) return false;
        } else {
          const r = q / p;
          if (p < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
          } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
          }
        }
      }
      return t0 < t1;
    }

    it('routes around a single obstacle lying on the straight-line path', () => {
      const index = new SpatialIndex();
      // One obstacle right on the middle of the A→B line.
      index.insert('blocker', 180, 180, 140, 140); // 180..320 × 180..320

      const from = { x: 100, y: 100 };
      const to = { x: 400, y: 400 };
      const d = computePath(from, to, 4, 0, 'smart', index);

      // Smart routing should have produced a polyline (not a bezier curve).
      expect(d.startsWith('M 100 100')).toBe(true);
      expect(d).toContain(' L ');
      expect(d).not.toMatch(/ C /);

      // None of the path segments should cross the blocker rect.
      const pts = pathAnchors(d);
      const blocker = { minX: 180, minY: 180, maxX: 320, maxY: 320 };
      for (let i = 0; i < pts.length - 1; i++) {
        expect(segmentHitsRect(pts[i], pts[i + 1], blocker)).toBe(false);
      }
    });

    it('routes around a 3x3 grid with the centre tile blocking the diagonal', () => {
      const index = new SpatialIndex();
      // 3x3 grid of 100x80 tiles, spaced 200px apart (centre at (100, 100), (300, 100), ...).
      const W = 100;
      const H = 80;
      const originX = 50;
      const originY = 50;
      const stride = 200;
      for (let gx = 0; gx < 3; gx++) {
        for (let gy = 0; gy < 3; gy++) {
          const x = originX + gx * stride;
          const y = originY + gy * stride;
          index.insert(`t_${gx}_${gy}`, x, y, W, H);
        }
      }

      // Start just outside top-left tile, end just outside bottom-right tile.
      // Straight line passes through the centre tile at (250, 250)..(350, 330).
      const from = { x: 40, y: 40 };
      const to = { x: 560, y: 520 };
      // Bubbles face away from the tiles they sit beside, so the stubs stay
      // clear of them.
      const d = computePath(from, to, 0, 4, 'smart', index);

      expect(d.startsWith(`M ${from.x} ${from.y}`)).toBe(true);
      expect(d).toContain(' L ');
      expect(d).not.toMatch(/ C /);

      const pts = pathAnchors(d);
      const centre = { minX: 250, minY: 250, maxX: 350, maxY: 330 };
      for (let i = 0; i < pts.length - 1; i++) {
        expect(segmentHitsRect(pts[i], pts[i + 1], centre)).toBe(false);
      }
    });

    it('still falls back to curved when no obstacles are near the path', () => {
      const index = new SpatialIndex();
      // Obstacle far off to the side — must not trigger A*.
      index.insert('far-away', 5000, 5000, 100, 80);

      const d = computePath({ x: 0, y: 0 }, { x: 300, y: 300 }, 4, 0, 'smart', index);
      expect(d).toMatch(/^M 0 0 C /);
    });

    // The arrowhead is angled off the last segment, so the route must leave
    // and arrive along the bubble's normal, never along the tile's edge.
    describe('leaves and arrives along the bubble normal', () => {
      // A [0..100]² on the left, B [400..500]×[0..100] on the right, and a
      // wall between them so A* actually routes.
      function boardWithWall(): SpatialIndex {
        const index = new SpatialIndex();
        index.insert('A', 0, 0, 100, 100);
        index.insert('B', 400, 0, 100, 100);
        index.insert('wall', 200, -20, 100, 140);
        return index;
      }

      // Asserts a→b points the same way as (nx, ny): parallel and not reversed.
      function expectAlong(
        a: { x: number; y: number },
        b: { x: number; y: number },
        normal: { nx: number; ny: number },
      ): void {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        expect(dx * normal.ny - dy * normal.nx).toBe(0);
        expect(dx * normal.nx + dy * normal.ny).toBeGreaterThan(0);
      }

      function firstAndLastSegments(d: string): {
        first: [{ x: number; y: number }, { x: number; y: number }];
        last: [{ x: number; y: number }, { x: number; y: number }];
      } {
        expect(d).not.toMatch(/ C /);
        const pts = pathAnchors(d);
        expect(pts.length).toBeGreaterThanOrEqual(3);
        return {
          first: [pts[0], pts[1]],
          last: [pts[pts.length - 2], pts[pts.length - 1]],
        };
      }

      it('side bubbles: out of the right edge, into the left edge', () => {
        const d = computePath({ x: 100, y: 50 }, { x: 400, y: 50 }, 3, 7, 'smart', boardWithWall());
        const { first, last } = firstAndLastSegments(d);
        expectAlong(first[0], first[1], { nx: 1, ny: 0 });
        expectAlong(last[0], last[1], { nx: 1, ny: 0 });
        expect(last[1]).toEqual({ x: 400, y: 50 });
      });

      it('arrives straight down into a top bubble, not sliding along the top edge', () => {
        const d = computePath({ x: 100, y: 50 }, { x: 450, y: 0 }, 3, 1, 'smart', boardWithWall());
        const { last } = firstAndLastSegments(d);
        expectAlong(last[0], last[1], { nx: 0, ny: 1 });
        expect(last[1]).toEqual({ x: 450, y: 0 });
      });

      it('corner bubbles: leaves and arrives diagonally', () => {
        const d = computePath({ x: 100, y: 100 }, { x: 400, y: 0 }, 4, 0, 'smart', boardWithWall());
        const { first, last } = firstAndLastSegments(d);
        expectAlong(first[0], first[1], { nx: 1, ny: 1 });
        expectAlong(last[0], last[1], { nx: 1, ny: 1 });
        expect(last[1]).toEqual({ x: 400, y: 0 });
      });

      it('never runs along the target tile edge', () => {
        const d = computePath({ x: 100, y: 50 }, { x: 450, y: 0 }, 3, 1, 'smart', boardWithWall());
        const pts = pathAnchors(d);
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const onTopEdge = a.y === 0 && b.y === 0 && Math.max(a.x, b.x) > 400 && Math.min(a.x, b.x) < 500;
          expect(onTopEdge).toBe(false);
        }
      });
    });
  });

  describe('computeArrowHead', () => {
    it('computes arrow head points', () => {
      const arrow = computeArrowHead({ x: 400, y: 300 }, 0, 10);
      expect(arrow).toMatch(/^M .+ L 400 300 L .+$/);
    });

    it('computes arrow at different angles', () => {
      const arrow90 = computeArrowHead({ x: 0, y: 0 }, 90, 10);
      expect(arrow90).toContain('L 0 0');

      const arrow180 = computeArrowHead({ x: 0, y: 0 }, 180, 10);
      expect(arrow180).toContain('L 0 0');
    });
  });
});

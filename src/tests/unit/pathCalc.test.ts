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
      const d = computePath(from, to, 4, 0, 'smart', index);

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

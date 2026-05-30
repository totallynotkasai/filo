import { describe, it, expect } from 'vitest';
import { screenToCanvas } from '@renderer/lib/canvas/coordinates';

describe('Coordinate Transforms', () => {
  const identity = { x: 0, y: 0, scale: 1 };

  describe('screenToCanvas', () => {
    it('returns same coords with identity transform', () => {
      const result = screenToCanvas(100, 200, identity);
      expect(result.x).toBe(100);
      expect(result.y).toBe(200);
    });

    it('accounts for pan offset', () => {
      const transform = { x: 50, y: -30, scale: 1 };
      const result = screenToCanvas(150, 170, transform);
      expect(result.x).toBe(100);
      expect(result.y).toBe(200);
    });

    it('accounts for zoom scale', () => {
      const transform = { x: 0, y: 0, scale: 2 };
      const result = screenToCanvas(200, 400, transform);
      expect(result.x).toBe(100);
      expect(result.y).toBe(200);
    });

    it('accounts for combined pan and zoom', () => {
      const transform = { x: 100, y: 100, scale: 2 };
      const result = screenToCanvas(300, 500, transform);
      expect(result.x).toBe(100);
      expect(result.y).toBe(200);
    });
  });
});

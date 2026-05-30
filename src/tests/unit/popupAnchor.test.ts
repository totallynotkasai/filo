import { describe, it, expect } from 'vitest';
import { clampToViewport } from '@renderer/lib/utils/popupAnchor';

describe('clampToViewport (L4b — context-menu viewport clamp)', () => {
  const VW = 1000;
  const VH = 800;

  it('leaves a box that already fits untouched', () => {
    expect(clampToViewport(100, 100, 200, 300, VW, VH)).toEqual({ x: 100, y: 100 });
  });

  it('pulls a box back from the right edge (keeps the default 8px margin)', () => {
    // x=900 + width 200 = 1100 > 1000 → max x = 1000 - 200 - 8 = 792
    expect(clampToViewport(900, 100, 200, 300, VW, VH).x).toBe(792);
  });

  it('pulls a box up from the bottom edge using the real height', () => {
    // The whole point of L4b: a tall menu near the bottom must shift up.
    // y=700 + height 300 = 1000 > 800 → max y = 800 - 300 - 8 = 492
    expect(clampToViewport(100, 700, 200, 300, VW, VH).y).toBe(492);
  });

  it('floors negative coordinates at the margin', () => {
    expect(clampToViewport(-50, -50, 200, 300, VW, VH)).toEqual({ x: 8, y: 8 });
  });

  it('pins to the margin when the box is larger than the viewport', () => {
    expect(clampToViewport(500, 500, 2000, 2000, VW, VH)).toEqual({ x: 8, y: 8 });
  });

  it('respects a custom margin', () => {
    // x=990 + width 100 = 1090 > 1000 → max x = 1000 - 100 - 20 = 880
    expect(clampToViewport(990, 0, 100, 100, VW, VH, { margin: 20 })).toEqual({ x: 880, y: 20 });
  });
});

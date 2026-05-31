import { describe, it, expect } from 'vitest';
import { connectionIntersectsViewport } from '../../renderer/lib/connections/connectionCulling';

const VP = { left: 0, top: 0, right: 1000, bottom: 800 };
const BUFFER = 200;
const rect = (x: number, y: number) => ({ x, y, width: 100, height: 60 });

describe('connectionIntersectsViewport (3.3)', () => {
  it('keeps a connection with both endpoints inside the viewport', () => {
    expect(connectionIntersectsViewport(rect(100, 100), rect(500, 400), VP, BUFFER)).toBe(true);
  });

  it('culls a connection whose endpoints are both far off-screen on one side', () => {
    expect(connectionIntersectsViewport(rect(-2000, 100), rect(-1500, 200), VP, BUFFER)).toBe(false);
    expect(connectionIntersectsViewport(rect(100, 2000), rect(300, 2500), VP, BUFFER)).toBe(false);
  });

  it('keeps a long connection that crosses the viewport with both endpoints off-screen', () => {
    // Far-left to far-right: the spanning AABB covers the viewport, so the
    // segment is potentially visible — culling it would drop a visible path.
    expect(connectionIntersectsViewport(rect(-3000, 400), rect(3000, 400), VP, BUFFER)).toBe(true);
  });

  it('keeps a connection whose endpoint sits within the buffer band', () => {
    // Off the right edge (1000) but inside the 200px buffer.
    expect(connectionIntersectsViewport(rect(1100, 400), rect(1150, 450), VP, BUFFER)).toBe(true);
  });

  it('culls a connection just beyond the buffer band', () => {
    // Both tiles start past right(1000) + buffer(200) = 1200.
    expect(connectionIntersectsViewport(rect(1201, 400), rect(1300, 450), VP, BUFFER)).toBe(false);
  });

  it('returns false when either endpoint rect is missing (stale connection)', () => {
    expect(connectionIntersectsViewport(null, rect(100, 100), VP, BUFFER)).toBe(false);
    expect(connectionIntersectsViewport(rect(100, 100), undefined, VP, BUFFER)).toBe(false);
  });
});

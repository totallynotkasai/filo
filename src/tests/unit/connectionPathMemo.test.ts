import { describe, it, expect } from 'vitest';
import {
  createConnectionPathMemo,
  connectionPathSignature,
  type RectLike,
} from '@renderer/lib/connections/connectionPathMemo';

/**
 * H4 (perf) — the connection-path memo is the regression pin for "a pure pan
 * does not recompute connection paths." `ConnectionLayer.renderableConnections`
 * re-derives on every pan frame (it reads `viewportRect` to cull), but a pure
 * pan moves no tile, so the per-connection signature is unchanged and the memo
 * returns the cached `d` without calling `computePath` / A* again.
 *
 * These tests exercise the pure memo + signature directly with a counting
 * `compute` thunk standing in for `computePath`, so the call-count assertion is
 * robust and doesn't depend on mounting the component or spying on the router.
 */

const fr: RectLike = { x: 0, y: 0, width: 100, height: 60 };
const tr: RectLike = { x: 400, y: 200, width: 100, height: 60 };

describe('connectionPathSignature', () => {
  it('is stable across a pure pan (no geometry change → same signature)', () => {
    // A pan changes only the viewport transform, never the endpoint rects /
    // bubbles / pathType, so the signature the layer builds is byte-identical.
    const a = connectionPathSignature(fr, tr, 1, 3, 'curved', 0);
    const b = connectionPathSignature(fr, tr, 1, 3, 'curved', 0);
    expect(a).toBe(b);
  });

  it('changes when an endpoint moves', () => {
    const before = connectionPathSignature(fr, tr, 1, 3, 'curved', 0);
    const after = connectionPathSignature({ ...fr, x: 25 }, tr, 1, 3, 'curved', 0);
    expect(after).not.toBe(before);
  });

  it('changes when a bubble or path type changes', () => {
    const base = connectionPathSignature(fr, tr, 1, 3, 'curved', 0);
    expect(connectionPathSignature(fr, tr, 2, 3, 'curved', 0)).not.toBe(base);
    expect(connectionPathSignature(fr, tr, 1, 3, 'elbow', 0)).not.toBe(base);
  });

  it('folds the spatial revision into smart-path signatures only', () => {
    // A moved obstacle bumps the spatial revision; a smart path must re-route,
    // so its signature changes. Non-smart paths ignore the revision (an
    // unrelated tile move must not bust their cache).
    expect(connectionPathSignature(fr, tr, 1, 3, 'smart', 1)).not.toBe(
      connectionPathSignature(fr, tr, 1, 3, 'smart', 2),
    );
    expect(connectionPathSignature(fr, tr, 1, 3, 'curved', 1)).toBe(
      connectionPathSignature(fr, tr, 1, 3, 'curved', 2),
    );
  });
});

describe('createConnectionPathMemo', () => {
  it('does NOT recompute when the signature is unchanged (the pan case)', () => {
    const memo = createConnectionPathMemo();
    let calls = 0;
    const compute = () => {
      calls++;
      return `d${calls}`;
    };
    const sig = connectionPathSignature(fr, tr, 1, 3, 'smart', 0);

    const first = memo.resolve('c1', sig, compute);
    // Simulate many pan frames: same connection, same signature.
    for (let i = 0; i < 10; i++) memo.resolve('c1', sig, compute);

    expect(calls).toBe(1);
    expect(memo.resolve('c1', sig, compute)).toBe(first);
  });

  it('recomputes when the signature changes (endpoint moved)', () => {
    const memo = createConnectionPathMemo();
    let calls = 0;
    const compute = () => `d${++calls}`;

    memo.resolve('c1', connectionPathSignature(fr, tr, 1, 3, 'curved', 0), compute);
    memo.resolve('c1', connectionPathSignature({ ...fr, x: 50 }, tr, 1, 3, 'curved', 0), compute);

    expect(calls).toBe(2);
  });

  it('caches per connection id independently', () => {
    const memo = createConnectionPathMemo();
    let calls = 0;
    const compute = () => `d${++calls}`;
    const sig = connectionPathSignature(fr, tr, 1, 3, 'curved', 0);

    memo.resolve('c1', sig, compute);
    memo.resolve('c2', sig, compute); // different id → its own entry
    memo.resolve('c1', sig, compute); // cached
    memo.resolve('c2', sig, compute); // cached

    expect(calls).toBe(2);
    expect(memo.size).toBe(2);
  });

  it('pruneExcept drops entries for connections no longer present', () => {
    const memo = createConnectionPathMemo();
    const sig = connectionPathSignature(fr, tr, 1, 3, 'curved', 0);
    memo.resolve('c1', sig, () => 'd1');
    memo.resolve('c2', sig, () => 'd2');
    memo.resolve('c3', sig, () => 'd3');
    expect(memo.size).toBe(3);

    // c2 was deleted; c1 and c3 remain (the live connections record).
    memo.pruneExcept({ c1: {}, c3: {} });
    expect(memo.size).toBe(2);

    // A culled-but-still-present connection keeps its cache entry: re-resolving
    // c1 after the prune is still a hit (no recompute).
    let recomputed = false;
    memo.resolve('c1', sig, () => {
      recomputed = true;
      return 'x';
    });
    expect(recomputed).toBe(false);
  });
});

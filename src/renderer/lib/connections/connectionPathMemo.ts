/**
 * H4 (perf) — connection-path memo.
 *
 * `ConnectionLayer.renderableConnections` reads `viewportRect` for culling, so
 * it re-derives on every pan/zoom frame. A pure pan changes only the CSS
 * transform, NOT the tiles' world coordinates — so a connection's path `d`
 * (computed in world space) is identical across pan frames. On large boards the
 * dominant per-frame cost was recomputing every visible connection's path
 * (and, for `smart`, an A* over a Hanan grid) on each of those re-derives.
 *
 * This memo caches each connection's `d` keyed on a signature of the inputs
 * that actually determine the path. On a pure pan the signature is unchanged,
 * so the cached `d` is returned and `computePath` is never called. The cull
 * step still runs each frame (cheap AABB test), so the rendered set stays
 * correct at the viewport edge — only the expensive geometry is memoized.
 *
 * The memo is a plain non-reactive object: it is consulted INSIDE a `$derived`
 * but is never itself a reactive dependency, so it can't cause a re-run.
 */

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Builds the cache key for a connection's path. Captures everything
 * `computePath` consumes: both endpoint rects, the two bubble indices, and the
 * resolved path type. Colour/size/arrow style is deliberately excluded — it
 * doesn't change the `d` string.
 *
 * `smart` paths additionally route around other tiles, so they fold in the
 * spatial index `revision` (bumped on any tile insert/update/remove): an
 * obstacle moving invalidates a smart path even when its own endpoints didn't
 * move. Non-smart paths ignore the revision so an unrelated tile move can't
 * needlessly bust their cache.
 */
export function connectionPathSignature(
  fromRect: RectLike,
  toRect: RectLike,
  fromBubble: number,
  toBubble: number,
  pathType: string,
  smartRevision: number,
): string {
  const base =
    `${pathType}|${fromRect.x},${fromRect.y},${fromRect.width},${fromRect.height}` +
    `|${toRect.x},${toRect.y},${toRect.width},${toRect.height}|${fromBubble},${toBubble}`;
  return pathType === 'smart' ? `${base}|r${smartRevision}` : base;
}

export interface ConnectionPathMemo {
  /**
   * Returns the cached path for `id` when its signature is unchanged; otherwise
   * runs `compute()`, caches, and returns the fresh path.
   */
  resolve(id: string, sig: string, compute: () => string): string;
  /** Drops cache entries for connections no longer present (deleted), so the
   *  cache can't grow unbounded across a session. Culled-but-still-present
   *  connections keep their entry so re-entering the viewport is a cache hit. */
  pruneExcept(liveIds: Record<string, unknown>): void;
  /** Test/diagnostic: number of cached entries. */
  readonly size: number;
}

export function createConnectionPathMemo(): ConnectionPathMemo {
  // Plain null-proto object (not a Map) — avoids the renderer's
  // `svelte/prefer-svelte-reactivity` lint and is non-reactive by construction.
  const cache: Record<string, { sig: string; pathD: string }> = Object.create(null);
  return {
    resolve(id, sig, compute) {
      const hit = cache[id];
      if (hit !== undefined && hit.sig === sig) return hit.pathD;
      const pathD = compute();
      cache[id] = { sig, pathD };
      return pathD;
    },
    pruneExcept(liveIds) {
      for (const id in cache) {
        if (!(id in liveIds)) delete cache[id];
      }
    },
    get size() {
      return Object.keys(cache).length;
    },
  };
}

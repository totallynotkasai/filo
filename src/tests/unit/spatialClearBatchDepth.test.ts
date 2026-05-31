import { describe, it, expect, beforeEach } from 'vitest';
import { createSpatialScope, type SpatialScope } from '@renderer/stores/spatial.svelte';

/**
 * Audit 5.5 — a board reload / external-change reconcile rebuilds the spatial
 * index via `rebuildSpatialIndex` → `clear()` + re-`insert()`. If a drag batch
 * is open at that moment (`beginBatch` raised `_batchDepth`), `clear()`'s
 * `bumpRevision()` is deferred and the depth is never reset, so the re-inserts
 * during repopulation stay suppressed too — reactive viewport culling doesn't
 * re-derive and the reloaded tiles flicker out until the drag ends.
 *
 * A `clear()` is a wholesale rebuild, not a per-frame drag mutation, so it must
 * bump the revision immediately regardless of an open batch.
 */
describe('SpatialScope.clear() during an open batch (audit 5.5)', () => {
  let scope: SpatialScope;
  beforeEach(() => {
    scope = createSpatialScope();
  });

  it('bumps the revision when clear() runs inside an open drag batch', () => {
    scope.insert('old', 0, 0, 100, 100);
    scope.beginBatch(); // a multi-tile drag is in flight
    const before = scope.revision;

    // Board reload / external reconcile rebuilds the index mid-drag.
    scope.clear();
    scope.insert('new', 500, 500, 100, 100);

    // Reactive culling consumers read `revision`; without a bump they keep the
    // pre-reload view and the reloaded tile is invisible until the drag ends.
    expect(scope.revision).toBeGreaterThan(before);
  });

  it('still defers ordinary per-tile updates during a batch (unchanged)', () => {
    scope.insert('a', 0, 0, 100, 100);
    scope.beginBatch();
    const before = scope.revision;
    scope.update('a', 10, 10, 100, 100); // per-frame drag mutation — deferred
    expect(scope.revision).toBe(before);
    scope.endBatch();
    expect(scope.revision).toBe(before + 1);
  });
});

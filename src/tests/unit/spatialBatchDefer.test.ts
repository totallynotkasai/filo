import { describe, it, expect, beforeEach } from 'vitest';
import { createSpatialScope, type SpatialScope } from '@renderer/stores/spatial.svelte';

/**
 * Resize-driven spatial updates must not perturb the index
 * mid-batch (multi-tile drag). Smart-guide candidate collection reads the
 * index; a neighbour reflowing (image load, auto-height growth) would snap
 * the guides 1–5px. `updateOrDefer` holds the update until `endBatch`.
 */
describe('SpatialScope batch resize deferral', () => {
  let scope: SpatialScope;

  beforeEach(() => {
    scope = createSpatialScope();
  });

  const geom = (id: string) => scope.index.all().find((i) => i.id === id);

  it('applies updateOrDefer immediately when not batching', () => {
    scope.insert('a', 0, 0, 100, 50);
    scope.updateOrDefer('a', () => ({ x: 10, y: 20, width: 200, height: 80 }));
    const g = geom('a')!;
    expect(g.minX).toBe(10);
    expect(g.minY).toBe(20);
    expect(g.maxX).toBe(210);
    expect(g.maxY).toBe(100);
  });

  it('holds index geometry stable during a batch, flushes on endBatch', () => {
    scope.insert('a', 0, 0, 100, 50);
    scope.beginBatch();
    scope.updateOrDefer('a', () => ({ x: 10, y: 20, width: 200, height: 80 }));
    // Still old geometry mid-batch — neighbours stay consistent for guides.
    expect(geom('a')!.minX).toBe(0);
    expect(geom('a')!.maxX).toBe(100);
    scope.endBatch();
    expect(geom('a')!.minX).toBe(10);
    expect(geom('a')!.maxX).toBe(210);
  });

  it('reads the geometry thunk lazily at flush (final drag position wins)', () => {
    scope.insert('a', 0, 0, 100, 50);
    scope.beginBatch();
    let live = { x: 5, y: 5, width: 100, height: 50 };
    scope.updateOrDefer('a', () => live);
    // Dragged tile commits its drop position before endBatch runs.
    live = { x: 300, y: 300, width: 120, height: 60 };
    scope.endBatch();
    expect(geom('a')!.minX).toBe(300);
    expect(geom('a')!.maxX).toBe(420);
  });

  it('coalesces multiple deferred resizes per id (last wins)', () => {
    scope.insert('a', 0, 0, 100, 50);
    scope.beginBatch();
    scope.updateOrDefer('a', () => ({ x: 1, y: 1, width: 10, height: 10 }));
    scope.updateOrDefer('a', () => ({ x: 2, y: 2, width: 20, height: 20 }));
    scope.endBatch();
    expect(geom('a')!.minX).toBe(2);
    expect(geom('a')!.maxX).toBe(22);
  });

  it('emits exactly one revision bump for a batch with deferred resizes', () => {
    scope.insert('a', 0, 0, 100, 50);
    const before = scope.revision;
    scope.beginBatch();
    scope.updateOrDefer('a', () => ({ x: 10, y: 10, width: 100, height: 50 }));
    expect(scope.revision).toBe(before); // no bump while batching
    scope.endBatch();
    expect(scope.revision).toBe(before + 1); // single coalesced bump
  });

  it('drops a deferred resize when the tile is removed mid-batch', () => {
    scope.insert('a', 0, 0, 100, 50);
    scope.beginBatch();
    scope.updateOrDefer('a', () => ({ x: 10, y: 10, width: 100, height: 50 }));
    scope.remove('a');
    scope.endBatch();
    expect(geom('a')).toBeUndefined();
  });
});

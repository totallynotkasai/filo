import { SpatialIndex, type QueryRect } from '../lib/spatialIndex';
import { getActiveScope, makeFacade } from '../lib/boards/boardScope.svelte';

/**
 * Per-pane spatial-index store. Wraps an `SpatialIndex` and exposes a
 * `$state revision` counter so viewport-culling consumers re-derive on
 * every insert/update/remove.
 *
 * Each `BoardScope` owns a fresh `SpatialScope` instance. The exported
 * `spatialStore` is a global facade Proxy that delegates to the active
 * scope's instance.
 */
export class SpatialScope {
  private _index = new SpatialIndex();

  // Svelte 5 rune to trigger reactivity on spatial queries
  revision = $state(0);

  // Batch mode: while non-zero, mutations skip the revision bump and just
  // set this._pendingBump. endBatch() emits a single bump if anything
  // actually mutated. Used during multi-tile drag to keep reactive viewport
  // culling from re-deriving once per dragged tile per frame.
  private _batchDepth = 0;
  private _pendingBump = false;

  /**
   * Read-only access to the underlying SpatialIndex.
   * Use the store's insert/update/remove/clear methods for mutations so that
   * the revision counter stays in sync and Svelte reactivity is preserved.
   */
  get index(): SpatialIndex {
    return this._index;
  }

  beginBatch() {
    this._batchDepth++;
  }

  endBatch() {
    if (this._batchDepth === 0) return;
    this._batchDepth--;
    if (this._batchDepth === 0 && this._pendingBump) {
      this._pendingBump = false;
      this.revision++;
    }
  }

  private bumpRevision() {
    if (this._batchDepth > 0) {
      this._pendingBump = true;
    } else {
      this.revision++;
    }
  }

  insert(id: string, x: number, y: number, width: number, height: number) {
    this._index.insert(id, x, y, width, height);
    this.bumpRevision();
  }

  update(id: string, x: number, y: number, width: number, height: number) {
    this._index.update(id, x, y, width, height);
    this.bumpRevision();
  }

  remove(id: string) {
    this._index.remove(id);
    this.bumpRevision();
  }

  clear() {
    this._index.clear();
    this.bumpRevision();
  }

  queryViewport(rect: QueryRect): string[] {
    // Reading this.revision creates a dependency so this query re-runs when the tree mutates

    const _track = this.revision;
    return this._index.queryViewport(rect);
  }
}

/**
 * Factory: creates a fresh per-pane spatial scope. Called from
 * `createBoardScope()` in `boardScope.svelte.ts`.
 */
export function createSpatialScope(): SpatialScope {
  return new SpatialScope();
}

/**
 * Global facade — every property access delegates to the active pane's
 * scope. Workspace-level call sites can keep importing `spatialStore` and
 * get the active scope's spatial index transparently.
 */
export const spatialStore: SpatialScope = makeFacade(() => getActiveScope().spatial);

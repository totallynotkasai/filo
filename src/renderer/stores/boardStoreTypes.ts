import type { Board, Connection, Frame, Tile } from '../schema/index';
import type { CanvasScope } from './canvas.svelte';
import type { SelectionScope } from './selection.svelte';
import type { SpatialScope } from './spatial.svelte';

/**
 * Closure handed to each board-store slice so it can read the per-pane
 * derived view of the active board and read the pane's sub-scopes (spatial /
 * canvas / selection) without owning its own `$state` proxy.
 *
 * Phase R7 (Reactive BoardScope, 2026-05-26) — the per-pane `tiles`,
 * `connections`, `frames`, and `currentBoard` are now `$derived` projections
 * of `boardCacheStore.cache[currentBoardId]`. The cache is the single source
 * of truth; per-pane runtime state has been removed. As a result the slice
 * context only exposes **readers** — slices must mutate state by calling the
 * cache-side writers (`boardCacheStore.persist*`, `boardCacheStore.markDirty`,
 * etc.). The previous setters (`setTiles`, `setConnections`, `setFrames`,
 * `replaceCurrent`) no longer exist; any caller that needs to revert the
 * tile/connection/frame view should route through `boardCacheStore.replaceCache`
 * (which atomically swaps the cache snapshot and the derived view follows).
 *
 * `spatial` / `canvas` / `selection` give slices access to the SAME per-
 * pane scope instances that the board orchestrator owns — slices must NOT
 * import `spatialStore` / `canvasStore` / `selectionStore` directly, since
 * those globals resolve to the *active* pane's scope which may not be the
 * pane that's hydrating during a board switch.
 *
 * Cross-slice helpers (`removeTile`, `updateTile`, `updateSettings`) are
 * resolved lazily through the orchestrator because the slices are built
 * before the store object exists.
 */
export interface BoardContext {
  getCurrent(): Board | null;
  getTiles(): Record<string, Tile>;
  getConnections(): Record<string, Connection>;
  getFrames(): Frame[];
  bumpSettingsVersion(): void;
  removeTile(tileId: string): void;
  updateTile(tileId: string, updates: Partial<Tile>): void;
  updateSettings(patch: Record<string, unknown>): void;
  spatial: SpatialScope;
  canvas: CanvasScope;
  selection: SelectionScope;
}

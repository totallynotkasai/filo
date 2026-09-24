import type { MindMapBoard, Tile } from '../schema/index';
import { opsFor } from '../core/boardTileOps';
import type { CacheContext } from './boardCacheTypes';

/**
 * Cache slice — tile CRUD entry points exposed on `boardCacheStore`. Every
 * mutator dispatches to the per-board-type implementation in
 * `core/boardTileOps/<type>.ts` via `opsFor(cached.board)`. The strategy
 * registry is exhaustive over `BoardType`, so adding a new board variant
 * is a compile error in `core/boardTileOps.ts` until it ships per-type
 * ops.
 *
 * Active-proxy reactivity contract
 * --------------------------------
 * MindMap uses the **opposite** pattern to Kanban / Task List: the canonical
 * path is `boardStore.{addTile,updateTile,removeTile}` (in `boardTiles.ts`),
 * which mutates the active `tiles` map first and then calls
 * `boardCacheStore.persist*` to mirror into the cache. So callers reaching
 * this cache slice via the active-side facade do NOT need to tick — the
 * active map was already mutated by the facade.
 *
 * Callers that invoke `boardCacheStore.persist*` **directly** (bypassing
 * the `boardStore` facade) are:
 *  - `fileTags.svelte.ts` / `fileTagsCascade.svelte.ts` — tag rewrites
 *    mirror onto the active board via other code paths.
 *  - `TaskListBoard.svelte` row-title rename — Task List reads from the
 *    cache via `getFullTasksForBoard`, plus calls `tickAndPersist()` so
 *    the active proxy adopts the new top-level identity.
 *  - `commands/groupAndBoardCommands.ts` (CascadeDeleteCommand undo) —
 *    destructive-undo path; the consumer re-syncs.
 *
 * Style updates flowing through `persistUpdateTileStyle` (TileStylePopup
 * write-through) — same exception class as the Kanban / Task List style
 * popups: per-pick writes without ticking, single command pushed on close.
 */
export function makeTilesSlice(ctx: CacheContext) {
  return {
    getTilePlacement(
      tileId: string,
      boardId: string,
    ): { x: number; y: number; width: number; height: number } | null {
      const cached = ctx.getCache()[boardId];
      if (!cached) return null;
      const b = cached.board;
      // Placement coordinates are a MindMap concept — Kanban / Task List
      // cards have no canvas geometry. Non-MindMap callers should reach
      // for their own placement reader (`tilePlacements`, `tasks`) instead.
      if (b.type !== 'mindmap') return null;
      const mm = b as MindMapBoard;
      const p = (mm.placements ?? {})[tileId];
      if (p) return { x: p.x, y: p.y, width: p.width, height: p.height };
      const it = (mm.inlineTiles ?? {})[tileId] as
        | { x: number; y: number; width: number; height: number }
        | undefined;
      if (it) return { x: it.x, y: it.y, width: it.width, height: it.height };
      return null;
    },

    getFullTilesForBoard(boardId: string): Record<string, Tile> {
      const cached = ctx.getCache()[boardId];
      if (!cached) return {};
      return opsFor(cached.board).getFullTiles(cached, boardId);
    },

    async persistAddTile(
      tile: Tile,
      options?: { skipEmptySeed?: boolean },
      // Explicit target board. A tile RE-ADDED by cascade-delete rollback isn't
      // in any board's cache yet, so the findBoardIdForTile scan can't resolve
      // it and the re-add would be dropped. tile.boardId and the scan are fallbacks.
      boardId?: string,
    ): Promise<void> {
      // Resolve boardId once at the top. Prefer the explicit arg, then the
      // tile's own field, then a cache scan for re-adds. Brand-new tiles
      // created when boardStore.current is null must be stamped at the caller
      // (boardStore.addTile) — the scan can't conjure an id for a tile that
      // doesn't exist in any board yet.
      const resolvedBoardId = boardId || tile.boardId || ctx.findBoardIdForTile(tile.id) || '';
      if (!resolvedBoardId) {
        ctx.warnUnresolved('persistAddTile', `tile ${tile.id}`);
        return;
      }
      const enrichedTile: Tile = tile.boardId === resolvedBoardId
        ? tile
        : ({ ...tile, boardId: resolvedBoardId } as Tile);

      const cached = ctx.getCache()[resolvedBoardId];
      if (!cached) return;

      await opsFor(cached.board).addTile(ctx, cached, resolvedBoardId, enrichedTile, options);
    },

    persistRemoveTile(tileId: string): void {
      const boardId = ctx.findBoardIdForTile(tileId);
      // Warn rather than bare-return: an unresolved boardId means a remove the
      // cache never applied (e.g. a cascade delete hitting an evicted entry).
      if (!boardId) {
        ctx.warnUnresolved('persistRemoveTile', `tile ${tileId}`);
        return;
      }

      const cached = ctx.getCache()[boardId];
      if (!cached) return;

      opsFor(cached.board).removeTile(ctx, cached, boardId, tileId);
    },

    persistUpdateTile(tileId: string, updates: Partial<Tile>, boardId?: string): void {
      const resolvedBoardId = boardId ?? ctx.findBoardIdForTile(tileId);
      // Same warn-not-swallow as persistRemoveTile above.
      if (!resolvedBoardId) {
        ctx.warnUnresolved('persistUpdateTile', `tile ${tileId}`);
        return;
      }

      const cached = ctx.getCache()[resolvedBoardId];
      if (!cached) return;

      opsFor(cached.board).updateTile(ctx, cached, resolvedBoardId, tileId, updates);
    },
  };
}

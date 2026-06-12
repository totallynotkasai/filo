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
 * Phase 2 of CONSOLIDATION_PLAN_2026-05-25 — before this lift the body
 * here cast the board to `MindMapBoard` and operated on `.placements` /
 * `.inlineTiles`, fields that don't exist on Kanban / Task List boards.
 * Every renderer entry point (TileHeader, AppShell multi-delete, orphan
 * catcher, DeleteTilesCommand, CascadeDeleteCommand, ...) funnels through
 * this slice; the MindMap-only body silently left orphan placements on
 * disk every time a non-MindMap tile got deleted (bug #2).
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
      // 6.4.M20 — explicit target board. During cascade-delete rollback the
      // tile is being RE-ADDED, so it isn't in any board's cache yet and the
      // findBoardIdForTile memo scan can't resolve it (it invalidates the now-
      // stale entry and finds nothing), silently dropping the re-add. The
      // caller (CascadeDeleteCommand.undo) already knows the owning board, so
      // it passes it here; tile.boardId and the scan stay the fallbacks.
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
      // Audit-16 6.5 — warn instead of bare-returning (sibling of the
      // persistAddTile fix above): an unresolved boardId here means a remove
      // the cache never applied (e.g. a cascade delete hitting an evicted
      // board cache entry), which would otherwise vanish without a trace.
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
      // Audit-16 6.5 — same warn-not-swallow as persistRemoveTile above.
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

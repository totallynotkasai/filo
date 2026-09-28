import type { Tile, Connection } from '../schema/index';
import { boardCacheStore } from './boardCache.svelte';
import type { BoardContext } from './boardStoreTypes';
import { historyStore } from './history.svelte';
import { CascadeDeleteCommand, type CascadeDeleteOptions } from '../commands/index';

/**
 * Board slice — file-reference changes from outside the board (renames and
 * cascade deletes).
 *
 * The cache slice (`boardCacheFrontmatter`) handles persistence and is the
 * single source of truth: the active-pane `tiles` map is `$derived` from
 * `boardCacheStore.cache[currentBoardId]` and re-fires automatically when the
 * cache settles, so no runtime mirroring is needed here.
 *
 * Cascade-delete-by-vault-path stays here because it owns the history
 * dispatch (snapshotting tiles + connections + style clears before the cache
 * mutates) — the actual tile removal goes through the cache mutators on
 * undo/redo so derived consumers re-fire automatically.
 */
export function makeFrontmatterSyncSlice(_ctx: BoardContext) {
  void _ctx;

  return {
    propagateRename(oldRelPath: string, newRelPath: string): string[] {
      return boardCacheStore.propagateRename(oldRelPath, newRelPath);
    },

    cascadeDeleteByVaultPath(
      deletedRelPath: string,
      opts: Omit<CascadeDeleteOptions, 'styleClears'> & {
        /**
         * Keep the command off every undo stack: no stack the user can reach
         * would undo it (no board open, or a Document tab's own stack), so
         * the caller offers the undo on a toast instead.
         */
        offStack?: boolean;
      } = {},
    ): {
      removedTileIds: string[]; changedBoardIds: string[];
      /** The undoable command, when there was anything to undo. */
      command: CascadeDeleteCommand | null;
    } {
      // Pure scan. Style-clears are returned alongside the tile plan so the
      // cascade command can replay them on undo.
      const targets = boardCacheStore.findCascadeDeleteTargets(deletedRelPath);
      const removedTileIds: string[] = [];
      // Iterate every style-clear category rather than hand-listing them, so a
      // new `CascadeStyleClears` bucket can't be missed (e.g. an attachment used
      // only as a column cover would short-circuit here and stay referenced).
      const hasStyleClears = Object.values(targets.styleClears).some(
        (s) => s !== undefined && Object.keys(s).length > 0,
      );
      // Nothing to undo at all: no tile, no style field, nothing in the trash.
      // A trashed item on no board still gets a command, so Ctrl+Z brings it
      // back.
      if (targets.tileIds.length === 0 && !hasStyleClears && !opts.trashed) {
        return { removedTileIds, changedBoardIds: Object.keys(targets.byBoard), command: null };
      }

      // Snapshot the tiles + connections about to be removed so undo can
      // restore them. The file itself, when the caller moved it into Filo's
      // trash (`opts.trashed`), comes back from there on undo.
      const byBoardTiles: Record<string, Tile[]> = {};
      const tileIdSet = new Set<string>(targets.tileIds);
      for (const [boardId, tileIds] of Object.entries(targets.byBoard)) {
        const fullTiles = boardCacheStore.getFullTilesForBoard(boardId);
        const snapshot: Tile[] = [];
        for (const tileId of tileIds) {
          const tile = fullTiles[tileId];
          if (tile) snapshot.push(tile);
        }
        if (snapshot.length > 0) byBoardTiles[boardId] = snapshot;
      }

      // Snapshot any connections that reference a cascade target across
      // every loaded board (a connection on board X bridging a deleted
      // tile on board Y also needs to be restored).
      const seenConns = new Set<string>();
      const conns: Connection[] = [];
      for (const data of Object.values(boardCacheStore.cache)) {
        for (const conn of Object.values(data.connections ?? {})) {
          const c = conn as Connection;
          if (seenConns.has(c.id)) continue;
          if (tileIdSet.has(c.fromTileId) || tileIdSet.has(c.toTileId)) {
            conns.push({ ...c });
            seenConns.add(c.id);
          }
        }
      }

      // Apply the style-clear plan AFTER snapshotting and BEFORE removing
      // tiles; the matched paths live in the command's `styleClears` snapshot
      // so undo can restore them. JSON round-trip rather than structuredClone because boardCache entries
      // are Svelte 5 $state proxies.
      const styleClearsSnapshot = JSON.parse(JSON.stringify(targets.styleClears));
      // Built before the clears land: it snapshots each Kanban card's and
      // Task List task's placement, cover image included.
      const { offStack, ...commandOpts } = opts;
      const command = new CascadeDeleteCommand(byBoardTiles, conns, { ...commandOpts, styleClears: styleClearsSnapshot });
      if (hasStyleClears) {
        boardCacheStore.applyCascadeStyleClears(targets.styleClears);
      }

      // Dispatch through history so Ctrl+Z restores the file, placements and
      // styles. Off the stack, the caller offers the undo itself (a toast).
      if (offStack) {
        historyStore.holdOffStack(command);
        void historyStore.runOffStack(() => command.execute(), command.description);
      } else {
        historyStore.execute(command);
      }
      for (const arr of Object.values(byBoardTiles)) {
        for (const t of arr) removedTileIds.push(t.id);
      }
      return { removedTileIds, changedBoardIds: Object.keys(targets.byBoard), command };
    },
  };
}

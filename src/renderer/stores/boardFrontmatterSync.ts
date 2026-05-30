import type { Tile, Connection } from '../schema/index';
import { boardCacheStore } from './boardCache.svelte';
import type { FileMetadata } from '../lib/vault/vaultIndex';
import type { BoardContext } from './boardStoreTypes';
import { historyStore } from './history.svelte';
import { CascadeDeleteCommand } from '../commands/index';

/**
 * Board slice — external-edit reconciliation entry points.
 *
 * Phase R7 (Reactive BoardScope, 2026-05-26) — the cache slice
 * (`boardCacheFrontmatter`) handles persistence and is now the single source
 * of truth: the active-pane `tiles` map is `$derived` from
 * `boardCacheStore.cache[currentBoardId]` and re-fires automatically when the
 * cache settles. The pre-R7 runtime-mirror step (patching the runtime `tiles`
 * map to reflect newly-reconciled frontmatter / propagated rename targets) is
 * removed — the derivation does it for us, and removing it eliminates the
 * cache→runtime drift that the mirror was working around.
 *
 * Cascade-delete-by-vault-path stays here because it owns the history
 * dispatch (snapshotting tiles + connections + style clears before the cache
 * mutates) — the actual tile removal goes through the cache mutators on
 * undo/redo so derived consumers re-fire automatically.
 */
export function makeFrontmatterSyncSlice(_ctx: BoardContext) {
  void _ctx;

  return {
    applyFrontmatterToBackedTiles(relPath: string, metadata: FileMetadata): string[] {
      return boardCacheStore.applyFrontmatterToBackedTiles(relPath, metadata);
    },

    propagateRename(oldRelPath: string, newRelPath: string): string[] {
      return boardCacheStore.propagateRename(oldRelPath, newRelPath);
    },

    cascadeDeleteByVaultPath(
      deletedRelPath: string,
      fileSnapshots: Record<string, string> = {},
      vaultRoot: string = '',
      mediaSnapshots: Record<string, string> = {},
    ): {
      removedTileIds: string[]; changedBoardIds: string[];
    } {
      // Sprint 35.2 — pure scan. Style-clears are returned alongside the
      // tile plan so the cascade command can replay them on undo.
      const targets = boardCacheStore.findCascadeDeleteTargets(deletedRelPath);
      const removedTileIds: string[] = [];
      // Phase 1 / 1.3 — iterate every style-clear category instead of
      // hand-listing them. The hand-listed form silently missed any
      // future category added to `CascadeStyleClears` — including
      // `columnCoverImage` (Sprint C / C23), which meant a deleted
      // attachment used ONLY as a Kanban column header `coverImage`
      // would set `targets.tileIds === []` and `hasStyleClears === false`,
      // causing the whole branch to short-circuit and leaving the
      // column referencing the now-missing file. The Object.values walk
      // future-proofs the gate: every new style-clear bucket added to
      // `CascadeStyleClears` participates automatically.
      const hasStyleClears = Object.values(targets.styleClears).some(
        (s) => s !== undefined && Object.keys(s).length > 0,
      );
      if (targets.tileIds.length === 0 && !hasStyleClears) {
        return { removedTileIds, changedBoardIds: Object.keys(targets.byBoard) };
      }

      // Snapshot the tiles + connections about to be removed so undo can
      // restore them. Phase 31 A3.5 — the caller may also pass
      // `fileSnapshots` (vault-relative .md path → body bytes captured
      // BEFORE the delete IPC), which the command will write back on
      // undo so restored tiles point at content again instead of broken
      // refs. External deletes that bypass this path still surface a
      // broken-ref badge as before.
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

      // Sprint 35.2 — apply the style-clear plan AFTER snapshotting and
      // BEFORE removing tiles. Mutating the cache here mirrors what the
      // helper used to do inline, but the matched paths now live in the
      // command's `styleClears` snapshot so undo can restore them. JSON
      // round-trip rather than structuredClone because boardCache entries
      // are Svelte 5 $state proxies (see feedback_no_structuredclone_on_state_proxies).
      const styleClearsSnapshot = JSON.parse(JSON.stringify(targets.styleClears));
      if (hasStyleClears) {
        boardCacheStore.applyCascadeStyleClears(targets.styleClears);
      }

      // Dispatch through history so Ctrl+Z restores placements + bodies + styles.
      historyStore.execute(new CascadeDeleteCommand(byBoardTiles, conns, fileSnapshots, vaultRoot, styleClearsSnapshot, mediaSnapshots));
      for (const arr of Object.values(byBoardTiles)) {
        for (const t of arr) removedTileIds.push(t.id);
      }
      return { removedTileIds, changedBoardIds: Object.keys(targets.byBoard) };
    },
  };
}

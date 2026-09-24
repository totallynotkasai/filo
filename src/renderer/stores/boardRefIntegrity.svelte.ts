import { SvelteSet } from 'svelte/reactivity';
import { detectBrokenRefs } from '../lib/vault/fileRefIntegrity';
import { boardCacheStore } from './boardCache.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';

/**
 * Board reference integrity store — tracks tile placements whose backing
 * vault file has been deleted or renamed away. Recomputed after vault open
 * and after each file-tree refresh so the broken-tile UI overlay stays in
 * sync with disk reality.
 *
 * `boardId → set of tileIds whose backing file is missing.`
 */

let brokenTilesByBoard = $state<Record<string, Set<string>>>({});

export const boardRefIntegrityStore = {
  get brokenTilesByBoard() {
    return brokenTilesByBoard;
  },

  /** Whether a tile has a missing backing file (across all boards). */
  isBrokenTile(tileId: string): boolean {
    for (const ids of Object.values(brokenTilesByBoard)) {
      if (ids.has(tileId)) return true;
    }
    return false;
  },

  /**
   * Recomputes `brokenTilesByBoard` against the given set of vault-relative
   * file paths. Typically called after vault open and on each file-tree
   * refresh.
   */
  recompute(knownVaultPaths: ReadonlySet<string>): void {
    const next: Record<string, Set<string>> = {};
    for (const [boardId, data] of Object.entries(boardCacheStore.cache)) {
      const broken = detectBrokenRefs(data, knownVaultPaths);
      if (broken.length === 0) continue;
      next[boardId] = new SvelteSet(broken.map((b) => b.tileId));
    }
    brokenTilesByBoard = next;
  },

  /**
   * Returns the tile IDs flagged as broken for the given board (or every
   * board if `boardId` is omitted). Caller is responsible for removing the
   * tiles from active state and the cache, then calling `clear(boardId)`.
   */
  getBrokenTileIds(boardId?: string): string[] {
    const result: string[] = [];
    for (const [bid, ids] of Object.entries(brokenTilesByBoard)) {
      if (boardId && bid !== boardId) continue;
      for (const id of ids) result.push(id);
    }
    return result;
  },

  /**
   * Drops the broken-ref entries for a given board (or all boards). Call
   * after the caller has finished cleaning up the underlying tiles so the
   * indicator UI clears.
   */
  clear(boardId?: string) {
    if (boardId) {
      const next = { ...brokenTilesByBoard };
      delete next[boardId];
      brokenTilesByBoard = next;
    } else {
      brokenTilesByBoard = {};
    }
  },
};

// Vault-swap reset: drops the broken-ref tracking so the next vault's `recompute` starts
// from an empty map rather than carrying ghost-broken entries that point
// at tile ids the new vault doesn't own.
onVaultSwap('pre-swap', 'boardRefIntegrity', () => {
  brokenTilesByBoard = {};
});

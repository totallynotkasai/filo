import { SvelteSet } from 'svelte/reactivity';
import type { Tile } from '../schema/index';
import { boardStore } from './board.svelte';
import { noteStore } from './notes.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { resolveTextTileVaultPath } from '../lib/boards/textTilePath';
import { findOrphans, type OrphanInfo } from '../lib/canvas/orphanCatcher';
import { onVaultSwap } from '../core/vaultLifecycle';

/**
 * Orphan Catcher store — computes and exposes the list of orphan tiles for
 * the active board, plus the set of tile IDs currently highlighted with the
 * pulsing outline. The UI modal drives `rescan()` and `highlight(ids)`.
 */

const DEFAULT_CLUSTER_DISTANCE = 600;

/**
 * Resolves a text tile's real backing body for the empty-orphan check. `tile.content` is always '' (the body lives in the .md), so emptiness
 * has to come from the live document or the on-disk index. Priority:
 *
 *   1. The open `DocumentState` — captures unsaved in-memory edits and
 *      freshly-created tiles whose body hasn't been flushed to disk yet.
 *   2. The vault index's cached `.md` body — covers tiles whose document
 *      isn't currently open.
 *
 * Returns `undefined` when neither resolves; `findOrphans` treats that as NOT
 * empty so a tile whose body can't be read is never falsely flagged.
 */
function resolveTextBody(tile: Tile): string | undefined {
  if (tile.type !== 'text') return undefined;
  const path = resolveTextTileVaultPath(tile);
  const note = path ? noteStore.get(path) : undefined;
  if (note && note.status === 'ready') return note.body;
  if (path) {
    const md = vaultIndexStore.getMetadata(path);
    if (md) return md.content;
  }
  return undefined;
}

let results = $state<OrphanInfo[]>([]);
const highlighted = new SvelteSet<string>();
let clusterDistance = $state(DEFAULT_CLUSTER_DISTANCE);

export const orphansStore = {
  get results() { return results; },
  get clusterDistance() { return clusterDistance; },

  setClusterDistance(px: number): void {
    clusterDistance = Math.max(0, px);
  },

  isHighlighted(tileId: string): boolean {
    return highlighted.has(tileId);
  },

  /** Recomputes orphans from the active board's tiles + connections. */
  rescan(): OrphanInfo[] {
    const found = findOrphans({
      tiles: boardStore.tiles,
      connections: boardStore.connections,
      clusterDistance,
      resolveTextBody,
    });
    results = found;
    // Clear stale highlights for tiles that are no longer orphans
    const stillOrphan = new SvelteSet(found.map((o) => o.tileId));
    for (const id of [...highlighted]) {
      if (!stillOrphan.has(id)) highlighted.delete(id);
    }
    return found;
  },

  /** Highlights all current results with the pulsing outline. */
  highlightAll(): void {
    highlighted.clear();
    for (const o of results) highlighted.add(o.tileId);
  },

  /** Highlights a single tile id. */
  highlight(tileId: string): void {
    highlighted.clear();
    highlighted.add(tileId);
  },

  clearHighlight(): void {
    highlighted.clear();
  },
};

// Vault-swap reset: drop the orphan list, highlights and cluster distance so a
// stale rescan from the outgoing vault can't flash on the new vault's first frame.
onVaultSwap('pre-swap', 'orphans', () => {
  results = [];
  highlighted.clear();
  clusterDistance = DEFAULT_CLUSTER_DISTANCE;
});

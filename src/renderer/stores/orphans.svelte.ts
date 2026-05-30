import { SvelteSet } from 'svelte/reactivity';
import { boardStore } from './board.svelte';
import { findOrphans, type OrphanInfo } from '../lib/canvas/orphanCatcher';
import { onVaultSwap } from '../core/vaultLifecycle';

/**
 * Orphan Catcher store — computes and exposes the list of orphan tiles for
 * the active board, plus the set of tile IDs currently highlighted with the
 * pulsing outline. The UI modal drives `rescan()` and `highlight(ids)`.
 */

const DEFAULT_CLUSTER_DISTANCE = 600;

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

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Drops the cached orphan list, pulsing highlights, and resets the cluster
// distance to the default so a stale rescan from the outgoing vault can't
// flash on the new vault's first frame.
onVaultSwap('pre-swap', 'orphans', () => {
  results = [];
  highlighted.clear();
  clusterDistance = DEFAULT_CLUSTER_DISTANCE;
});

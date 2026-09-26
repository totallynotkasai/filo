import { boardStore } from '../../stores/board.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { canvasStore } from '../../stores/canvas.svelte';
import { selectionStore } from '../../stores/selection.svelte';
import { tabStore } from '../../stores/tabs.svelte';
import type { Board } from '../../schema/index';
import { onVaultSwap } from '../../core/vaultLifecycle';
import { captureVaultIdentity, isStillSameVault } from '../vault/vaultIdentity';

/**
 * Highlight state — stores the currently highlighted tile ID
 * and auto-clears after HIGHLIGHT_DURATION_MS.
 */
let highlightedTileId = $state<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const HIGHLIGHT_DURATION_MS = 2000;

// Module handle for the tile-lookup retry chain (the board switch may
// need a tick to load tiles). Hoisted out of the closure so a new navigate or
// a vault swap can cancel a stale retry — otherwise a late retry could center
// the viewport / select a tile in the WRONG board (or the new vault) after the
// user navigated elsewhere.
let navigateRetryTimer: ReturnType<typeof setTimeout> | null = null;

export const navigationState = {
  get highlightedTileId() { return highlightedTileId; },
};

/**
 * Navigates to a specific tile, optionally switching boards first.
 *
 * 1. If the tile is on a different board, opens that board in a tab and switches to it.
 * 2. Centers the viewport on the tile.
 * 3. Selects the tile.
 * 4. Briefly highlights the tile for visual feedback (2 seconds).
 *
 * Transplanted from Fork's search.ts `navigateToTile()`.
 */
export function navigateToTile(boardId: string, tileId: string): void {
  const project = vaultStore.project;
  if (!project) return;

  // A fresh navigate supersedes any in-flight retry chain from a prior
  // call, so cancel it before starting a new one.
  if (navigateRetryTimer) {
    clearTimeout(navigateRetryTimer);
    navigateRetryTimer = null;
  }
  // Capture the vault we navigated from; a swap mid-retry must abort the chain
  // so we don't center/select against the new vault's boards. A
  // generation-aware identity (not a bare path string) also catches a
  // close → reopen of the SAME path between scheduling and the retry firing.
  const startVault = captureVaultIdentity();

  // If on a different board, switch first. The active tab decides, not
  // `boardStore.current`: a Document tab leaves `boardStore` naming the board
  // its pane showed before, which would skip the switch.
  if (tabStore.activeTab?.boardId !== boardId) {
    const board = project.boards.find((b: Board) => b.id === boardId);
    if (board) {
      tabStore.open(board.id, board.name || 'Untitled', board.type, board.emoji);
    }
  }

  // Retry-based tile lookup — the board switch may need a tick to load tiles
  let attempts = 0;
  const maxAttempts = 20;

  const tryNavigate = () => {
    navigateRetryTimer = null;
    // Bail if the vault swapped under the retry — the captured boardId/tileId
    // belong to the old vault.
    if (!isStillSameVault(startVault)) return;
    const tile = boardStore.getTile(tileId);
    if (tile) {
      // Center viewport on tile. `renderedWidth`/`renderedHeight` are
      // optional DOM-measured caches set after layout for auto-height tiles;
      // fall back to the canonical size when they haven't been measured yet.
      const w = tile.renderedWidth ?? tile.size.width;
      const h = tile.renderedHeight ?? tile.size.height;
      canvasStore.centerOn(tile.position.x + w / 2, tile.position.y + h / 2);

      // Select the tile
      selectionStore.select(tileId);

      // Highlight briefly
      setHighlight(tileId);
    } else if (attempts < maxAttempts) {
      attempts++;
      navigateRetryTimer = setTimeout(tryNavigate, 100);
    }
  };

  tryNavigate();
}

/**
 * Sets a temporary highlight on a tile (auto-clears after 2s).
 */
function setHighlight(tileId: string) {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightedTileId = tileId;
  highlightTimer = setTimeout(() => {
    highlightedTileId = null;
    highlightTimer = null;
  }, HIGHLIGHT_DURATION_MS);
}

// Drop the active highlight (and cancel the pending
// timer) on vault swap so the new vault doesn't open with a stale
// highlight ring pinned to a tile id from the prior vault. Without this,
// a late timer would also fire `highlightedTileId = null` after the new
// vault had — coincidentally — set its own highlight, clobbering it.
onVaultSwap('pre-swap', 'navigation', () => {
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  // Also cancel any in-flight tile-lookup retry so it can't fire against
  // the new vault's boards after the swap.
  if (navigateRetryTimer) {
    clearTimeout(navigateRetryTimer);
    navigateRetryTimer = null;
  }
  highlightedTileId = null;
});

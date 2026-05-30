import { boardStore } from '../../stores/board.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { canvasStore } from '../../stores/canvas.svelte';
import { selectionStore } from '../../stores/selection.svelte';
import { tabStore } from '../../stores/tabs.svelte';
import type { Board } from '../../schema/index';
import { onVaultSwap } from '../../core/vaultLifecycle';

/**
 * Highlight state — stores the currently highlighted tile ID
 * and auto-clears after HIGHLIGHT_DURATION_MS.
 */
let highlightedTileId = $state<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const HIGHLIGHT_DURATION_MS = 2000;

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

  // If on a different board, switch first
  const currentBoardId = boardStore.current?.id;
  if (currentBoardId !== boardId) {
    const board = project.boards.find((b: Board) => b.id === boardId);
    if (board) {
      tabStore.open(board.id, board.name || 'Untitled', board.type, '');
    }
  }

  // Retry-based tile lookup — the board switch may need a tick to load tiles
  let attempts = 0;
  const maxAttempts = 20;

  const tryNavigate = () => {
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
      setTimeout(tryNavigate, 100);
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

// Sprint B / B14 — drop the active highlight (and cancel the pending
// timer) on vault swap so the new vault doesn't open with a stale
// highlight ring pinned to a tile id from the prior vault. Without this,
// a late timer would also fire `highlightedTileId = null` after the new
// vault had — coincidentally — set its own highlight, clobbering it.
onVaultSwap('pre-swap', 'navigation', () => {
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  highlightedTileId = null;
});

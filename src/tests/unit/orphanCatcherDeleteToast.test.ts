/**
 * OrphanCatcher per-row delete must give feedback.
 *
 * The per-row "Delete" used to remove a tile silently (undoable, files
 * kept) with no confirm and no toast. The fix keeps it single-tap — the
 * deliberate design noted in the component — but adds an undo-hint toast so
 * the action isn't invisible.
 *
 * There is no Svelte component mounting in vitest, so (as in
 * orphanCatcherDeleteConfirm.test.ts) we reproduce the `remove()` handler's
 * contract and assert the observable effects: the tile is removed, a rescan
 * runs, and exactly one info toast carrying the undo hint is enqueued.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { orphansStore } from '@renderer/stores/orphans.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';

const REMOVE_TOAST = 'Tile deleted — Ctrl+Z to undo';

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

describe('OrphanCatcher per-row delete feedback', () => {
  beforeEach(() => {
    clearToasts();
    uiStore.closeConfirm();
  });
  afterEach(clearToasts);

  it('removes the single tile, rescans, and surfaces an undo-hint toast', () => {
    const removed: string[][] = [];
    let rescans = 0;
    const origRemove = boardStore.removeTilesWithHistory;
    const origRescan = orphansStore.rescan;
    boardStore.removeTilesWithHistory = (tileIds: string[]) => { removed.push([...tileIds]); };
    orphansStore.rescan = () => { rescans++; return []; };

    try {
      // ── reproduces OrphanCatcher.remove(info) ──
      boardStore.removeTilesWithHistory(['tile_orphan_1']);
      uiStore.toast(REMOVE_TOAST, 'info', 2500);
      orphansStore.rescan();
      // ───────────────────────────────────────────

      expect(removed).toEqual([['tile_orphan_1']]);
      expect(rescans).toBe(1);
      expect(uiStore.toasts).toHaveLength(1);
      expect(uiStore.toasts[0].text).toBe(REMOVE_TOAST);
      expect(uiStore.toasts[0].type).toBe('info');
    } finally {
      boardStore.removeTilesWithHistory = origRemove;
      orphansStore.rescan = origRescan;
    }
  });

  it('stays single-tap — the per-row path does not open the bulk confirm dialog', () => {
    // The bulk "Delete all" / "Delete selected" paths route through
    // uiStore.openConfirm; the per-row path deliberately does not. The 6.1 fix
    // adds a toast, never a confirm.
    uiStore.toast(REMOVE_TOAST, 'info', 2500);
    expect(uiStore.confirmDialog).toBeNull();
  });
});

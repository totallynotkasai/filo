/**
 * Mind Map actions on the current tile selection, shared by the tile context
 * menu and the canvas context menu (shown there with two or more tiles
 * selected). Each applies to every selected tile that is still on the board.
 */
import type { Tile } from '../../schema/index';
import { uiStore } from '../../stores/ui.svelte';
import { toggleLockSelection, type LockableBoard } from '../boards/toggleLockSelection';

export interface SelectionActionDeps {
  board: LockableBoard & { removeTilesWithHistory(ids: string[]): void };
  selection: { readonly selectedIds: ReadonlySet<string>; clear(): void };
  openTileStyle(tile: Tile, x: number, y: number, tileIds?: string[]): void;
  openTagEditor(args: { tileId?: string; tileIds?: string[]; x: number; y: number }): void;
}

export interface SelectionActions {
  /** The selected ids that are still tiles on this board. */
  tileIds(): string[];
  /** Ctrl+L's rule over the selection, as one undo step. */
  toggleLock(): void;
  /**
   * One Style popup for the whole selection, seeded from `anchorId` (the
   * right-clicked tile) when it is selected, else from the first selected tile.
   */
  openStyle(anchorId: string | null, x: number, y: number): void;
  openTags(x: number, y: number): void;
  confirmDelete(): void;
}

export function createSelectionActions(deps: SelectionActionDeps): SelectionActions {
  const { board, selection } = deps;

  function tileIds(): string[] {
    return [...selection.selectedIds].filter((id) => board.getTile(id));
  }

  return {
    tileIds,

    toggleLock(): void {
      toggleLockSelection(board, tileIds());
    },

    openStyle(anchorId: string | null, x: number, y: number): void {
      const ids = tileIds();
      const seedId = anchorId && ids.includes(anchorId) ? anchorId : ids[0];
      const seed = seedId ? board.getTile(seedId) : undefined;
      if (!seed) return;
      deps.openTileStyle(seed, x, y, ids.length > 1 ? ids : undefined);
    },

    openTags(x: number, y: number): void {
      const ids = tileIds();
      if (ids.length === 0) return;
      deps.openTagEditor(ids.length > 1 ? { tileIds: ids, x, y } : { tileId: ids[0], x, y });
    },

    confirmDelete(): void {
      const ids = [...selection.selectedIds];
      if (ids.length === 0) return;
      uiStore.openConfirm({
        title: ids.length === 1 ? 'Delete tile?' : `Delete ${ids.length} tiles?`,
        body: ids.length === 1
          ? 'The placement is removed from this board. Backing vault files are preserved. You can undo this.'
          : `${ids.length} placements will be removed from this board. Backing vault files are preserved. You can undo this.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {
          board.removeTilesWithHistory(ids);
          selection.clear();
        },
      });
    },
  };
}

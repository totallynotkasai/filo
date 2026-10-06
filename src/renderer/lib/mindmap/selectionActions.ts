/**
 * Mind Map actions on the current tile selection, shared by the tile context
 * menu, the canvas context menu (shown there with two or more tiles selected)
 * and the Delete key. Each applies to every selected tile that is still on
 * the board.
 */
import type { Tile, TileGroup } from '../../schema/index';
import { uiStore } from '../../stores/ui.svelte';
import { textTileNotePaths, type DeleteTilesOptions } from '../../commands/index';
import { PendingWritesFailedError, withDrainedWrites } from '../vault/vaultOperations';
import { normalizePath } from '../utils/path';
import { toggleLockSelection, type LockableBoard } from '../boards/toggleLockSelection';

export interface DeletableBoard {
  getTile(id: string): Tile | undefined;
  removeTilesWithHistory(ids: string[], options?: DeleteTilesOptions): void;
  removeConnectionWithHistory(connId: string): void;
}

export interface DeletableSelection {
  readonly selectedIds: ReadonlySet<string>;
  readonly selectedConnectionIds: ReadonlySet<string>;
  clear(): void;
  clearConnections(): void;
}

export interface DeleteSelectionDeps {
  board: DeletableBoard;
  selection: DeletableSelection;
  /** The open vault's root, or null with no vault open. */
  vaultPath(): string | null;
  /** Tiles inside a collapsed frame, which the canvas doesn't draw. */
  hiddenTileIds?(): ReadonlySet<string>;
}

export interface GroupableBoard {
  readonly groups: TileGroup[];
  getGroupForTile(tileId: string): TileGroup | undefined;
  groupTilesWithHistory(tileIds: string[], groupsBefore: TileGroup[]): void;
  ungroupTilesWithHistory(tileIds: string[], groupsBefore: TileGroup[]): void;
}

/**
 * Group / Ungroup for the selection, the one flow behind Ctrl+G and the side
 * toolbar's Arrange menu: tiles that are all in one group are ungrouped,
 * any other two or more are grouped, each as one undo step.
 */
export function toggleGroupSelection(board: GroupableBoard, tileIds: string[]): void {
  if (tileIds.length < 2) {
    uiStore.toast('Select 2+ tiles to group', 'info', 1500);
    return;
  }
  const group = board.getGroupForTile(tileIds[0] ?? '');
  const allInSameGroup = group !== undefined && tileIds.every((id) => board.getGroupForTile(id)?.id === group.id);
  const groupsBefore = [...board.groups];
  if (allInSameGroup) {
    board.ungroupTilesWithHistory(tileIds, groupsBefore);
    uiStore.toast('Tiles ungrouped', 'info', 1500);
  } else {
    board.groupTilesWithHistory(tileIds, groupsBefore);
    uiStore.toast('Tiles grouped', 'info', 1500);
  }
}

/**
 * The tiles Select All picks (Ctrl+A and the canvas menu): every tile the
 * canvas draws. A tile inside a collapsed frame is left out, so a Delete
 * after Ctrl+A can't remove tiles the user can't see.
 */
export function selectableTileIds(
  tiles: Readonly<Record<string, Tile>>,
  hidden: ReadonlySet<string>,
): string[] {
  return Object.values(tiles).map((t) => t.id).filter((id) => !hidden.has(id));
}

/**
 * Delete for the selection, the one flow behind the Delete key and the
 * context menus' Delete.
 *
 * Selected connections go at once (undoable, not file-backed, so no confirm).
 * Selected tiles get a confirm, which offers to move their notes to Filo's
 * trash too when any of them is a note. Pending writes drain first, so a
 * debounced keystroke can't land after its note moved to the trash.
 */
export function requestDeleteSelected(deps: DeleteSelectionDeps): void {
  const { board, selection } = deps;
  const connIds = [...selection.selectedConnectionIds];
  if (connIds.length > 0) {
    for (const id of connIds) board.removeConnectionWithHistory(id);
    selection.clearConnections();
  }
  const tiles = [...selection.selectedIds]
    .map((id) => board.getTile(id))
    .filter((t): t is Tile => !!t);
  if (tiles.length === 0) return;
  const count = tiles.length;
  const notePaths = deps.vaultPath() ? textTileNotePaths(tiles) : [];
  const hidden = deps.hiddenTileIds?.();
  const hiddenCount = hidden ? tiles.filter((t) => hidden.has(t.id)).length : 0;
  const hiddenNote = hiddenCount === 0
    ? ''
    : count === 1
      ? ' It is inside a collapsed frame.'
      : ` ${hiddenCount} of them ${hiddenCount === 1 ? 'is' : 'are'} inside collapsed frames.`;
  uiStore.openConfirm({
    // Worded like the menus' "Remove from board": the files stay unless the
    // extra option below is ticked.
    title: count === 1 ? 'Remove tile from board?' : `Remove ${count} tiles from board?`,
    body: `${count === 1 ? 'The tile is' : `${count} tiles are`} removed from this board.${hiddenNote} You can undo this.`,
    confirmLabel: 'Remove',
    danger: true,
    extraOption: notePaths.length > 0
      ? {
          label: 'Delete associated files from vault as well?',
          hint: 'The files move to Filo\'s trash. Ctrl+Z restores the tiles and their files, or restore the files from Settings → Trash.',
          initial: false,
        }
      : undefined,
    onConfirm: (deleteWithFile) => {
      void performDelete(deps, tiles.map((t) => t.id), deleteWithFile === true ? notePaths : []);
    },
  });
}

async function performDelete(deps: DeleteSelectionDeps, tileIds: string[], filePaths: string[]): Promise<void> {
  // Only a failed write to one of the notes going to the trash blocks it.
  try {
    await withDrainedWrites(async (drain) => {
      const root = deps.vaultPath();
      const vaultRoot = filePaths.length > 0 && root ? normalizePath(root) : undefined;
      deps.board.removeTilesWithHistory(tileIds, vaultRoot ? { filePaths, vaultRoot, drain } : {});
      deps.selection.clear();
    }, { paths: filePaths });
  } catch (err) {
    // The drain already toasted; nothing is removed, so the user can fix the
    // save errors and retry.
    if (err instanceof PendingWritesFailedError) return;
    throw err;
  }
}

export interface SelectionActionDeps extends DeleteSelectionDeps {
  board: LockableBoard & DeletableBoard;
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
      requestDeleteSelected(deps);
    },
  };
}

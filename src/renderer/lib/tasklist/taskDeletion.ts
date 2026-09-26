import type {
  TaskListBoard as TaskListBoardType,
  Tile,
} from '../../schema/index';
import { historyStore, type Command } from '../../stores/history.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import {
  BatchCommand,
  DeleteTaskCommand,
  UpdateTaskFieldCommand,
} from '../../commands/index';
import { collectDescendantIds } from './blockMove';
import { withDrainedWrites, PendingWritesFailedError } from '../vault/vaultOperations';
import { normalizePath } from '../utils/path';
import type { TaskRow } from '../tasks/taskListModel';

/**
 * Task-deletion slice for TaskListBoard. Owns single-row deletion (with the
 * subtask cascade context menu), the "delete all completed" bulk path, and
 * the unparent-children helper used when the user keeps subtasks as
 * top-level after deleting their parent. The bulk-selection delete lives
 * in the orchestrator because it depends on transient `selectedTaskIds`.
 *
 * Mirrors the kanban deletion pattern: factory takes accessors so it never
 * captures stale board / rows state. `buildTaskFieldCommand` is injected
 * because it's owned by the frontmatter writer slice and reused here for
 * the cascade's "keep subtasks" branch (clears `parent` on each child).
 */

/**
 * Orders tile ids for a batch of `DeleteTaskCommand`s: DESCENDING placement
 * position. Each command snapshots its absolute position and the section
 * slices when constructed, and BatchCommand undoes in reverse, so only a
 * descending batch re-inserts the lowest position first and lands every row
 * (and the section boundaries) exactly where it was.
 */
export function orderForBatchDelete(boardId: string, tileIds: readonly string[]): string[] {
  const tasks = (boardCacheStore.cache[boardId]?.board as TaskListBoardType | undefined)?.tasks ?? [];
  const pos = new Map(tasks.map((p) => [p.tileId, p.position] as const));
  return [...tileIds].sort((a, b) => (pos.get(b) ?? -1) - (pos.get(a) ?? -1));
}

export interface TaskDeletionDeps {
  getBoard: () => TaskListBoardType | null;
  getRows: () => TaskRow[];
  getTilesById: () => Record<string, Tile>;
  /**
   * Builds an UpdateTaskFieldCommand for the "keep subtasks" branch.
   * Returns null when the tile has no notePath (predates live-cache
   * architecture); callers fall back to the placement-only delete.
   */
  buildTaskFieldCommand: (
    row: TaskRow,
    patch: Record<string, unknown>,
    description?: string,
  ) => UpdateTaskFieldCommand | null;
  tickAndPersist: () => void;
  announce: (message: string) => void;
  /**
   * Drops just-deleted tile ids from the multi-select set so the action
   * bar's "N selected" count + anchor don't go stale. Optional: the selection
   * lives in the host's MultiSelectController, which isn't visible to this slice.
   */
  pruneSelection?: (ids: string[]) => void;
}

export interface TaskDeleter {
  deleteTaskPlacementOnly(tileId: string): void;
  deleteTask(tileId: string, anchor?: { x: number; y: number }): void;
  deleteTaskWithFile(tileId: string): void;
  unparentChildren(parentId: string): void;
  deleteAllCompleted(): void;
}

export function makeTaskDeleter(deps: TaskDeletionDeps): TaskDeleter {
  const {
    getBoard,
    getRows,
    getTilesById,
    buildTaskFieldCommand,
    tickAndPersist,
    announce,
    pruneSelection,
  } = deps;

  function deleteTaskPlacementOnly(tileId: string): void {
    const board = getBoard();
    if (!board) return;
    const tilesById = getTilesById();
    const titleForAnnounce = tilesById[tileId]?.title ?? 'Task';
    historyStore.execute(new DeleteTaskCommand(board.id, tileId));
    tickAndPersist();
    pruneSelection?.([tileId]);
    announce(`Task removed: ${titleForAnnounce}`);
  }

  /**
   * Removes a child's `parent` frontmatter pointer so it surfaces as a
   * top-level task. Used by the cascade-delete prompt's "keep subtasks"
   * branch — clearing the dangling reference avoids leaving children with
   * a pointer to a tile that no longer exists.
   */
  function unparentChildren(parentId: string): void {
    const rows = getRows();
    const directKids = rows.filter((r) => r.parent === parentId);
    for (const child of directKids) {
      const cmd = buildTaskFieldCommand(child, { parent: '' });
      if (cmd) historyStore.execute(cmd);
    }
  }

  function deleteTask(tileId: string, anchor?: { x: number; y: number }): void {
    const board = getBoard();
    if (!board) return;
    const rows = getRows();
    const descendants = collectDescendantIds(rows, tileId);
    const childCount = descendants.length - 1;
    if (childCount === 0) {
      deleteTaskPlacementOnly(tileId);
      return;
    }
    const x = anchor?.x ?? Math.round(window.innerWidth / 2);
    const y = anchor?.y ?? Math.round(window.innerHeight / 2);
    uiStore.showContextMenu(x, y, [
      {
        id: 'delete-all',
        label: `Delete task and ${childCount} subtask${childCount === 1 ? '' : 's'}`,
        danger: true,
        action: () => {
          const b = getBoard();
          if (!b) return;
          // Descending position (see orderForBatchDelete), bundled into one
          // Command so Ctrl+Z reverses the whole cascade.
          const ordered = orderForBatchDelete(b.id, descendants);
          const cmds = ordered.map((id) => new DeleteTaskCommand(b.id, id));
          historyStore.execute(new BatchCommand(`Delete task + ${childCount} subtasks`, cmds));
          tickAndPersist();
          pruneSelection?.(descendants); // parent + every removed subtask
          announce(`Task and ${childCount} subtask${childCount === 1 ? '' : 's'} removed`);
        },
      },
      {
        id: 'keep-subtasks',
        label: 'Delete task, keep subtasks as top-level',
        action: () => {
          const b = getBoard();
          if (!b) return;
          const liveRows = getRows();
          const directKids = liveRows.filter((r) => r.parent === tileId);
          const cmds: Command[] = [];
          for (const child of directKids) {
            const cmd = buildTaskFieldCommand(child, { parent: '' }, 'Unparent subtask');
            if (cmd) cmds.push(cmd);
          }
          cmds.push(new DeleteTaskCommand(b.id, tileId));
          historyStore.execute(new BatchCommand(`Delete task (keep subtasks)`, cmds));
          tickAndPersist();
          pruneSelection?.([tileId]); // only the parent is removed; kids stay
          announce(
            `Task removed; ${directKids.length} subtask${directKids.length === 1 ? '' : 's'} kept`,
          );
        },
      },
      { id: 'sep', label: '', divider: true },
      { id: 'cancel', label: 'Cancel', action: () => {} },
    ]);
  }

  function deleteAllCompleted(): void {
    const board = getBoard();
    if (!board) return;
    // Derive the completed set from the already-projected `rows`, whose
    // `completed` flag is read note-store-first (live, set synchronously by
    // toggleCompleted) with a vaultIndex fallback. `vaultIndexStore` alone lags
    // ~300 ms behind a just-checked task, so a check-then-bulk-delete could
    // silently skip it. `rows` is
    // the UNFILTERED projection, so a hide-completed view filter doesn't
    // narrow what this bulk action sees.
    const completedTileIds = getRows()
      .filter((r) => r.completed)
      .map((r) => r.placement.tileId);
    if (completedTileIds.length === 0) {
      uiStore.toast('No completed tasks to delete', 'info', 2000);
      return;
    }
    uiStore.openConfirm({
      title: 'Delete completed tasks',
      body: `Delete ${completedTileIds.length} completed task${completedTileIds.length === 1 ? '' : 's'}? Their backing files remain in the vault.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        const b = getBoard();
        if (!b) return;
        // Bundle into a single Command so Ctrl+Z restores the whole batch.
        const cmds: Command[] = orderForBatchDelete(b.id, completedTileIds).map(
          (id) => new DeleteTaskCommand(b.id, id),
        );
        historyStore.execute(new BatchCommand(`Delete ${cmds.length} completed tasks`, cmds));
        tickAndPersist();
        pruneSelection?.(completedTileIds);
        uiStore.toast(
          `${completedTileIds.length} task${completedTileIds.length === 1 ? '' : 's'} removed`,
          'success',
          2000,
        );
      },
    });
  }

  /**
   * Opt-in "delete the backing file too" path. The default delete keeps the
   * `.md` (and is instant + one-click); this confirms first because removing
   * the file breaks every other tile showing it. The note moves to Filo's
   * trash, and undo moves it back.
   */
  function deleteTaskWithFile(tileId: string): void {
    const board = getBoard();
    if (!board) return;
    const tile = getTilesById()[tileId];
    if (!tile) return;
    const title = tile.title || 'task';
    uiStore.openConfirm({
      title: 'Delete task and file',
      body: `"${title}" is removed and its .md file moves to Filo's trash. Any other tile showing the note becomes a broken link. Undo restores both, or restore the file from Settings → Trash.`,
      confirmLabel: 'Delete task & file',
      danger: true,
      onConfirm: () => {
        void performTaskFileDelete(board.id, tileId, tile);
      },
    });
  }

  async function performTaskFileDelete(boardId: string, tileId: string, tile: Tile): Promise<void> {
    const vaultRoot = normalizePath(vaultStore.path);
    try {
      // Drain pending writes first, so nothing queued for the note can
      // recreate it after it moved to the trash.
      // Only a failed write to the note being trashed blocks the delete.
      const filePath = tile.type === 'text' && tile.filePath ? tile.filePath : undefined;
      let executed: Promise<void> = Promise.resolve();
      await withDrainedWrites(async (drain) => {
        // Started here but awaited outside: the history chain may still be
        // running an earlier undo whose restore waits for this op to finish,
        // so awaiting the chain inside the op would deadlock. The trash move
        // runs under this drain if it starts while the op still holds it, and
        // drains for itself otherwise.
        executed = historyStore.execute(new DeleteTaskCommand(boardId, tileId, filePath ? { filePath, vaultRoot, drain } : {}));
      }, { paths: filePath ? [filePath] : [] });
      await executed;
      tickAndPersist();
      pruneSelection?.([tileId]);
      announce(`Task removed: ${tile.title || 'task'}`);
    } catch (err) {
      if (err instanceof PendingWritesFailedError) return;
      throw err;
    }
  }

  return {
    deleteTaskPlacementOnly,
    deleteTask,
    deleteTaskWithFile,
    unparentChildren,
    deleteAllCompleted,
  };
}

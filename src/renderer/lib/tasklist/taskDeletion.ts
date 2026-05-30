import type {
  TaskListBoard as TaskListBoardType,
  Tile,
} from '../../schema/index';
import { historyStore, type Command } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { documentStore } from '../../stores/document.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import {
  BatchCommand,
  DeleteTaskCommand,
  UpdateTaskFieldCommand,
} from '../../commands/index';
import { collectDescendantIds } from './blockMove';
import { buildDeleteSnapshots } from '../canvas/deleteTileSnapshots';
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

export interface TaskDeletionDeps {
  getBoard: () => TaskListBoardType | null;
  getRows: () => TaskRow[];
  getTilesById: () => Record<string, Tile>;
  /**
   * Builds an UpdateTaskFieldCommand for the "keep subtasks" branch.
   * Returns null when the tile has no docId (predates live-cache
   * architecture); callers fall back to the placement-only delete.
   */
  buildTaskFieldCommand: (
    row: TaskRow,
    patch: Record<string, unknown>,
    description?: string,
  ) => UpdateTaskFieldCommand | null;
  tickAndPersist: () => void;
  announce: (message: string) => void;
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
  } = deps;

  function deleteTaskPlacementOnly(tileId: string): void {
    const board = getBoard();
    if (!board) return;
    const tilesById = getTilesById();
    const titleForAnnounce = tilesById[tileId]?.title ?? 'Task';
    historyStore.execute(new DeleteTaskCommand(board.id, tileId));
    tickAndPersist();
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
          // Children first so the parent's snapshot of its child placements
          // isn't already empty by the time we capture it. Bundle into one
          // Command so Ctrl+Z reverses the whole cascade.
          const ordered = [...descendants].reverse();
          const cmds = ordered.map((id) => new DeleteTaskCommand(b.id, id));
          historyStore.execute(new BatchCommand(`Delete task + ${childCount} subtasks`, cmds));
          tickAndPersist();
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
    // Audit 5.2 — derive the completed set from the already-projected
    // `rows`, whose `completed` flag is read documentStore-first (live, set
    // synchronously by toggleCompleted) with a vaultIndex fallback. Reading
    // `vaultIndexStore` directly here lagged ~300 ms behind a just-checked
    // task, so a check-then-bulk-delete could silently skip it. `rows` is
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
        const cmds: Command[] = completedTileIds.map(
          (id) => new DeleteTaskCommand(b.id, id),
        );
        historyStore.execute(new BatchCommand(`Delete ${cmds.length} completed tasks`, cmds));
        tickAndPersist();
        uiStore.toast(
          `${completedTileIds.length} task${completedTileIds.length === 1 ? '' : 's'} removed`,
          'success',
          2000,
        );
      },
    });
  }

  /**
   * Audit 5.7 — opt-in "delete the backing file too" path. The default delete
   * keeps the `.md` (and is instant + one-click); this confirms first because
   * removing the file is the heavy, broken-ref-causing action. It pre-reads the
   * body so a DeleteTaskCommand that owns the disk delete can restore it on undo.
   */
  function deleteTaskWithFile(tileId: string): void {
    const board = getBoard();
    if (!board) return;
    const tile = getTilesById()[tileId];
    if (!tile) return;
    const title = tile.title || 'task';
    uiStore.openConfirm({
      title: 'Delete task and file',
      body: `Delete "${title}" and its backing .md file from the vault? Any other tile or board referencing it becomes a broken link. Ctrl+Z restores both.`,
      confirmLabel: 'Delete task & file',
      danger: true,
      onConfirm: () => {
        void performTaskFileDelete(board.id, tileId, tile);
      },
    });
  }

  async function performTaskFileDelete(boardId: string, tileId: string, tile: Tile): Promise<void> {
    const vaultRoot = normalizePath(vaultStore.path);
    const contentId = (tile as Tile & { contentId?: string }).contentId ?? tileId;
    try {
      // Drain pending editor writes BEFORE snapshotting so the captured body
      // reflects post-flush disk state (mirrors TileHeader's delete path).
      await withDrainedWrites(async () => {
        const { fileSnapshots, oversizedPaths } = await buildDeleteSnapshots([tile], vaultRoot);
        const snapshot = fileSnapshots[0];
        if (!snapshot) {
          // Never delete a file we can't restore on undo: fall back to a
          // placement-only delete and tell the user the file was kept.
          uiStore.toast(
            oversizedPaths.length > 0
              ? 'Backing file is too large for an undo snapshot — removed the task only (file kept).'
              : 'Backing file not found — removed the task only.',
            'warning',
            6000,
          );
          await historyStore.execute(new DeleteTaskCommand(boardId, tileId));
        } else {
          // Unload the doc so an open editor can't rewrite the file we delete.
          documentStore.unloadDocument(contentId);
          await historyStore.execute(
            new DeleteTaskCommand(boardId, tileId, { fileSnapshot: snapshot, vaultRoot }),
          );
        }
        tickAndPersist();
        announce(`Task removed: ${tile.title || 'task'}`);
      });
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

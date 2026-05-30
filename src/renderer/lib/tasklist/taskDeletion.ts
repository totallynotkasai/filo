import type {
  TaskListBoard as TaskListBoardType,
  TaskPlacement,
  Tile,
} from '../../schema/index';
import { historyStore, type Command } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import {
  BatchCommand,
  DeleteTaskCommand,
  UpdateTaskFieldCommand,
} from '../../commands/index';
import { collectDescendantIds } from './blockMove';
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
  getPlacements: () => TaskPlacement[];
  getTilesById: () => Record<string, Tile>;
  /**
   * Resolves the tile's canonical vault-relative `.md` path. Injected from
   * the host so deletion stays consistent with the other slices (rename /
   * frontmatter writer) which all funnel through the same resolver.
   */
  vaultPathForTile: (tile: Tile) => string;
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
  unparentChildren(parentId: string): void;
  deleteAllCompleted(): void;
}

export function makeTaskDeleter(deps: TaskDeletionDeps): TaskDeleter {
  const {
    getBoard,
    getRows,
    getPlacements,
    getTilesById,
    vaultPathForTile,
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
    const placements = getPlacements();
    const tilesById = getTilesById();
    const completedTileIds: string[] = [];
    for (const placement of placements) {
      const tile = tilesById[placement.tileId];
      if (!tile) continue;
      const path = vaultPathForTile(tile);
      const fm = (vaultIndexStore.getMetadata(path)?.frontmatter ?? {}) as Record<
        string,
        unknown
      >;
      if (fm.completed) completedTileIds.push(placement.tileId);
    }
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

  return {
    deleteTaskPlacementOnly,
    deleteTask,
    unparentChildren,
    deleteAllCompleted,
  };
}

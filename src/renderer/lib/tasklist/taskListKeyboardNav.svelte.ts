/**
 * TaskListKeyboardNav — keyboard navigation + row reorder controller.
 *
 * Owns ↑/↓ row focus stepping, Tab/Shift+Tab indent/outdent, and Alt+Up /
 * Alt+Down row reorder (`moveFocusedRow`). The capture-phase keydown
 * handler bound to the board's scroll container is exposed as
 * `handleBoardKeydown` so the host's `$effect` can register / unregister
 * it cleanly on board switch.
 *
 * Why a controller class:
 *   The keyboard nav handlers form a self-contained surface — focus
 *   resolution + row stepping + indent gesture + section-respecting row
 *   reorder. Extracting them as a class keeps the orchestrator focused on
 *   lifecycle wiring and lets `focusedTaskRow` be reused from row prop
 *   callbacks (lock / collapse) and the Tab handler without duplicating
 *   the DOM query.
 *
 * Why the deps closure pattern:
 *   The nav controller needs live reads of `viewModel.rows`,
 *   `viewModel.filteredRows`, `placements`, `sections`, `sortBy`, plus the
 *   host's `snapshotSections` / `updateRowField` / `tickAndPersist`
 *   helpers. Threading them through getters keeps the class free of
 *   cross-store imports.
 */

import type {
  TaskListBoard as TaskListBoardType,
  TaskListSection,
  TaskPlacement,
} from '../../schema/index';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import {
  ReorderTaskWithinSectionCommand,
  BatchCommand,
  UpdateBoardSettingsCommand,
} from '../../commands/index';
import { isEditableTextTarget } from '../utils/editableTarget';
import { collectDescendantIds } from './blockMove';
import { sectionIdForPlacementIndex } from './sectionMath';
import { moveTaskBlock } from '../tasks/taskMove';
import type { SortBy, TaskRow } from '../tasks/taskListModel';

export interface TaskListKeyboardNavDeps {
  getBoard: () => TaskListBoardType | null;
  getRows: () => TaskRow[];
  getFilteredRows: () => TaskRow[];
  getPlacements: () => TaskPlacement[];
  getSections: () => TaskListSection[];
  getSortBy: () => SortBy;
  /** Snapshot for the undo command. */
  snapshotSections: () => { sections: TaskListSection[]; tasks: TaskPlacement[] };
  /** Frontmatter-writer's `updateRowField` — used by Tab/Shift+Tab indent. */
  updateRowField: (row: TaskRow, patch: Record<string, unknown>) => void;
  tickAndPersist: () => void;
  /** Multi-select hooks for Escape handling within the keydown handler. */
  getSelectionSize: () => number;
  clearSelection: () => void;
}

/**
 * Keyboard navigation controller for the Task List board.
 */
export class TaskListKeyboardNav {
  constructor(private deps: TaskListKeyboardNavDeps) {}

  /**
   * Resolves the task row owning the focus / event-target. Prefers an
   * explicit event target (`e.target`) so capture-phase Tab handling stays
   * correct even when focus has already begun to shift to the next focusable
   * element by the time we ask. Falls back to `document.activeElement` for
   * keys that don't migrate focus.
   */
  focusedTaskRow(eventTarget?: EventTarget | null): TaskRow | null {
    const seed = (eventTarget instanceof HTMLElement
      ? eventTarget
      : (document.activeElement as HTMLElement | null));
    if (!seed) return null;
    const el = seed.closest('[data-task-id]') as HTMLElement | null;
    if (!el) return null;
    const id = el.dataset.taskId;
    if (!id) return null;
    return this.deps.getRows().find((r) => r.tile.id === id) ?? null;
  }

  focusRowById(tileId: string): void {
    const el = document.querySelector<HTMLElement>(`.task-item[data-task-id="${tileId}"]`);
    el?.focus();
  }

  moveFocus(delta: 1 | -1): void {
    const ids = this.deps.getFilteredRows().map((r) => r.tile.id);
    if (ids.length === 0) return;
    const focused = this.focusedTaskRow();
    if (!focused) {
      const targetId = delta > 0 ? ids[0] : ids[ids.length - 1];
      if (targetId) this.focusRowById(targetId); // ids non-empty (checked above)
      return;
    }
    const idx = ids.indexOf(focused.tile.id);
    if (idx < 0) {
      const first = ids[0];
      if (first) this.focusRowById(first);
      return;
    }
    const nextIdx = Math.max(0, Math.min(ids.length - 1, idx + delta));
    const next = ids[nextIdx];
    if (next) this.focusRowById(next);
  }

  indentFocused(row: TaskRow, outdent: boolean): void {
    if (outdent) {
      if (row.parent) this.deps.updateRowField(row, { parent: '' });
      return;
    }
    // Indent under the visible row directly above the focused row.
    const ids = this.deps.getFilteredRows().map((r) => r.tile.id);
    const idx = ids.indexOf(row.tile.id);
    if (idx <= 0) return;
    const newParentId = ids[idx - 1];
    if (!newParentId) return; // idx > 0 and < ids.length; narrow for the type-checker
    // Cycle guard: target cannot be a descendant of focused.
    if (collectDescendantIds(this.deps.getRows(), row.tile.id).includes(newParentId)) return;
    if (row.parent === newParentId) return;
    this.deps.updateRowField(row, { parent: newParentId });
  }

  /**
   * Move the focused row (with its descendants) by one position within its
   * current section. Bound to Alt+Up / Alt+Down. Mirrors the drag-reorder UX
   * at `commitReorder` — under a non-manual sort, silently switches to manual
   * with an Undo toast that restores both the order and the prior sort mode.
   */
  moveFocusedRow(direction: -1 | 1): void {
    const board = this.deps.getBoard();
    if (!board) return;
    const focused = this.focusedTaskRow();
    if (!focused) return;
    const tileId = focused.tile.id;
    const placements = this.deps.getPlacements();
    const sections = this.deps.getSections();
    const placementIdx = placements.findIndex((p) => p.tileId === tileId);
    if (placementIdx < 0) return;

    const sectionId = sectionIdForPlacementIndex(sections, placementIdx);
    const sortedLive = [...sections].sort((a, b) => a.position - b.position);
    let sectionStart = 0;
    let sectionEnd = placements.length;
    if (sectionId !== null) {
      const sIdx = sortedLive.findIndex((s) => s.id === sectionId);
      if (sIdx >= 0) {
        sectionStart = sortedLive[sIdx]?.position ?? 0;
        sectionEnd = sortedLive[sIdx + 1]?.position ?? placements.length;
      }
    } else {
      sectionEnd = sortedLive[0]?.position ?? placements.length;
    }
    const sectionSize = sectionEnd - sectionStart;
    const currentOffset = placementIdx - sectionStart;

    const descendantIds = collectDescendantIds(this.deps.getRows(), tileId).filter((id) => id !== tileId);
    const blockSize = 1 + descendantIds.length;

    let targetOffset: number;
    if (direction < 0) {
      if (currentOffset <= 0) return;
      targetOffset = currentOffset - 1;
    } else {
      if (currentOffset + blockSize >= sectionSize) return;
      targetOffset = currentOffset + 1;
    }

    const beforeMove = this.deps.snapshotSections();
    const { placements: nextPlacements, sections: nextSections } = moveTaskBlock({
      placements,
      sections,
      draggedId: tileId,
      descendantIds,
      targetSectionId: sectionId,
      insertOffset: targetOffset,
    });

    // Same-section reorder under a non-manual sort: switch to manual AND the
    // reorder in one BatchCommand so a single Ctrl+Z reverses both. Phase 7
    // / 7.1 — previously the sortBy flip wrote directly through
    // `boardStore.updateSettings` and the Toast "Undo" had to fire two
    // separate ops to restore the prior state.
    const sortBy = this.deps.getSortBy();
    const reorderCmd = new ReorderTaskWithinSectionCommand(
      board.id,
      beforeMove,
      { sections: nextSections, tasks: nextPlacements },
      direction,
    );
    if (sortBy !== 'manual') {
      const sortCmd = new UpdateBoardSettingsCommand(
        { sortBy: 'manual' },
        { sortBy },
        [],
        'Switch to Manual sort',
      );
      historyStore.execute(
        new BatchCommand('Reorder task (Manual sort)', [sortCmd, reorderCmd]),
      );
      uiStore.pushToast({
        text: 'Switched to Manual sort to reorder tasks',
        type: 'info',
        duration: 4000,
        actions: [
          {
            label: 'Undo',
            handler: () => {
              historyStore.undo();
            },
          },
        ],
      });
    } else {
      historyStore.execute(reorderCmd);
    }
    this.deps.tickAndPersist();
    // Keep keyboard focus on the moved row.
    queueMicrotask(() => this.focusRowById(tileId));
  }

  /**
   * Capture-phase keydown handler bound to this board's scroll container.
   * Capture (not bubble) intercepts Tab BEFORE the browser's native focus
   * stepping kicks in — without that, pressing Tab while a row's sub-button
   * has focus moves focus to the next button outside the board, since the
   * bubble-phase preventDefault arrives too late for some focus-traversal
   * paths. Scoped to the container so a multi-tab layout doesn't see two
   * boards racing for the same keystroke.
   */
  handleBoardKeydown = (e: KeyboardEvent): void => {
    // Skip while the user is typing into an editor field.
    if (isEditableTextTarget(e.target)) {
      if (e.key === 'Escape') {
        if (this.deps.getSelectionSize() > 0) {
          e.preventDefault();
          this.deps.clearSelection();
        }
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.moveFocus(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.moveFocus(-1);
      return;
    }
    if (e.key === 'Tab') {
      // Resolve the row via the event target rather than activeElement —
      // capture-phase fires before any focus shift, but using the target
      // here keeps the resolution robust if a sub-handler ever defers.
      const focused = this.focusedTaskRow(e.target);
      if (!focused) return;
      e.preventDefault();
      e.stopPropagation();
      this.indentFocused(focused, e.shiftKey);
      return;
    }
    if (e.key === 'Escape' && this.deps.getSelectionSize() > 0) {
      e.preventDefault();
      this.deps.clearSelection();
    }
  };
}

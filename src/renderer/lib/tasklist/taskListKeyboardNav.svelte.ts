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
 *   host's `snapshotSections` / `commitIndent` / `tickAndPersist`
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
import { ReorderTaskWithinSectionCommand } from '../../commands/index';
import { executeReorderSwitchingToManual } from './manualSortSwitch';
import { isEditableTextTarget } from '../utils/editableTarget';
import { collectDescendantIds } from './blockMove';
import { sectionIdForPlacementIndex } from './sectionMath';
import { indentProblem } from './indentRules';
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
  /** The drag's indent / outdent (an undoable parent edit that expands a
   *  collapsed new parent), used by Tab / Shift+Tab. */
  commitIndent: (tileId: string, newParent: string) => void;
  commitOutdent: (tileId: string) => void;
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

  /**
   * Tab / Shift+Tab on a focused row. Returns false when there is nothing to
   * indent or outdent (the first row, a row already under the one above, a
   * top-level row on Shift+Tab): the key then moves focus as usual, so Tab
   * never traps keyboard users on the list.
   */
  indentFocused(row: TaskRow, outdent: boolean): boolean {
    if (outdent) {
      if (!row.parent) return false;
      this.deps.commitOutdent(row.tile.id);
      return true;
    }
    // Indent under the visible row directly above the focused row, by the
    // same rules as a drag: same section, no cycle, three levels at most.
    const ids = this.deps.getFilteredRows().map((r) => r.tile.id);
    const idx = ids.indexOf(row.tile.id);
    if (idx <= 0) return false;
    const newParentId = ids[idx - 1];
    if (!newParentId) return false; // idx > 0 and < ids.length; narrow for the type-checker
    if (row.parent === newParentId) return false;
    const problem = indentProblem({
      rows: this.deps.getRows(),
      placements: this.deps.getPlacements(),
      sections: this.deps.getSections(),
      tileId: row.tile.id,
      newParentId,
    });
    if (problem) {
      uiStore.toast(problem, 'info', 1800);
      return true;
    }
    this.deps.commitIndent(row.tile.id, newParentId);
    return true;
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
    // The reorder stays inside the current section, so only descendants
    // whose placement actually sits in [sectionStart, sectionEnd) belong to the
    // moving block. Counting ALL descendants (a leaf reachable via a legacy
    // placement↔parent divergence could live in another section) would inflate
    // blockSize and wrongly block an in-bounds move; the move itself likewise
    // only shifts the in-section block.
    const blockDescendantIds = descendantIds.filter((id) => {
      const i = placements.findIndex((p) => p.tileId === id);
      return i >= sectionStart && i < sectionEnd;
    });
    const blockSize = 1 + blockDescendantIds.length;

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
      descendantIds: blockDescendantIds,
      targetSectionId: sectionId,
      insertOffset: targetOffset,
    });

    // Same-section reorder under a non-manual sort: switch to manual AND the
    // reorder in one BatchCommand so a single Ctrl+Z reverses both.
    const sortBy = this.deps.getSortBy();
    const reorderCmd = new ReorderTaskWithinSectionCommand(
      board.id,
      beforeMove,
      { sections: nextSections, tasks: nextPlacements },
      direction,
    );
    if (sortBy !== 'manual') {
      executeReorderSwitchingToManual(reorderCmd, sortBy);
    } else {
      historyStore.execute(reorderCmd);
    }
    this.deps.tickAndPersist();
    // Keep keyboard focus on the moved row.
    queueMicrotask(() => this.focusRowById(tileId));
  }

  /**
   * Capture-phase keydown handler bound to this board's scroll container.
   * Capture (not bubble) intercepts Tab on a focused row BEFORE the
   * browser's native focus stepping kicks in, since the bubble-phase
   * preventDefault arrives too late for some focus-traversal paths. Scoped to the container so a multi-tab layout doesn't see two
   * boards racing for the same keystroke.
   */
  handleBoardKeydown = (e: KeyboardEvent): void => {
    // A key something else already handled must not act twice.
    if (e.defaultPrevented) return;
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
      // Only the row itself indents: Tab from one of its buttons steps on
      // to the next control, as everywhere else.
      if (!(e.target instanceof HTMLElement) || !e.target.classList.contains('task-item')) return;
      if (this.indentFocused(focused, e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === 'Escape' && this.deps.getSelectionSize() > 0) {
      e.preventDefault();
      this.deps.clearSelection();
    }
  };
}

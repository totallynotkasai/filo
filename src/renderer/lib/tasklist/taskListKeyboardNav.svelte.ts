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
 *   `viewModel.renderedRows`, `placements`, `sections`, `sortBy`, plus the
 *   host's `snapshotSections` / `commitIndent` / `tickAndPersist`
 *   helpers. Threading them through getters keeps the class free of
 *   cross-store imports.
 */

import type {
  TaskListBoard as TaskListBoardType,
  TaskListSection,
  TaskPlacement,
} from '../../schema/index';
import { tick } from 'svelte';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { ReorderTaskWithinSectionCommand } from '../../commands/index';
import { executeReorderSwitchingToManual } from './manualSortSwitch';
import { isEditableTextTarget } from '../utils/editableTarget';
import { rebuildPlacementsFromDndItems, sameTileIds, type RowDndItem } from './blockMove';
import { indentProblem } from './indentRules';
import { drawnRows, indentParentFor, movedOrder } from './rowMoves';
import type { FlatSection } from './taskListViewModel.svelte';
import type { SortBy, TaskRow } from '../tasks/taskListModel';

export interface TaskListKeyboardNavDeps {
  getBoard: () => TaskListBoardType | null;
  getRows: () => TaskRow[];
  /** The rows on screen, top to bottom (`TaskListViewModel.renderedRows`). */
  getRenderedRows: () => TaskRow[];
  /** Each section's rows as drawn (`TaskListViewModel.flatSections`). */
  getFlatSections: () => FlatSection[];
  /** The id the drawn leading "Unsectioned" bucket goes by. */
  getLeadingSectionId: () => string;
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

  /** Arrow keys: the next row on screen (a folded section's or parent's rows aren't on it). */
  moveFocus(delta: 1 | -1): void {
    const ids = this.deps.getRenderedRows().map((r) => r.tile.id);
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

  /** The drawn section holding `tileId`, or undefined when it isn't drawn. */
  private drawnSectionOf(tileId: string): FlatSection | undefined {
    return this.deps.getFlatSections().find((s) => !s.collapsed && s.entries.some((e) => e.row.tile.id === tileId));
  }

  /**
   * Tab / Shift+Tab on a focused row. Tab indents one level, under the row
   * drawn above at the same level (`indentParentFor`); Shift+Tab outdents a
   * subtask. Returns false when the row doesn't move (no row at its level
   * above it, a refused indent, a top-level row on Shift+Tab): the key then
   * moves focus as usual, so Tab never traps keyboard users on the list.
   */
  indentFocused(row: TaskRow, outdent: boolean): boolean {
    if (outdent) {
      if (!row.parent) return false;
      this.deps.commitOutdent(row.tile.id);
      return true;
    }
    const section = this.drawnSectionOf(row.tile.id);
    const newParentId = section ? indentParentFor(drawnRows(section.entries), row.tile.id) : null;
    if (!newParentId || row.parent === newParentId) return false;
    // The drag's rules too: same section, no cycle, three levels at most.
    const problem = indentProblem({
      rows: this.deps.getRows(),
      placements: this.deps.getPlacements(),
      sections: this.deps.getSections(),
      tileId: row.tile.id,
      newParentId,
    });
    if (problem) {
      uiStore.toast(problem, 'info', 1800);
      return false;
    }
    this.deps.commitIndent(row.tile.id, newParentId);
    return true;
  }

  /**
   * Alt+Up / Alt+Down: the focused row, with its subtasks, moves past the
   * row drawn above or below it at the same level (`movedOrder`), so one
   * press moves it one place on screen. The list is rebuilt from the order
   * as drawn, as a drop rebuilds it: under a sort other than Manual, that
   * order becomes the manual order, in one undo step with the switch to
   * Manual and a toast that offers Undo. Returns false when the row can't
   * move that way, which leaves the key alone.
   */
  moveFocusedRow(direction: -1 | 1): boolean {
    const board = this.deps.getBoard();
    const focused = this.focusedTaskRow();
    if (!board || !focused) return false;
    const tileId = focused.tile.id;
    const section = this.drawnSectionOf(tileId);
    const order = section ? movedOrder(drawnRows(section.entries), tileId, direction) : null;
    if (!section || !order) return false;

    const flat = this.deps.getFlatSections();
    const itemsBySection: Record<string, RowDndItem[]> = {};
    for (const s of flat) {
      itemsBySection[s.sectionId] = (s === section ? order : s.entries.map((e) => e.row.tile.id)).map((id) => ({ id }));
    }
    const placements = this.deps.getPlacements();
    const next = rebuildPlacementsFromDndItems({
      placements,
      sections: this.deps.getSections(),
      displaySectionIds: flat.map((s) => s.sectionId),
      leadingSectionId: this.deps.getLeadingSectionId(),
      itemsBySection,
    });
    // A move never adds or drops a task.
    if (!sameTileIds(placements, next.placements)) return false;

    const reorderCmd = new ReorderTaskWithinSectionCommand(
      board.id,
      this.deps.snapshotSections(),
      { sections: next.sections, tasks: next.placements },
      direction,
    );
    const sortBy = this.deps.getSortBy();
    const done = sortBy !== 'manual'
      ? executeReorderSwitchingToManual(reorderCmd, sortBy)
      : historyStore.execute(reorderCmd);
    this.deps.tickAndPersist();
    // Keyboard focus stays on the moved row. Moving a focused element in the
    // page drops its focus, so it is given back once the row is in its place.
    void done.catch(() => {}).then(() => tick()).then(() => this.focusRowById(tileId));
    return true;
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
    // A bare arrow moves the focus; Alt+Up / Alt+Down are the move-task
    // commands, which act on the row the focus is on now.
    const bare = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (e.key === 'ArrowDown' && bare) {
      e.preventDefault();
      this.moveFocus(1);
      return;
    }
    if (e.key === 'ArrowUp' && bare) {
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

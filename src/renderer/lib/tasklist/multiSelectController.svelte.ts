/**
 * MultiSelectController — owns the Task List's transient row selection plus
 * the bulk-action handlers fired from the floating action bar.
 *
 * Why a controller class:
 *   Selection state is UI-only and surface-local (canvas / kanban / task list
 *   each scope their own selections), so it doesn't belong in
 *   `selectionStore`. The host file used to declare ~170 LOC of selection
 *   state + bulk handlers inline; moving them into a class with `$state`
 *   fields keeps reactivity intact (instance `$state` is rune-tracked when
 *   the class is declared in `.svelte.ts` and instantiated in the host's
 *   `<script>` block) while shrinking the orchestrator.
 *
 * Why the deps closure pattern:
 *   `bulkApplyFieldPatch` needs `buildTaskFieldCommand` (owned by the
 *   frontmatter writer slice) and the live `viewModel.rows`. Threading them
 *   through getters keeps the controller free of cross-slice imports and
 *   matches the convention set by `taskCreation.ts` /
 *   `taskDeletion.ts` / `kanbanMultiSelect.svelte.ts`.
 */

import { SvelteSet } from 'svelte/reactivity';
import type {
  TaskListBoard as TaskListBoardType,
  TaskListSection,
  TaskPlacement,
} from '../../schema/index';
import { historyStore, type Command } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import {
  BatchCommand,
  DeleteTaskCommand,
  MoveTaskBlockCommand,
  UpdateTaskFieldCommand,
} from '../../commands/index';
import type { Priority } from '../tasks/frontmatterReaders';
import type { TaskRow } from '../tasks/taskListModel';
import { moveTaskBlock } from '../tasks/taskMove';
import { sectionIdForPlacementIndex } from './sectionMath';
import { resolveDragBlockIds } from './blockMove';

export interface MultiSelectControllerDeps {
  getBoard: () => TaskListBoardType | null;
  getRows: () => TaskRow[];
  getFilteredRows: () => TaskRow[];
  /** Live placements for the active board, in render order. */
  getPlacements: () => TaskPlacement[];
  /** Live persisted sections (excluding the synthetic leading + default). */
  getSections: () => TaskListSection[];
  /**
   * Builds an UpdateTaskFieldCommand for one row. Returns null when the tile
   * has no docId; bulk callers skip those rows so a missing docId never
   * aborts the whole batch.
   */
  buildTaskFieldCommand: (
    row: TaskRow,
    patch: Record<string, unknown>,
    description?: string,
  ) => UpdateTaskFieldCommand | null;
  /** Bumps the host's reactivity tick after a bulk frontmatter mutation. */
  bumpCacheVersion: () => void;
  /** Persists structural changes + bumps the cache version (used by bulkDelete). */
  tickAndPersist: () => void;
  /** Screen-reader announcer. */
  announce: (message: string) => void;
  /**
   * Materialises the synthetic default section into a real one and returns
   * its id. Bulk move-to-section uses this when the target is the legacy
   * "no sections persisted yet" sentinel.
   */
  ensureDefaultSectionMaterialized?: () => string | null;
}

/**
 * Multi-select controller for the Task List board.
 *
 * Owns the selection anchor (`lastSelectedTaskId`) used by Shift-click range
 * selection plus the bulk-action handlers wired into TaskBulkActionBar.
 */
export class MultiSelectController {
  selectedTaskIds = $state(new SvelteSet<string>());
  lastSelectedTaskId = $state<string | null>(null);

  constructor(private deps: MultiSelectControllerDeps) {}

  handleRowSelect(tileId: string, mods: { shift: boolean; ctrl: boolean }): void {
    const ids = this.deps.getFilteredRows().map((r) => r.tile.id);
    if (mods.shift && this.lastSelectedTaskId) {
      const anchorIdx = ids.indexOf(this.lastSelectedTaskId);
      const targetIdx = ids.indexOf(tileId);
      if (anchorIdx >= 0 && targetIdx >= 0) {
        const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
        const next = new SvelteSet(this.selectedTaskIds);
        for (const id of ids.slice(lo, hi + 1)) next.add(id);
        this.selectedTaskIds = next;
        return;
      }
    }
    if (mods.ctrl) {
      const next = new SvelteSet(this.selectedTaskIds);
      if (next.has(tileId)) next.delete(tileId);
      else next.add(tileId);
      this.selectedTaskIds = next;
      this.lastSelectedTaskId = next.has(tileId) ? tileId : null;
      return;
    }
    // Plain click: replace, or toggle off if it was the lone selection.
    if (this.selectedTaskIds.size === 1 && this.selectedTaskIds.has(tileId)) {
      this.selectedTaskIds = new SvelteSet();
      this.lastSelectedTaskId = null;
      return;
    }
    this.selectedTaskIds = new SvelteSet([tileId]);
    this.lastSelectedTaskId = tileId;
  }

  clearSelection(): void {
    if (this.selectedTaskIds.size === 0) return;
    this.selectedTaskIds = new SvelteSet();
    this.lastSelectedTaskId = null;
  }

  /** Resolves the rows currently selected, in the canonical `rows` order. */
  selectedRows(): TaskRow[] {
    if (this.selectedTaskIds.size === 0) return [];
    const ids = this.selectedTaskIds;
    return this.deps.getRows().filter((r) => ids.has(r.tile.id));
  }

  /**
   * Builds and runs a BatchCommand of UpdateTaskFieldCommand entries — one per
   * selected row whose `perRowPatch` returns a non-null patch. Returns the
   * count of rows that were touched.
   */
  bulkApplyFieldPatch(
    sel: TaskRow[],
    perRowPatch: (r: TaskRow) => Record<string, unknown> | null,
    description: string,
  ): number {
    const board = this.deps.getBoard();
    if (!board || sel.length === 0) return 0;
    const cmds: UpdateTaskFieldCommand[] = [];
    for (const r of sel) {
      const patch = perRowPatch(r);
      if (!patch) continue;
      const cmd = this.deps.buildTaskFieldCommand(r, patch, description);
      if (cmd) cmds.push(cmd);
    }
    if (cmds.length === 0) return 0;
    historyStore.execute(new BatchCommand(description, cmds));
    this.deps.bumpCacheVersion();
    return cmds.length;
  }

  bulkSetPriority(p: Priority): void {
    const sel = this.selectedRows();
    const touched = this.bulkApplyFieldPatch(
      sel,
      () => ({ priority: p === 'none' ? '' : p }),
      `Set priority on ${sel.length} tasks`,
    );
    if (touched > 0) {
      uiStore.toast(`Priority set on ${touched} task${touched === 1 ? '' : 's'}`, 'success', 1800);
      this.deps.announce(`Priority set on ${touched} task${touched === 1 ? '' : 's'}`);
    }
  }

  bulkSetDueDate(iso: string): void {
    const sel = this.selectedRows();
    const touched = this.bulkApplyFieldPatch(
      sel,
      () => ({ dueDate: iso }),
      iso ? `Set due date on ${sel.length} tasks` : `Clear due date on ${sel.length} tasks`,
    );
    if (touched > 0) {
      uiStore.toast(
        iso
          ? `Due set on ${touched} task${touched === 1 ? '' : 's'}`
          : `Due cleared on ${touched} task${touched === 1 ? '' : 's'}`,
        'success',
        1800,
      );
    }
  }

  bulkMarkComplete(): void {
    const sel = this.selectedRows();
    const touched = this.bulkApplyFieldPatch(
      sel,
      (r) => (r.completed ? null : { completed: true }),
      `Mark ${sel.length} tasks complete`,
    );
    if (touched > 0) {
      const msg = `Marked ${touched} task${touched === 1 ? '' : 's'} complete`;
      uiStore.toast(msg, 'success', 1800);
      this.deps.announce(msg);
    }
  }

  bulkMarkIncomplete(): void {
    const sel = this.selectedRows();
    const touched = this.bulkApplyFieldPatch(
      sel,
      (r) => (r.completed ? { completed: false } : null),
      `Mark ${sel.length} tasks incomplete`,
    );
    if (touched > 0) {
      const msg = `Marked ${touched} task${touched === 1 ? '' : 's'} incomplete`;
      uiStore.toast(msg, 'success', 1800);
      this.deps.announce(msg);
    }
  }

  bulkDelete(): void {
    const sel = this.selectedRows();
    if (sel.length === 0) return;
    uiStore.openConfirm({
      title: 'Delete selected tasks',
      body: `Remove ${sel.length} task${sel.length === 1 ? '' : 's'} from this board? Their backing files remain in the vault.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        const board = this.deps.getBoard();
        if (!board) return;
        // Each placement removal is reversible via the per-tile snapshot in
        // DeleteTaskCommand; the BatchCommand wraps them so a single Ctrl+Z
        // restores every row at once.
        const cmds: Command[] = sel.map((r) => new DeleteTaskCommand(board.id, r.tile.id));
        if (cmds.length === 0) return;
        historyStore.execute(new BatchCommand(`Delete ${cmds.length} tasks`, cmds));
        this.deps.tickAndPersist();
        this.clearSelection();
        const msg = `${sel.length} task${sel.length === 1 ? '' : 's'} removed`;
        uiStore.toast(msg, 'success', 1800);
        this.deps.announce(msg);
      },
    });
  }

  /** Selects every visible row (post-filter). Bound to Ctrl+A. */
  selectAllVisible(): void {
    const next = new SvelteSet<string>();
    for (const r of this.deps.getFilteredRows()) next.add(r.tile.id);
    this.selectedTaskIds = next;
  }

  /**
   * Move every selected task (plus the descendants implied by each selected
   * parent) into `targetSectionId`, appended at the section's tail. Wraps
   * everything in a single `MoveTaskBlockCommand` so one Ctrl+Z reverses the
   * whole bulk move. Mirrors Kanban's `moveSelectedTilesToColumn`.
   *
   * Pass the persisted section id (NOT the synthetic `__default__`
   * sentinel — the caller materialises that first via
   * `ensureDefaultSectionMaterialized`).
   *
   * No-op when:
   *  - no tasks are selected,
   *  - every selected task already lives in the target section,
   *  - the target section can't be resolved (caller dropped the section id).
   */
  bulkMoveToSection(targetSectionId: string): void {
    const board = this.deps.getBoard();
    if (!board) return;
    if (this.selectedTaskIds.size === 0) return;

    let realTargetSectionId: string | null = targetSectionId;
    if (this.deps.ensureDefaultSectionMaterialized) {
      // Caller signals "materialise me" by passing the synthetic id. We don't
      // hard-code it here so the controller doesn't import host constants.
      const maybeMaterialised = this.deps.ensureDefaultSectionMaterialized();
      if (maybeMaterialised) realTargetSectionId = maybeMaterialised;
    }
    if (!realTargetSectionId) return;

    const placements = this.deps.getPlacements();
    const sections = this.deps.getSections();
    const rows = this.deps.getRows();

    // Resolve the full block from the multi-selection — selected tiles plus
    // every descendant of each, ordered by placement to keep the block
    // contiguous after the move. Same helper the drag controller uses.
    const seeds = Array.from(this.selectedTaskIds);
    const blockIds = resolveDragBlockIds(rows, placements, seeds);
    if (blockIds.length === 0) return;

    // Skip the move when every block member already lives in the target.
    const allInTarget = blockIds.every((id) => {
      const idx = placements.findIndex((p) => p.tileId === id);
      return idx >= 0 && sectionIdForPlacementIndex(sections, idx) === realTargetSectionId;
    });
    if (allInTarget) return;

    // Use the first block member as the drag anchor — the move helper places
    // the anchor at `insertOffset` and pulls the rest after it. Append at the
    // section's tail by computing its current size.
    const sectionStart = sections.find((s) => s.id === realTargetSectionId)?.position ?? 0;
    const sectionEnd = (() => {
      const sorted = [...sections].sort((a, b) => a.position - b.position);
      const idx = sorted.findIndex((s) => s.id === realTargetSectionId);
      return sorted[idx + 1]?.position ?? placements.length;
    })();
    const insertOffset = sectionEnd - sectionStart;

    const anchorId = blockIds[0];
    const descendantIds = blockIds.slice(1);

    const before = {
      sections: sections.map((s) => ({ ...s })),
      tasks: placements.map((p) => ({ ...p })),
    };
    const after = moveTaskBlock({
      placements,
      sections,
      draggedId: anchorId,
      descendantIds,
      targetSectionId: realTargetSectionId,
      insertOffset,
    });

    const targetTitle =
      sections.find((s) => s.id === realTargetSectionId)?.title ?? 'section';
    historyStore.execute(
      new MoveTaskBlockCommand(
        board.id,
        before,
        { sections: after.sections, tasks: after.placements },
        `Move ${blockIds.length} task${blockIds.length === 1 ? '' : 's'} to ${targetTitle}`,
      ),
    );
    this.deps.tickAndPersist();
    const msg = `Moved ${blockIds.length} task${blockIds.length === 1 ? '' : 's'} to "${targetTitle}"`;
    uiStore.toast(msg, 'success', 2000);
    this.deps.announce(msg);
  }
}

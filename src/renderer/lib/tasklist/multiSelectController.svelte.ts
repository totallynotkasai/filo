/**
 * MultiSelectController — owns the Task List's transient row selection plus
 * the bulk-action handlers fired from the floating action bar.
 *
 * Why a controller class:
 *   Selection state is UI-only and surface-local (canvas / kanban / task list
 *   each scope their own selections), so it doesn't belong in
 *   `selectionStore`. A class with `$state` fields keeps reactivity intact
 *   (instance `$state` is rune-tracked when the class is declared in
 *   `.svelte.ts` and instantiated in the host's `<script>` block) while
 *   keeping the orchestrator small.
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
import { completionPatchForRow, warnUnreadableRules } from './frontmatterWriter';
import { parseRecurrence } from '../tasks/recurrence';
import { orderForBatchDelete } from './taskDeletion';

import { resolveTextTileVaultPath } from '../boards/textTilePath';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
export interface MultiSelectControllerDeps {
  getBoard: () => TaskListBoardType | null;
  getRows: () => TaskRow[];
  /** The rows on screen, top to bottom (`TaskListViewModel.renderedRows`). */
  getRenderedRows: () => TaskRow[];
  /** Live placements for the active board, in render order. */
  getPlacements: () => TaskPlacement[];
  /** Live persisted sections (excluding the synthetic leading + default). */
  getSections: () => TaskListSection[];
  /**
   * Builds an UpdateTaskFieldCommand for one row. Returns null when the tile
   * has no notePath; bulk callers skip those rows so a missing notePath never
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

  /**
   * A row click. Shift extends from the anchor over the rows between the two
   * on screen, so the range is what the user sees highlighted between them.
   */
  handleRowSelect(tileId: string, mods: { shift: boolean; ctrl: boolean }): void {
    const ids = this.deps.getRenderedRows().map((r) => r.tile.id);
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
      // The anchor was filtered away or deleted (anchorIdx < 0), so there is no
      // range to extend. Don't collapse the selection to the clicked row: ADD it
      // to the current selection and re-anchor here for the next Shift-click.
      if (targetIdx >= 0) {
        const next = new SvelteSet(this.selectedTaskIds);
        next.add(tileId);
        this.selectedTaskIds = next;
        this.lastSelectedTaskId = tileId;
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

  /**
   * Drop ids that no longer correspond to a live row (just-deleted
   * tasks) so the action bar's "N selected" count stays honest and the anchor
   * never points at a removed row. `selectedRows()` already re-intersects live
   * rows for OPERATIONS, so this fixes the displayed count + the stale anchor,
   * not a wrong-tile mutation. Called from the single-row / cascade / delete-&-
   * file paths (which delete outside this controller).
   */
  pruneSelection(removedIds: string[]): void {
    if (removedIds.length === 0 || this.selectedTaskIds.size === 0) return;
    // `removedIds.includes` (not a `new Set`) — the lists are tiny and the
    // `svelte/prefer-svelte-reactivity` rule forbids a plain Set in `.svelte.ts`.
    let changed = false;
    const next = new SvelteSet<string>();
    for (const id of this.selectedTaskIds) {
      if (removedIds.includes(id)) {
        changed = true;
        continue;
      }
      next.add(id);
    }
    if (!changed) return;
    this.selectedTaskIds = next;
    if (this.lastSelectedTaskId && removedIds.includes(this.lastSelectedTaskId)) {
      this.lastSelectedTaskId = null;
    }
  }

  /** Resolves the rows currently selected, in the canonical `rows` order. */
  selectedRows(): TaskRow[] {
    if (this.selectedTaskIds.size === 0) return [];
    const ids = this.selectedTaskIds;
    return this.deps.getRows().filter((r) => ids.has(r.tile.id));
  }

  /**
   * Builds and runs a BatchCommand of UpdateTaskFieldCommand entries — one per
   * selected row whose `perRowPatch` returns a non-null patch.
   *
   * Returns the count of rows touched AND a `settled` promise that resolves
   * `true` only if the command chain resolved. Callers gate
   * their success toast on `settled` so a rejected batch (write failure →
   * execute() rolled back) doesn't claim success; clearSelection /
   * bumpCacheVersion stay synchronous so selection bookkeeping is unaffected.
   */
  bulkApplyFieldPatch(
    sel: TaskRow[],
    perRowPatch: (r: TaskRow) => Record<string, unknown> | null,
    description: string,
  ): { touched: number; settled: Promise<boolean>; command?: BatchCommand } {
    const board = this.deps.getBoard();
    if (!board || sel.length === 0) return { touched: 0, settled: Promise.resolve(true) };
    const cmds: UpdateTaskFieldCommand[] = [];
    // Plain object, not a Set: this is a non-reactive local dedup ledger, and the
    // `svelte/prefer-svelte-reactivity` lint rule forbids `new Set()` in
    // `.svelte.ts` (mirrors the same choice in history.svelte.ts).
    const seenNotePaths: Record<VaultPath, true> = {};
    for (const r of sel) {
      const patch = perRowPatch(r);
      if (!patch) continue;
      // Two selected rows can resolve to the SAME backing `.md` (the same vault
      // file dropped twice). They share ONE frontmatter cache keyed by notePath, so
      // a command per row would make the second capture its inverse from the
      // cache the first already mutated AND fold two deltas onto one path. Build
      // ONE command per note path. Rows without a note are orphan/distinct and
      // aren't deduped.
      const notePath = resolveTextTileVaultPath(r.tile);
      if (notePath) {
        const key = vaultPath(notePath);
        if (seenNotePaths[key]) continue;
        seenNotePaths[key] = true;
      }
      const cmd = this.deps.buildTaskFieldCommand(r, patch, description);
      if (cmd) cmds.push(cmd);
    }
    if (cmds.length === 0) return { touched: 0, settled: Promise.resolve(true) };
    // Keep the settle promise so callers gate their success toast on the chain
    // resolving. `.then(() => true, () => false)` also CATCHES the rejection
    // (execute() rethrows after rollback), avoiding an unhandled rejection.
    const command = new BatchCommand(description, cmds);
    const settled = historyStore
      .execute(command)
      .then(() => true, () => false);
    this.deps.bumpCacheVersion();
    return { touched: cmds.length, settled, command };
  }

  /**
   * Shared tail for the field-patch bulk ops: clear the selection
   * synchronously (visibility bookkeeping, see bulkMarkComplete), then announce + toast success ONLY once the chain resolves.
   * On failure stay silent — `historyStore.execute`'s reportError already
   * surfaced the visual error; we add a screen-reader announcement for parity.
   */
  private finalizeBulkFieldOp(
    touched: number,
    settled: Promise<boolean>,
    successMsg: string,
    failAnnounce: string,
  ): void {
    if (touched <= 0) return;
    this.clearSelection();
    void settled.then((ok) => {
      if (ok) {
        uiStore.toast(successMsg, 'success', 1800);
        this.deps.announce(successMsg);
      } else {
        this.deps.announce(failAnnounce);
      }
    });
  }

  bulkSetPriority(p: Priority): void {
    const sel = this.selectedRows();
    const { touched, settled } = this.bulkApplyFieldPatch(
      sel,
      () => ({ priority: p === 'none' ? '' : p }),
      `Set priority on ${sel.length} tasks`,
    );
    this.finalizeBulkFieldOp(
      touched,
      settled,
      `Priority set on ${touched} task${touched === 1 ? '' : 's'}`,
      'Setting priority failed — see the error notification',
    );
  }

  bulkSetDueDate(iso: string): void {
    const sel = this.selectedRows();
    const { touched, settled } = this.bulkApplyFieldPatch(
      sel,
      () => ({ dueDate: iso }),
      iso ? `Set due date on ${sel.length} tasks` : `Clear due date on ${sel.length} tasks`,
    );
    this.finalizeBulkFieldOp(
      touched,
      settled,
      iso
        ? `Due set on ${touched} task${touched === 1 ? '' : 's'}`
        : `Due cleared on ${touched} task${touched === 1 ? '' : 's'}`,
      'Setting the due date failed — see the error notification',
    );
  }

  bulkMarkComplete(): void {
    const sel = this.selectedRows();
    const boardId = this.deps.getBoard()?.id ?? null;
    // Rules Filo can't read can't roll forward: those tasks end up done for good.
    const unreadable = sel.filter((r) => !r.completed && r.recurrence && !parseRecurrence(r.recurrence));
    const { touched, settled, command } = this.bulkApplyFieldPatch(
      sel,
      // Route completion through the shared helper so recurring tasks roll
      // forward ({completed:false, dueDate:next}) instead of being stamped
      // permanently done. Already-completed rows are skipped (null).
      (r) => (r.completed ? null : completionPatchForRow(r)),
      `Mark ${sel.length} tasks complete`,
    );
    // Clear the selection after a visibility-changing bulk op (handled
    // synchronously inside finalizeBulkFieldOp). With a "hide completed" filter
    // active, the just-completed rows vanish but would otherwise stay selected,
    // so the bar shows "N selected" for invisible rows and a follow-up bulk op
    // silently acts on them. We CLEAR rather than prune to the still-visible
    // rows because the field writes settle ASYNCHRONOUSLY, so a synchronous
    // prune-to-filtered would read stale visibility.
    this.finalizeBulkFieldOp(
      touched,
      settled,
      `Marked ${touched} task${touched === 1 ? '' : 's'} complete`,
      'Marking tasks complete failed — see the error notification',
    );
    if (command && unreadable.length > 0) {
      void settled.then((ok) => {
        if (ok) warnUnreadableRules(unreadable.length, unreadable[0]?.recurrence ?? '', () => historyStore.undoIfLatest(command, boardId));
      });
    }
  }

  bulkMarkIncomplete(): void {
    const sel = this.selectedRows();
    const { touched, settled } = this.bulkApplyFieldPatch(
      sel,
      (r) => (r.completed ? { completed: false } : null),
      `Mark ${sel.length} tasks incomplete`,
    );
    this.finalizeBulkFieldOp(
      touched,
      settled,
      `Marked ${touched} task${touched === 1 ? '' : 's'} incomplete`,
      'Marking tasks incomplete failed — see the error notification',
    );
  }

  bulkDelete(): void {
    const sel = this.selectedRows();
    if (sel.length === 0) return;
    uiStore.openConfirm({
      title: 'Delete selected tasks',
      body: `Remove ${sel.length} task${sel.length === 1 ? '' : 's'} from this board? Their notes stay in the vault.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        const board = this.deps.getBoard();
        if (!board) return;
        // Each placement removal is reversible via the per-tile snapshot in
        // DeleteTaskCommand; the BatchCommand wraps them so a single Ctrl+Z
        // restores every row at once.
        const cmds: Command[] = orderForBatchDelete(board.id, sel.map((r) => r.tile.id))
          .map((id) => new DeleteTaskCommand(board.id, id));
        if (cmds.length === 0) return;
        // Gate the "removed" toast on the chain resolving (and
        // catch the rejection so a failed delete doesn't unhandled-reject). The
        // placement removal runs synchronously inside execute(); persisting it
        // can still fail, in which case execute()'s reportError surfaces the
        // error and we stay silent here.
        const settled = historyStore
          .execute(new BatchCommand(`Delete ${cmds.length} tasks`, cmds))
          .then(() => true, () => false);
        this.deps.tickAndPersist();
        this.clearSelection();
        const msg = `${sel.length} task${sel.length === 1 ? '' : 's'} removed`;
        void settled.then((ok) => {
          if (!ok) return;
          uiStore.toast(msg, 'success', 1800);
          this.deps.announce(msg);
        });
      },
    });
  }

  /**
   * Selects every row on screen (Ctrl+A). A folded section's or parent's rows
   * are left out, so a bulk Delete after it can't remove rows the user can't see.
   */
  selectAllVisible(): void {
    const next = new SvelteSet<string>();
    for (const r of this.deps.getRenderedRows()) next.add(r.tile.id);
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
    // Seed from the LIVE selected rows (matching every field bulk op),
    // not raw `selectedTaskIds`, so a stale/filtered-away id can't skew the
    // moved count reported in the toast.
    const seeds = this.selectedRows().map((r) => r.tile.id);
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
    if (!anchorId) return; // blockIds non-empty (checked above)
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
    // Gate the "moved" toast on the chain resolving (and catch
    // the rejection). The reorder runs synchronously inside execute(); a failed
    // board persist surfaces via execute()'s reportError, so we stay silent.
    const settled = historyStore
      .execute(
        new MoveTaskBlockCommand(
          board.id,
          before,
          { sections: after.sections, tasks: after.placements },
          `Move ${blockIds.length} task${blockIds.length === 1 ? '' : 's'} to ${targetTitle}`,
        ),
      )
      .then(() => true, () => false);
    this.deps.tickAndPersist();
    this.clearSelection(); // see bulkMarkComplete — a section filter can hide moved rows
    const msg = `Moved ${blockIds.length} task${blockIds.length === 1 ? '' : 's'} to "${targetTitle}"`;
    void settled.then((ok) => {
      if (!ok) return;
      uiStore.toast(msg, 'success', 2000);
      this.deps.announce(msg);
    });
  }
}

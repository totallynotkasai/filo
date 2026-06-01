import { Command, cloneForSnapshot } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { documentStore } from '../stores/document.svelte';
import { uiStore } from '../stores/ui.svelte';
import { vaultIndexStore } from '../stores/vaultIndex.svelte';
import { vaultStore } from '../stores/vault.svelte';
import type { TileDefinition, KanbanBoard } from '../schema/index';
import type {
  KanbanTilePlacement,
  PartialKanbanCardStyle,
} from '../schema/placement';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
} from '../lib/boards/frontmatterWriteScheduler';
import {
  writeMarkdownFile,
  markHydrated,
  isHydrated,
  readMarkdownForHydrate,
} from '../lib/vault/markdownFileWriter';
import { reportError } from '../lib/utils/errorBus';
import { forceWriteForDocument } from '../lib/vault/markdownFileWriter';
import { applyFrontmatterPatchRebased, fmValueEqual } from './frontmatterRebase';

// ── Kanban Commands ──
//
// Mirror the Task List pattern: structural ops snapshot the affected
// `columns` slice; card add/delete snapshot the placement + tileDef;
// UpdateCardField captures before/after patches and schedules the FM
// write through the shared scheduler.

// M3 (2026-05-28) — deep-clone via the shared `cloneForSnapshot` helper.
// The previous two-level spread left each placement's nested `style` /
// `coverImage` aliased to the live `$state` proxy, so an in-place mutation of
// one of those nested objects between snapshot and undo would corrupt the
// retained snapshot. Routing through the same JSON-clone every other command
// uses fully detaches the snapshot.
function snapshotKanbanColumns(boardId: string): KanbanBoard['columns'] | null {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'kanban') return null;
  const kb = cached.board as KanbanBoard;
  return cloneForSnapshot(kb.columns ?? []);
}

function restoreKanbanColumns(boardId: string, snapshot: KanbanBoard['columns']): void {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'kanban') return;
  const kb = cached.board as KanbanBoard;
  // Clone on the way back in too, so the retained snapshot stays pristine for
  // a subsequent redo→undo cycle (the live board must not share references
  // with it).
  (kb as Record<string, unknown>).columns = cloneForSnapshot(snapshot);
  // Phase 6.1.R3 — the caller (always a Command's undo) is responsible
  // for `boardCacheStore.markDirty(this.targetBoardId)` so the gate's
  // "only this.targetBoardId" rule isn't laundered through a helper that
  // takes a parameter `boardId`.
}

export class AddCardCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private columnId: string;
  private def: TileDefinition;
  private position: number;
  private style?: PartialKanbanCardStyle;

  constructor(
    boardId: string,
    columnId: string,
    def: TileDefinition,
    position: number,
    style?: PartialKanbanCardStyle,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.columnId = columnId;
    // Phase 31 B4.4 — `this.snapshot(...)` deep-clones the def so the caller
    // can't corrupt the snapshot via a post-construction mutation (tag
    // change, completion toggle, frontmatter back-merge).
    this.def = this.snapshot(def);
    this.position = position;
    this.style = style;
    this.description = `Add card "${def.title ?? ''}"`;
  }

  execute() {
    boardCacheStore.persistAddKanbanPlacement(
      this.boardId,
      this.columnId,
      this.def,
      this.position,
      this.style,
    );
  }

  undo() {
    boardCacheStore.removeKanbanPlacement(this.boardId, this.def.id);
  }
}

export class DeleteCardCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private snapshotDef: TileDefinition | null;
  private snapshotPlacement: KanbanTilePlacement | null;
  private snapshotColumnId: string | null;
  private snapshotPosition: number;

  constructor(boardId: string, tileId: string) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    this.description = `Delete card`;
    this.snapshotDef = null;
    this.snapshotPlacement = null;
    this.snapshotColumnId = null;
    this.snapshotPosition = 0;
    const cached = boardCacheStore.cache[boardId];
    if (cached && cached.board.type === 'kanban') {
      const kb = cached.board as KanbanBoard;
      for (const col of kb.columns ?? []) {
        const idx = (col.tilePlacements ?? []).findIndex((p) => p.tileId === tileId);
        if (idx >= 0) {
          this.snapshotColumnId = col.id;
          this.snapshotPosition = idx;
          // `this.snapshot(...)` deep-clones both snapshots so a tag/style
          // mutation on the same tile through TileHeader between execute()
          // and undo() doesn't mutate shared inner refs (style, coverImage,
          // tags, …) on the snapshot we plan to restore from. Mirrors
          // AddCardCommand's Phase 31 B4.4 deep-clone pattern.
          this.snapshotPlacement = this.snapshot(col.tilePlacements[idx]);
          break;
        }
      }
      const def = cached.tileDefs[tileId];
      if (def) this.snapshotDef = this.snapshot(def);
    }
  }

  execute() {
    boardCacheStore.removeKanbanPlacement(this.boardId, this.tileId);
  }

  undo() {
    if (!this.snapshotDef || !this.snapshotPlacement || !this.snapshotColumnId) return;
    // 6.4.M11 — restore the placement (style + coverImage) atomically. The old
    // separate setKanbanPlacementCoverImage write re-sanitized the path and
    // silently dropped a snapshotted value it deemed unsafe (e.g. an absolute
    // path that reached the cache via a hand-edited / older .board.json), so
    // undo wasn't faithful. The snapshot is trusted pre-delete state.
    boardCacheStore.persistAddKanbanPlacement(
      this.boardId,
      this.snapshotColumnId,
      this.snapshotDef,
      this.snapshotPosition,
      this.snapshotPlacement.style,
      this.snapshotPlacement.coverImage,
    );
  }
}

export class MoveCardCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private fromColumnId: string;
  private fromPosition: number;
  private toColumnId: string;
  private toPosition: number;

  constructor(
    boardId: string,
    tileId: string,
    fromColumnId: string,
    fromPosition: number,
    toColumnId: string,
    toPosition: number,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    this.fromColumnId = fromColumnId;
    this.fromPosition = fromPosition;
    this.toColumnId = toColumnId;
    this.toPosition = toPosition;
    this.description = fromColumnId === toColumnId ? 'Reorder card' : 'Move card';
  }

  execute() {
    // Phase 37 / 37.9 — destination-guard parity with undo() (Phase 31 B4.7).
    // Redo can land long after the original move, by which point the
    // target column might have been deleted. `moveKanbanPlacement`
    // silently no-ops on a missing column; without this guard Ctrl+Shift+Z
    // looks like it did nothing and the user has no signal explaining why.
    const cached = boardCacheStore.cache[this.boardId];
    const kb = cached && cached.board.type === 'kanban' ? cached.board as KanbanBoard : null;
    const toColumnExists = kb?.columns?.some((c) => c.id === this.toColumnId) ?? false;
    if (!toColumnExists) {
      uiStore.toast(
        'Cannot redo — target column was deleted.',
        'warning',
        4000,
      );
      return;
    }
    boardCacheStore.moveKanbanPlacement(
      this.boardId,
      this.tileId,
      this.toColumnId,
      this.toPosition,
    );
  }

  undo() {
    // Phase 31 B4.7 — guard against the source column being deleted
    // between execute and undo. `moveKanbanPlacement` silently no-ops on
    // a missing target column (no warn, no return); from the user's
    // perspective Ctrl+Z would appear to do nothing, leaving them
    // confused. Probe the cache for the column first and surface a toast
    // when it's missing. Match the no-op pattern in MoveTilesCommand.undo.
    const cached = boardCacheStore.cache[this.boardId];
    const kb = cached && cached.board.type === 'kanban' ? cached.board as KanbanBoard : null;
    const fromColumnExists = kb?.columns?.some((c) => c.id === this.fromColumnId) ?? false;
    if (!fromColumnExists) {
      uiStore.toast(
        'Cannot undo — column was deleted.',
        'warning',
        4000,
      );
      return;
    }
    boardCacheStore.moveKanbanPlacement(
      this.boardId,
      this.tileId,
      this.fromColumnId,
      this.fromPosition,
    );
  }
}

/**
 * Multi-card move — used by drag-and-drop when the user starts a drag on a
 * card that's part of a 2+ selection. All selected cards move contiguous in
 * the target column starting at `toPosition`, preserving their input order.
 *
 * Undo restores each card to its original (column, position) one at a time,
 * iterating the pre-move snapshot in source-position-ascending order so each
 * `moveKanbanPlacement` call lands at the right index (lower positions fill
 * first, shifting higher positions into place).
 */
export class MoveCardsCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileIds: string[];
  private toColumnId: string;
  private toPosition: number;
  private snapshots: Array<{ tileId: string; fromColumnId: string; fromPosition: number }>;

  constructor(
    boardId: string,
    tileIds: string[],
    toColumnId: string,
    toPosition: number,
    snapshots: Array<{ tileId: string; fromColumnId: string; fromPosition: number }>,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // allow-shallow: tileIds are primitive strings.
    this.tileIds = [...tileIds];
    this.toColumnId = toColumnId;
    this.toPosition = toPosition;
    // allow-shallow: snapshot entries are flat primitives.
    this.snapshots = snapshots.map((s) => ({ ...s }));
    const allSameSource = snapshots.every((s) => s.fromColumnId === toColumnId);
    this.description = allSameSource
      ? `Reorder ${tileIds.length} cards`
      : `Move ${tileIds.length} cards`;
  }

  execute() {
    boardCacheStore.moveKanbanPlacements(
      this.boardId,
      this.tileIds,
      this.toColumnId,
      this.toPosition,
    );
  }

  undo() {
    const ordered = [...this.snapshots].sort((a, b) => {
      if (a.fromColumnId !== b.fromColumnId) return a.fromColumnId < b.fromColumnId ? -1 : 1;
      return a.fromPosition - b.fromPosition;
    });
    for (const s of ordered) {
      boardCacheStore.moveKanbanPlacement(this.boardId, s.tileId, s.fromColumnId, s.fromPosition);
    }
  }
}

export class AddColumnCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private column: {
    id: string;
    title: string;
    position?: number;
    collapsed?: boolean;
    style?: Record<string, unknown>;
  };

  constructor(
    boardId: string,
    column: {
      id: string;
      title: string;
      position?: number;
      collapsed?: boolean;
      style?: Record<string, unknown>;
    },
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // Phase R3 — deep-clone so the optional `style` object can't be mutated
    // through the original caller-side reference after the command is pushed.
    this.column = this.snapshot(column);
    this.description = `Add column "${column.title}"`;
  }

  execute() {
    boardCacheStore.addKanbanColumn(this.boardId, { ...this.column });
  }

  undo() {
    boardCacheStore.removeKanbanColumn(this.boardId, this.column.id);
  }
}

export class DeleteColumnCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private columnId: string;
  private columnsBefore: KanbanBoard['columns'] | null;

  constructor(boardId: string, columnId: string, title: string) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.columnId = columnId;
    this.columnsBefore = snapshotKanbanColumns(boardId);
    this.description = `Delete column "${title}"`;
  }

  execute() {
    boardCacheStore.removeKanbanColumn(this.boardId, this.columnId);
  }

  undo() {
    if (this.columnsBefore) {
      restoreKanbanColumns(this.boardId, this.columnsBefore);
      boardCacheStore.markDirty(this.targetBoardId);
    }
  }
}

export class RenameColumnCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private columnId: string;
  private prevTitle: string;
  private nextTitle: string;

  constructor(boardId: string, columnId: string, prevTitle: string, nextTitle: string) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.columnId = columnId;
    this.prevTitle = prevTitle;
    this.nextTitle = nextTitle;
    this.description = `Rename column to "${nextTitle}"`;
  }

  execute() {
    boardCacheStore.renameKanbanColumn(this.boardId, this.columnId, this.nextTitle);
  }

  undo() {
    boardCacheStore.renameKanbanColumn(this.boardId, this.columnId, this.prevTitle);
  }
}

export class ReorderColumnCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private beforeOrder: string[];
  private afterOrder: string[];

  constructor(boardId: string, beforeOrder: string[], afterOrder: string[]) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // allow-shallow: arrays of primitive strings.
    this.beforeOrder = [...beforeOrder];
    this.afterOrder = [...afterOrder];
    this.description = `Reorder columns`;
  }

  execute() {
    boardCacheStore.reorderKanbanColumns(this.boardId, [...this.afterOrder]);
  }

  undo() {
    boardCacheStore.reorderKanbanColumns(this.boardId, [...this.beforeOrder]);
  }
}

/**
 * Phase 5 / 5.4 — undoable Kanban card cover-image set/clear.
 *
 * Both `pickCoverImageForTile` and `clearCoverImageForTile` used to call
 * `boardCacheStore.setKanbanPlacementCoverImage` directly with no history
 * entry, so users had no way to recover the prior image (or no-image
 * state) after a misclick. Snapshot the prior value at construction;
 * execute applies the new value, undo restores the prior.
 */
export class UpdateCoverImageCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private beforeCover: string | null;
  private afterCover: string | null;

  constructor(
    boardId: string,
    tileId: string,
    beforeCover: string | null,
    afterCover: string | null,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    this.beforeCover = beforeCover;
    this.afterCover = afterCover;
    this.description = afterCover ? 'Set cover image' : 'Clear cover image';
  }

  execute() {
    boardCacheStore.setKanbanPlacementCoverImage(this.boardId, this.tileId, this.afterCover);
  }

  undo() {
    boardCacheStore.setKanbanPlacementCoverImage(this.boardId, this.tileId, this.beforeCover);
  }
}

export class UpdateCardFieldCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private relPath: string;
  private docId: string | null;
  private patch: Record<string, unknown>;
  private inversePatch: Record<string, unknown>;
  // Audit2 4.2 — false on the user's initial Apply (apply directly), true once
  // executed so a later redo rebases like undo instead of clobbering.
  private hasExecuted = false;

  constructor(
    boardId: string,
    relPath: string,
    docId: string | null,
    patch: Record<string, unknown>,
    inversePatch: Record<string, unknown>,
    description?: string,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.relPath = relPath;
    this.docId = docId;
    // Phase R3 — deep-clone via `this.snapshot(...)` so nested values
    // (arrays, objects) inside the patch can't be mutated through the
    // original caller-side reference after the command is pushed. Before
    // R3 the shallow `{ ...patch }` left arrays (e.g. `tags: [...]`)
    // aliased with the caller; tag edits between Apply and Undo could
    // mutate the inverse patch's would-be-restored array.
    this.patch = this.snapshot(patch);
    this.inversePatch = this.snapshot(inversePatch);
    this.description = description ?? `Update card ${Object.keys(patch).join(', ')}`;
  }

  async execute(): Promise<void> {
    // Drain pending debounced writes before merging the new patch so the
    // prior in-memory state lands on disk first. Mirrors UpdateTaskFieldCommand —
    // without this, a rapid toggle → undo can race the still-debounced forward
    // write against the inverse patch's fresh write at the same docId.
    //
    // Phase 2.7 — must `await` rather than fire-and-forget. The previous
    // `void` discarded the flush completion, so a fast Apply → Undo would
    // overlap: the forward debounced write was still in-flight when undo
    // queued the inverse patch and the inverse landed on disk first.
    await flushAllPendingFrontmatterWrites();
    // First execute = the user's own action: apply it directly (the inverse
    // patch was just read from this same live cache). A redo re-applies an old
    // patch and must rebase like undo so an external edit since isn't clobbered.
    const isRedo = this.hasExecuted;
    this.hasExecuted = true;
    if (this.docId && isRedo) {
      applyFrontmatterPatchRebased({
        docId: this.docId,
        relPath: this.relPath,
        targetBoardId: this.targetBoardId,
        applying: this.patch,
        expectedCurrent: this.inversePatch,
        label: this.relPath,
      });
      return;
    }
    if (this.docId) documentStore.mergeFrontmatter(this.docId, this.patch);
    scheduleFrontmatterWrite(this.relPath, this.docId);
    boardCacheStore.markDirty(this.targetBoardId);
  }

  async undo(): Promise<void> {
    await flushAllPendingFrontmatterWrites();
    if (this.docId) {
      // Audit2 4.2 — rebase onto the live frontmatter so an external edit to
      // the same field isn't silently clobbered (prompts to apply anyway).
      applyFrontmatterPatchRebased({
        docId: this.docId,
        relPath: this.relPath,
        targetBoardId: this.targetBoardId,
        applying: this.inversePatch,
        expectedCurrent: this.patch,
        label: this.relPath,
      });
    } else {
      scheduleFrontmatterWrite(this.relPath, this.docId);
      boardCacheStore.markDirty(this.targetBoardId);
    }
  }
}

/**
 * Phase 5 / 5.5 — undoable kanban frontmatter edit for cards whose backing
 * tile lacks a `contentId`. The existing `UpdateCardFieldCommand` assumes
 * a docId so it can merge through the shared documentStore live cache; the
 * frontmatter scheduler in turn reads from documentStore (not the patch)
 * at flush time. With no docId, the scheduler reads from vaultIndexStore
 * — which is a watcher snapshot and won't reflect the patch — so the
 * previous `scheduleSharedFrontmatterWrite(path, null)` fallback was a
 * silent no-op.
 *
 * This command writes directly through `vault:write-existing-file-text`
 * with the assembled `(patched-fm, current-body)`, mirroring the disk
 * path PropertiesPopup uses. The body comes from the watcher snapshot
 * (vaultIndexStore) since there's no live editor for orphan-fm cards.
 */
export class UpdateOrphanFrontmatterCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private relPath: string;
  private patch: Record<string, unknown>;
  private inversePatch: Record<string, unknown>;

  constructor(
    boardId: string,
    relPath: string,
    patch: Record<string, unknown>,
    inversePatch: Record<string, unknown>,
    description?: string,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.relPath = relPath;
    this.patch = this.snapshot(patch);
    this.inversePatch = this.snapshot(inversePatch);
    this.description = description ?? `Update card ${Object.keys(patch).join(', ')}`;
  }

  async execute(): Promise<void> {
    // 6.2.H8 — route through the rebased variant so an external edit to
    // the same field isn't silently clobbered. The inverse patch IS the
    // expected current state (what we wrote on the prior execute, or the
    // initial state before any execute).
    await applyOrphanPatchRebased({
      relPath: this.relPath,
      targetBoardId: this.targetBoardId,
      applying: this.patch,
      expectedCurrent: this.inversePatch,
      label: this.relPath,
    });
  }

  async undo(): Promise<void> {
    await applyOrphanPatchRebased({
      relPath: this.relPath,
      targetBoardId: this.targetBoardId,
      applying: this.inversePatch,
      expectedCurrent: this.patch,
      label: this.relPath,
    });
  }
}

/**
 * Phase 7 / 7.2 — undoable mutation for a single Kanban column property
 * (collapsed flag, WIP limit, width). Snapshots the prior column shape so
 * undo can restore the exact field's prior value — including the "absent"
 * case where the previous shape didn't have the field at all. Used by
 * `KanbanBoard.svelte`'s toolbar handlers (toggle collapse, set WIP, set
 * width) and the collapse-all / expand-all bulk variants below.
 *
 * The command captures (column-id, prev-collapsed, prev-wipLimit, prev-style)
 * up-front so a later style write between execute and undo can't poison the
 * inverse. Each `apply()` call routes through the existing cache mutators so
 * the active-proxy tick path stays consistent with the bare write the
 * component used to do.
 */
export class UpdateKanbanColumnCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private columnId: string;
  private beforeCollapsed: boolean;
  private afterCollapsed: boolean;
  private beforeWipLimit: number | null;
  private afterWipLimit: number | null;
  private beforeWidth: number | null;
  private afterWidth: number | null;

  constructor(
    boardId: string,
    columnId: string,
    before: { collapsed: boolean; wipLimit: number | null; width: number | null },
    after: { collapsed: boolean; wipLimit: number | null; width: number | null },
    description?: string,
  ) {
    super();
    this.boardId = boardId;
    this.targetBoardId = boardId;
    this.columnId = columnId;
    this.beforeCollapsed = before.collapsed;
    this.afterCollapsed = after.collapsed;
    this.beforeWipLimit = before.wipLimit;
    this.afterWipLimit = after.wipLimit;
    this.beforeWidth = before.width;
    this.afterWidth = after.width;
    this.description = description ?? 'Update column';
  }

  private apply(state: { collapsed: boolean; wipLimit: number | null; width: number | null }): void {
    boardCacheStore.setKanbanColumnCollapsed(this.boardId, this.columnId, state.collapsed);
    boardCacheStore.setKanbanColumnWipLimit(this.boardId, this.columnId, state.wipLimit);
    boardCacheStore.setKanbanColumnWidth(this.boardId, this.columnId, state.width);
  }

  execute() {
    this.apply({
      collapsed: this.afterCollapsed,
      wipLimit: this.afterWipLimit,
      width: this.afterWidth,
    });
  }

  undo() {
    this.apply({
      collapsed: this.beforeCollapsed,
      wipLimit: this.beforeWipLimit,
      width: this.beforeWidth,
    });
  }
}

/**
 * Phase 7 / 7.2 — bulk collapse-all / expand-all. Captures every column's
 * prior `collapsed` flag so undo restores the exact mixed state (some
 * columns may have been collapsed before the bulk op).
 */
export class SetAllKanbanColumnsCollapsedCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private nextCollapsed: boolean;
  private previousStates: Record<string, boolean>;

  constructor(
    boardId: string,
    nextCollapsed: boolean,
    previousStates: Record<string, boolean>,
  ) {
    super();
    this.boardId = boardId;
    this.targetBoardId = boardId;
    this.nextCollapsed = nextCollapsed;
    // allow-shallow: Record values are primitive booleans.
    this.previousStates = { ...previousStates };
    this.description = nextCollapsed ? 'Collapse all columns' : 'Expand all columns';
  }

  execute() {
    boardCacheStore.setAllKanbanColumnsCollapsed(this.boardId, this.nextCollapsed);
  }

  undo() {
    const cached = boardCacheStore.cache[this.boardId];
    if (!cached || cached.board.type !== 'kanban') return;
    const kb = cached.board as KanbanBoard;
    for (const col of kb.columns ?? []) {
      const prev = this.previousStates[col.id] ?? false;
      if ((col.collapsed ?? false) !== prev) {
        boardCacheStore.setKanbanColumnCollapsed(this.boardId, col.id, prev);
      }
    }
  }
}

/**
 * 6.2.H8 — docId-less rebased frontmatter patch for orphan cards (no
 * open editor). Mirrors `applyFrontmatterPatchRebased` (Audit2 4.2) for
 * the docId case: read disk fresh, compare each applying key against
 * `expectedCurrent`, commit only the non-conflicting keys, and surface a
 * "Kept the external value" toast (with an Apply-anyway action) when a
 * field's external value diverged from what we expected.
 *
 * Pre-fix `applyOrphanPatch` blindly spread the patch over the disk
 * frontmatter — so an external editor changing the same field between
 * execute and undo was silently clobbered.
 */
async function applyOrphanPatchRebased(args: {
  relPath: string;
  targetBoardId: string;
  applying: Record<string, unknown>;
  expectedCurrent: Record<string, unknown>;
  label: string;
}): Promise<void> {
  const { relPath, targetBoardId, applying, expectedCurrent, label } = args;
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;

  // Audit 2.2 — if a Document editor opened on this file between execute
  // and undo, route through the docId-aware rebased helper (same conflict
  // semantics as orphan path, but uses the live cache). Force-flush so
  // the rebase's write lands immediately instead of riding the debounce.
  const openDoc = documentStore.findByFilename(relPath);
  if (openDoc) {
    applyFrontmatterPatchRebased({
      docId: openDoc.docId,
      relPath,
      targetBoardId,
      applying,
      expectedCurrent,
      label,
    });
    const result = await forceWriteForDocument(openDoc.docId);
    if (result.ok > 0) return;
    // No writer registered yet (editor mid-mount); fall through to the
    // direct orphan write path below.
  }

  // Drain pending debounced writes so the prior in-memory state lands
  // first. Mirrors UpdateCardFieldCommand's flush-before-merge ordering.
  await flushAllPendingFrontmatterWrites();

  // D.8 — read the file body fresh from disk rather than trusting
  // `vaultIndexStore.getMetadata(...)?.content`. The index can be stale
  // for an orphan (no editor open, watcher reconciliation pending), so
  // assembling from the stale `content` would clobber an external edit
  // that landed since the last index rebuild.
  let body = '';
  let baseFm: Record<string, unknown> = {};
  try {
    const hydrateResult = await readMarkdownForHydrate(vaultRoot, relPath);
    body = hydrateResult.body;
    baseFm = hydrateResult.frontmatter;
  } catch {
    const meta = vaultIndexStore.getMetadata(relPath);
    baseFm = (meta?.frontmatter ?? {}) as Record<string, unknown>;
    body = meta?.content ?? '';
    if (!isHydrated(relPath)) markHydrated(relPath, false);
  }

  const commit = async (patch: Record<string, unknown>): Promise<void> => {
    const merged: Record<string, unknown> = { ...baseFm, ...patch };
    for (const k of Object.keys(merged)) {
      const v = merged[k];
      if (v === '' || v === undefined || v === null) delete merged[k];
    }
    try {
      await writeMarkdownFile({
        vaultRoot,
        relPath,
        frontmatter: merged,
        body,
        callerId: `kanban-orphan-patch:${relPath}`,
        docId: null,
      });
    } catch (err) {
      reportError('updateOrphanFrontmatter', err, `Failed to update ${relPath}`);
    }
    // allow-non-target-markdirty: shared helper, callers pass this.targetBoardId per the CI gate
    boardCacheStore.markDirty(targetBoardId);
  };

  const conflicts = Object.keys(applying).filter(
    (key) => !fmValueEqual(baseFm[key], expectedCurrent[key]),
  );

  if (conflicts.length === 0) {
    await commit(applying);
    return;
  }

  // Keep the external value(s); apply only the fields nothing external
  // touched. The board still needs to be dirtied (markDirty fires inside
  // commit), so call commit even with the smaller patch if any safe
  // fields remain. When ALL fields conflict, skip the write entirely.
  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(applying)) {
    if (!conflicts.includes(key)) safe[key] = applying[key];
  }
  if (Object.keys(safe).length > 0) {
    await commit(safe);
  } else {
    // No safe fields, but the command still ran on this board's stack so
    // the cache should reflect the user's local-history intent.
    // allow-non-target-markdirty: shared helper, callers pass this.targetBoardId per the CI gate
    boardCacheStore.markDirty(targetBoardId);
  }

  uiStore.pushToast({
    text: `External edit changed ${conflicts.join(', ')} in ${label}. Kept the external value — that field's undo/redo was skipped.`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Apply anyway',
        handler: () => {
          const forced: Record<string, unknown> = {};
          for (const key of conflicts) forced[key] = applying[key];
          void commit(forced);
        },
      },
    ],
  });
}

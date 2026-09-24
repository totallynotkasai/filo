import { Command, cloneForSnapshot } from './Command';
import { toastMissingUndoRedoTarget } from './missingTargetToast';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { documentStore } from '../stores/document.svelte';
import { uiStore } from '../stores/ui.svelte';
import { vaultIndexStore } from '../stores/vaultIndex.svelte';
import { defTitle } from '../stores/noteMeta';
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
import { seedDocumentFrontmatterFromDisk } from '../lib/boards/seedFrontmatterFromDisk';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import {
  applyFrontmatterPatchRebased,
  captureInverseFromCache,
  fmValueEqual,
} from './frontmatterRebase';
import { patchToFrontmatterDelta } from '../lib/vault/frontmatterDelta';

// ── Kanban Commands ──
//
// Mirror the Task List pattern: structural ops snapshot the affected
// `columns` slice; card add/delete snapshot the placement + tileDef;
// UpdateCardField captures before/after patches and schedules the FM
// write through the shared scheduler.

// Reads the LIVE columns array for a Kanban board (no clone) so a command can
// locate a column + its index at construction time. `DeleteColumnCommand`
// snapshots ONLY the removed column: a wholesale `columns` restore would revert
// every sibling-column edit made between execute and undo.
function currentKanbanColumns(boardId: string): KanbanBoard['columns'] | null {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'kanban') return null;
  return (cached.board as KanbanBoard).columns ?? [];
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
    // Snapshot (deep-clone) def + style so a caller-side mutation after
    // construction can't corrupt what redo re-applies.
    this.def = this.snapshot(def);
    this.position = position;
    this.style = style ? this.snapshot(style) : style;
    this.description = `Add card "${defTitle(def)}"`;
  }

  execute() {
    // Toast + bail rather than orphan the card when the column is gone (undo removes by id).
    const cached = boardCacheStore.cache[this.boardId];
    if (cached?.board.type !== 'kanban' || !cached.board.columns?.some((c) => c.id === this.columnId)) { toastMissingUndoRedoTarget('redo', 'the column'); return; }
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
  // tileId of the card immediately AFTER the deleted one (null = column tail).
  // undo() inserts before this sibling so an intervening sibling add/remove
  // doesn't land the restored card at a stale absolute index.
  private beforeTileId: string | null;

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
    this.beforeTileId = null;
    const cached = boardCacheStore.cache[boardId];
    if (cached && cached.board.type === 'kanban') {
      const kb = cached.board as KanbanBoard;
      for (const col of kb.columns ?? []) {
        const placements = col.tilePlacements ?? [];
        const idx = placements.findIndex((p) => p.tileId === tileId);
        if (idx >= 0) {
          this.snapshotColumnId = col.id;
          this.snapshotPosition = idx;
          // Deep-clone so a tag/style edit on the same tile between execute()
          // and undo() can't mutate shared inner refs on the snapshot.
          const placement = placements[idx];
          if (placement) this.snapshotPlacement = this.snapshot(placement);
          // Undo anchor: the next sibling (only this one card is removed).
          this.beforeTileId = placements[idx + 1]?.tileId ?? null;
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
    // Restore the placement (style + coverImage) atomically. A separate
    // setKanbanPlacementCoverImage write would re-sanitize the path and could
    // drop a snapshotted value; the snapshot is trusted pre-delete state.
    boardCacheStore.persistAddKanbanPlacement(
      this.boardId,
      this.snapshotColumnId,
      this.snapshotDef,
      this.snapshotPosition,
      this.snapshotPlacement.style,
      this.snapshotPlacement.coverImage,
      this.beforeTileId, // anchor over the stale absolute index
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
  // Neighbour anchors captured from the pre-move cache (see ctor).
  private fromBeforeTileId: string | null;
  private toBeforeTileId: string | null;

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

    // Capture neighbour anchors from the PRE-move cache (this command is
    // constructed before execute() applies the move). Absolute positions go
    // stale if the column is mutated between execute and a later undo/redo, so
    // we also record the sibling each insert should sit immediately BEFORE,
    // computed against the column with the moved card removed (mirroring
    // moveKanbanPlacement's remove-then-insert). Reused for both legs.
    const placementsWithoutMoved = (columnId: string): KanbanTilePlacement[] => {
      const cached = boardCacheStore.cache[boardId];
      const kb = cached && cached.board.type === 'kanban' ? (cached.board as KanbanBoard) : null;
      const col = kb?.columns?.find((c) => c.id === columnId);
      return (col?.tilePlacements ?? []).filter((p) => p.tileId !== tileId);
    };
    this.fromBeforeTileId = placementsWithoutMoved(fromColumnId)[fromPosition]?.tileId ?? null;
    this.toBeforeTileId = placementsWithoutMoved(toColumnId)[toPosition]?.tileId ?? null;
  }

  execute() {
    // The target column may have been deleted since the original move.
    // `moveKanbanPlacement` silently no-ops on a missing column, so toast
    // instead of letting redo look like it did nothing.
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
      this.toBeforeTileId, // anchor over stale absolute index
    );
  }

  undo() {
    // The source column may have been deleted since execute;
    // `moveKanbanPlacement` would silently no-op, so toast instead.
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
      this.fromBeforeTileId, // anchor over stale absolute index
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
 *
 * The absolute `fromPosition` goes stale if a source column is mutated between
 * the move and a later undo, so each snapshot also carries the surviving sibling
 * the card should sit immediately BEFORE, resolved against the LIVE column at
 * undo time. The absolute position is the fallback when that sibling is gone.
 */
export class MoveCardsCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileIds: string[];
  private toColumnId: string;
  private toPosition: number;
  private snapshots: Array<{
    tileId: string;
    fromColumnId: string;
    fromPosition: number;
    // tileId of the next surviving (non-moved) card in the source column at
    // construction time; null falls back to the absolute position.
    anchorTileId: string | null;
  }>;
  // Forward-leg anchor for execute()/redo, so a redo after the target column
  // was edited doesn't replay a stale `toPosition`. tileId of the surviving
  // card the block should sit immediately before; null = append.
  private toBeforeTileId: string | null;

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
    // Capture each card's anchor from the PRE-move cache: the first SURVIVING
    // card after it in its source column, with the whole moved set skipped
    // (mirrors moveKanbanPlacement's remove-then-insert).
    const movedSet = new Set(tileIds);
    const anchorFor = (fromColumnId: string, tileId: string): string | null => {
      const cached = boardCacheStore.cache[boardId];
      if (!cached || cached.board.type !== 'kanban') return null;
      const placements =
        (cached.board as KanbanBoard).columns?.find((c) => c.id === fromColumnId)
          ?.tilePlacements ?? [];
      const idx = placements.findIndex((p) => p.tileId === tileId);
      if (idx < 0) return null;
      for (let i = idx + 1; i < placements.length; i++) {
        const p = placements[i];
        if (p && !movedSet.has(p.tileId)) return p.tileId;
      }
      return null;
    };
    // allow-shallow: snapshot entries are flat primitives (anchorTileId is a string|null).
    this.snapshots = snapshots.map((s) => ({
      ...s,
      anchorTileId: anchorFor(s.fromColumnId, s.tileId),
    }));
    // Forward-leg anchor: the surviving card at `toPosition` in
    // the target column once the whole moved set is removed (the same frame
    // moveKanbanPlacements inserts against). Captured here, pre-move.
    const targetPlacements =
      (boardCacheStore.cache[boardId]?.board as KanbanBoard | undefined)?.columns?.find(
        (c) => c.id === toColumnId,
      )?.tilePlacements ?? [];
    const targetSurvivors = targetPlacements.filter((p) => !movedSet.has(p.tileId));
    this.toBeforeTileId = targetSurvivors[toPosition]?.tileId ?? null;
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
      this.toBeforeTileId, // anchor over the stale absolute index
    );
  }

  undo() {
    const ordered = [...this.snapshots].sort((a, b) => {
      if (a.fromColumnId !== b.fromColumnId) return a.fromColumnId < b.fromColumnId ? -1 : 1;
      return a.fromPosition - b.fromPosition;
    });
    for (const s of ordered) {
      boardCacheStore.moveKanbanPlacement(
        this.boardId,
        s.tileId,
        s.fromColumnId,
        s.fromPosition,
        s.anchorTileId, // anchor over the stale absolute index
      );
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
    // Deep-clone so the optional `style` object can't be mutated
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
  /**
   * Captured DELTA: the removed column (deep-cloned, with its placements) + its
   * original index. `undo` re-inserts ONLY this column against the LIVE columns,
   * so edits to surviving columns made between execute and undo survive. Null
   * when the column wasn't found at construction (undo no-ops).
   */
  private removedColumn: KanbanBoard['columns'][number] | null;
  private removedIndex: number;
  /** Defs of the column's cards placed nowhere else, captured on the first execute. */
  private removedDefs: Record<string, TileDefinition> | null = null;

  constructor(boardId: string, columnId: string, title: string) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.columnId = columnId;
    const cols = currentKanbanColumns(boardId);
    const idx = cols ? cols.findIndex((c) => c.id === columnId) : -1;
    this.removedIndex = idx;
    const removedCol = idx >= 0 && cols ? cols[idx] : undefined;
    this.removedColumn = removedCol ? this.snapshot(removedCol) : null;
    this.description = `Delete column "${title}"`;
  }

  execute() {
    const removed = boardCacheStore.removeKanbanColumnWithDefs(this.boardId, this.columnId);
    this.removedDefs ??= this.snapshot(removed);
  }

  undo() {
    if (!this.removedColumn) return;
    // Clone on the way in so a redo→undo cycle keeps the retained snapshot
    // pristine (the live board must not share references with it).
    boardCacheStore.insertKanbanColumnAt(
      this.boardId,
      cloneForSnapshot(this.removedColumn),
      this.removedIndex,
      this.removedDefs ? cloneForSnapshot(this.removedDefs) : undefined,
    );
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
 * Undoable Kanban card cover-image set/clear. Snapshots the prior value at
 * construction; execute applies the new value, undo restores the prior.
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
  private docId: string;
  private patch: Record<string, unknown>;
  private inversePatch: Record<string, unknown>;
  // False on the user's initial Apply (apply directly), true once
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
    // Refuse a null docId: without one the write re-emits unchanged FM, so Apply
    // and Undo would be silent no-ops. Null-docId edits go through
    // UpdateOrphanFrontmatterCommand.
    if (!docId) {
      throw new Error(
        'UpdateCardFieldCommand requires a non-null docId; route null-docId card edits through UpdateOrphanFrontmatterCommand instead',
      );
    }
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.relPath = relPath;
    this.docId = docId;
    // Deep-clone so nested values (e.g. `tags: [...]`) can't be mutated through
    // the caller's reference after the command is pushed.
    this.patch = this.snapshot(patch);
    this.inversePatch = this.snapshot(inversePatch);
    this.description = description ?? `Update card ${Object.keys(patch).join(', ')}`;
  }

  async execute(): Promise<void> {
    // Drain pending debounced writes before merging the new patch so the
    // prior in-memory state lands on disk first. Awaited: otherwise a fast
    // Apply → Undo races the still-debounced forward write against the inverse.
    await flushAllPendingFrontmatterWrites();
    // First execute = the user's own action: apply it directly (the inverse
    // patch was just read from this same live cache). A redo re-applies an old
    // patch and must rebase like undo so an external edit since isn't clobbered.
    const isRedo = this.hasExecuted;
    this.hasExecuted = true;
    if (isRedo) {
      await applyFrontmatterPatchRebased({
        docId: this.docId,
        relPath: this.relPath,
        targetBoardId: this.targetBoardId,
        applying: this.patch,
        expectedCurrent: this.inversePatch,
        label: this.relPath,
      });
      return;
    }
    // Capture vault identity before the seed's disk read; a vault swap can
    // commit mid-read, and we must not inject the old vault's FM or write onto
    // the new vault's same-named file.
    const identity = captureVaultIdentity();
    // Seed the FM cache from a fresh disk read inside the chained command body,
    // so save()/quit (which await historyStore.whenChainSettled()) cover this
    // read — seeding before execute() let a quit in that window lose the edit.
    // No-op when the cache is already seeded or the disk read fails.
    await seedDocumentFrontmatterFromDisk(this.docId, vaultStore.path, this.relPath);
    // Swap landed mid-seed: abandon before any index/merge/schedule/markDirty sink.
    if (!isStillSameVault(identity)) return;
    if (!documentStore.getFrontmatter(this.docId)) {
      // Disk read failed (ENOENT / transient) — fall back to the vault-index
      // snapshot so the merge has a full FM object.
      documentStore.setFrontmatter(
        this.docId,
        (vaultIndexStore.getMetadata(this.relPath)?.frontmatter ?? {}) as Record<string, unknown>,
      );
    }
    // Recapture the inverse from the just-seeded cache so undo restores the
    // TRUE prior value of each patched key — the writer computed it before
    // this seed ran, off a possibly-stale index / empty cache.
    this.inversePatch = this.snapshot(captureInverseFromCache(this.docId, this.patch));
    // mergeFrontmatter feeds the DISPLAY cache only; the delta is the write
    // SOURCE (applied to a fresh disk read in the gateway), so an untouched
    // external key is preserved instead of dropped from a stale cache.
    documentStore.mergeFrontmatter(this.docId, this.patch);
    scheduleFrontmatterWrite(this.relPath, this.docId, patchToFrontmatterDelta(this.patch));
    boardCacheStore.markDirty(this.targetBoardId);
  }

  async undo(): Promise<void> {
    await flushAllPendingFrontmatterWrites();
    // Rebase onto the live frontmatter so an external edit to the same field
    // isn't silently clobbered (prompts to apply anyway). Awaited: the rebase
    // re-reads disk when no cache is seeded.
    await applyFrontmatterPatchRebased({
      docId: this.docId,
      relPath: this.relPath,
      targetBoardId: this.targetBoardId,
      applying: this.inversePatch,
      expectedCurrent: this.patch,
      label: this.relPath,
    });
  }
}

/**
 * Undoable kanban frontmatter edit for cards whose backing tile lacks a
 * `contentId`. `UpdateCardFieldCommand` needs a docId to merge through the
 * documentStore cache; without one the scheduler would read the watcher
 * snapshot and never see the patch. This command writes directly instead,
 * mirroring the PropertiesPopup disk path.
 */
export class UpdateOrphanFrontmatterCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private relPath: string;
  private patch: Record<string, unknown>;
  private inversePatch: Record<string, unknown>;
  private hasExecuted = false;

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
    // On the FIRST execute, recompute the inverse from the current on-disk
    // frontmatter. The construction-time inverse came from a possibly-stale
    // vault index: it would make execute falsely conflict (dropping the user's
    // edit) and make undo restore a stale value. Not on redo — the inverse
    // already holds what this command wrote. A read failure keeps the
    // construction-time inverse.
    if (!this.hasExecuted) {
      this.hasExecuted = true;
      // Guard the recompute against a vault swap during the flush/read.
      const identity = captureVaultIdentity();
      await flushAllPendingFrontmatterWrites();
      const vaultRoot = vaultStore.path;
      if (vaultRoot) {
        try {
          const hydrate = await readMarkdownForHydrate(vaultRoot, this.relPath);
          if (isStillSameVault(identity)) {
            const before = (hydrate.frontmatter ?? {}) as Record<string, unknown>;
            const inverse: Record<string, unknown> = {};
            for (const key of Object.keys(this.patch)) {
              inverse[key] = key in before ? before[key] : '';
            }
            this.inversePatch = this.snapshot(inverse);
          }
        } catch {
          // ENOENT / transient — keep the construction-time inverse.
        }
      }
    }
    // Route through the rebased variant so an external edit to
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
 * Undoable mutation for a single Kanban column property (collapsed flag, WIP
 * limit, width). Snapshots the prior values up-front — including the "absent"
 * case — so a later write between execute and undo can't poison the inverse.
 * Used by `KanbanBoard.svelte`'s toolbar handlers.
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
  // Which fields this command actually changed. `apply` only writes those, so
  // undoing a collapse toggle doesn't clobber an out-of-band wipLimit/width edit.
  private changedCollapsed: boolean;
  private changedWipLimit: boolean;
  private changedWidth: boolean;

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
    this.changedCollapsed = before.collapsed !== after.collapsed;
    this.changedWipLimit = before.wipLimit !== after.wipLimit;
    this.changedWidth = before.width !== after.width;
    this.description = description ?? 'Update column';
  }

  private apply(state: { collapsed: boolean; wipLimit: number | null; width: number | null }): void {
    if (this.changedCollapsed) {
      boardCacheStore.setKanbanColumnCollapsed(this.boardId, this.columnId, state.collapsed);
    }
    if (this.changedWipLimit) {
      boardCacheStore.setKanbanColumnWipLimit(this.boardId, this.columnId, state.wipLimit);
    }
    if (this.changedWidth) {
      boardCacheStore.setKanbanColumnWidth(this.boardId, this.columnId, state.width);
    }
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
 * Bulk collapse-all / expand-all. Captures every column's
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
 * docId-less rebased frontmatter patch for orphan cards (no open editor).
 * Mirrors `applyFrontmatterPatchRebased`: read disk fresh, compare each
 * applying key against `expectedCurrent`, commit only the non-conflicting keys,
 * and toast "Kept the external value" (with Apply anyway) for the rest, so an
 * external edit to the same field isn't silently clobbered.
 */
async function applyOrphanPatchRebased(args: {
  relPath: string;
  targetBoardId: string;
  applying: Record<string, unknown>;
  expectedCurrent: Record<string, unknown>;
  label: string;
}): Promise<void> {
  const { relPath, targetBoardId, applying, expectedCurrent, label } = args;
  // Capture identity before reading the live vault path; a swap during the
  // flush/read must not apply this command's patch to the new vault's file.
  const identity = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;

  // If a Document editor opened on this file between execute
  // and undo, route through the docId-aware rebased helper (same conflict
  // semantics as orphan path, but uses the live cache). Force-flush so
  // the rebase's write lands immediately instead of riding the debounce.
  const openDoc = documentStore.findByFilename(relPath);
  if (openDoc) {
    await applyFrontmatterPatchRebased({
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

  // Read the body fresh from disk rather than trusting the vault index, which
  // can be stale for an orphan and would clobber a recent external edit.
  let body = '';
  let baseFm: Record<string, unknown> = {};
  // Disk FM SOURCE, threaded into the write below so it source-preserves
  // instead of full-dumping. Unset on the index fallback (no source available).
  let baseRawFm: string | undefined;
  try {
    const hydrateResult = await readMarkdownForHydrate(vaultRoot, relPath);
    body = hydrateResult.body;
    baseFm = hydrateResult.frontmatter;
    baseRawFm = hydrateResult.rawFrontmatter;
  } catch {
    const meta = vaultIndexStore.getMetadata(relPath);
    baseFm = (meta?.frontmatter ?? {}) as Record<string, unknown>;
    body = meta?.content ?? '';
    if (!isHydrated(relPath)) markHydrated(relPath, false);
  }

  // Swap during the drain/read: don't write this patch onto the new vault.
  if (!isStillSameVault(identity)) return;

  const commit = async (patch: Record<string, unknown>): Promise<void> => {
    // Thread an explicit DELTA, not a cleaned whole object: cleaning would drop
    // present-but-empty disk keys (aliases:, cssclasses:).
    const delta = patchToFrontmatterDelta(patch);
    // Don't swallow a failed write: letting it reject makes execute()/undo()
    // reject so the history wrapper rolls the command back (the gateway already
    // toasted and kept `.filo/.dirty`). markDirty runs only after success.
    await writeMarkdownFile({
      vaultRoot,
      relPath,
      frontmatterDelta: delta,
      body,
      callerId: `kanban-orphan-patch:${relPath}`,
      docId: null,
      // Delta baselines from its own fresh read; baseRawFm = no-delta fallback.
      originalFrontmatter: baseRawFm,
      bodyIsLive: false, // always a snapshot body, never a live editor's
    });
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
  // touched. When ALL fields conflict, skip the write entirely.
  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(applying)) {
    if (!conflicts.includes(key)) safe[key] = applying[key];
  }
  if (Object.keys(safe).length > 0) {
    await commit(safe);
  }
  // When ALL fields conflict nothing is written, so don't markDirty — it would
  // only schedule a redundant `.board.json` rewrite (and a phantom drift prompt).

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
          // commit rejects on write failure; this fire-and-forget toast path
          // isn't wrapped by the history runner, so surface + swallow.
          void commit(forced).catch((err) =>
            reportError('updateOrphanFrontmatter', err, `Failed to update ${relPath}`),
          );
        },
      },
    ],
  });
}

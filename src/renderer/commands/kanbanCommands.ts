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
// snapshots ONLY the removed column via `this.snapshot(...)`; the whole-slice
// snapshot/restore helpers this replaced (Audit5 Phase 4) were the Kanban
// analogue of the pre-2.5 TaskList slice-replace bug — a wholesale `columns`
// restore reverted every sibling-column edit made between execute and undo.
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
    // Phase 31 B4.4 — `this.snapshot(...)` deep-clones the def so the caller
    // can't corrupt the snapshot via a post-construction mutation (tag
    // change, completion toggle, frontmatter back-merge).
    this.def = this.snapshot(def);
    this.position = position;
    // L30 (Audit-6) — deep-clone the optional style so a caller-side mutation
    // of the same object after construction can't corrupt the value this
    // command re-applies on redo (mirrors the `def` snapshot above).
    this.style = style ? this.snapshot(style) : style;
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
  // 6.4.M16 — neighbour anchors captured from the pre-move cache (see ctor).
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

    // 6.4.M16 — capture neighbour anchors from the PRE-move cache (this command
    // is constructed before execute() applies the move). Absolute positions go
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
      this.toBeforeTileId, // 6.4.M16 — anchor over stale absolute index
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
      this.fromBeforeTileId, // 6.4.M16 — anchor over stale absolute index
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
 * Audit-7 M3 — restoring to the absolute `fromPosition` alone goes stale if a
 * source column is mutated (a card added/removed) between the move and a later
 * undo: the saved index then points at the wrong slot and the cards return
 * scrambled. Each snapshot now also carries the surviving sibling the card
 * should sit immediately BEFORE in its source column, captured from the PRE-move
 * cache and resolved against the LIVE column at undo time (mirrors the
 * single-card `MoveCardCommand` 6.4.M16 anchor). Ascending replay + a
 * next-survivor anchor reconstructs the original interleaving; the absolute
 * position is the fallback when that sibling is gone.
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
    // Audit-7 M3 — tileId of the next surviving (non-moved) card in the source
    // column at construction time; null when the card was last (or only moved
    // cards follow), in which case undo falls back to the absolute position.
    anchorTileId: string | null;
  }>;

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
    // Audit-7 M3 — capture each card's neighbour anchor from the PRE-move cache
    // (this command is constructed before execute() applies the move, so the
    // moved cards are still in their source columns). The anchor is the first
    // SURVIVING card after this one in its source column — computed with the
    // whole moved set skipped (mirrors moveKanbanPlacement's remove-then-insert)
    // — so an ascending-order undo lands each card immediately before its
    // original sibling even if the column was mutated meanwhile. Null (card was
    // last, or only moved cards follow) falls back to the absolute position.
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
        if (!movedSet.has(placements[i].tileId)) return placements[i].tileId;
      }
      return null;
    };
    // allow-shallow: snapshot entries are flat primitives (anchorTileId is a string|null).
    this.snapshots = snapshots.map((s) => ({
      ...s,
      anchorTileId: anchorFor(s.fromColumnId, s.tileId),
    }));
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
      boardCacheStore.moveKanbanPlacement(
        this.boardId,
        s.tileId,
        s.fromColumnId,
        s.fromPosition,
        s.anchorTileId, // Audit-7 M3 — anchor over the stale absolute index
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
  /**
   * Audit5 Phase 4 (#9) — captured DELTA: the single removed column
   * (deep-cloned, with its card placements) + its original array index. `undo`
   * re-inserts ONLY this column against the LIVE columns via
   * `insertKanbanColumnAt`, so an edit to a SURVIVING column (rename, card
   * move/add, WIP limit, collapse, width, style, cover image) made between
   * execute and undo survives. The prior whole-`columns`-slice replay reverted
   * every sibling column's interval edit — the Kanban analogue of the
   * `DeleteSectionCommand` slice-replace bug fixed in 2.5. `removedColumn` is
   * null when the column wasn't found at construction (execute/undo no-op).
   */
  private removedColumn: KanbanBoard['columns'][number] | null;
  private removedIndex: number;

  constructor(boardId: string, columnId: string, title: string) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.columnId = columnId;
    const cols = currentKanbanColumns(boardId);
    const idx = cols ? cols.findIndex((c) => c.id === columnId) : -1;
    this.removedIndex = idx;
    this.removedColumn = idx >= 0 && cols ? this.snapshot(cols[idx]) : null;
    this.description = `Delete column "${title}"`;
  }

  execute() {
    boardCacheStore.removeKanbanColumn(this.boardId, this.columnId);
  }

  undo() {
    if (!this.removedColumn) return;
    // Clone on the way in so a redo→undo cycle keeps the retained snapshot
    // pristine (the live board must not share references with it).
    boardCacheStore.insertKanbanColumnAt(
      this.boardId,
      cloneForSnapshot(this.removedColumn),
      this.removedIndex,
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
    if (this.docId) {
      // A9-H1 — capture vault identity before the seed's disk read; an Open Vault
      // → "Don't Save" swap can commit mid-read. Bailing after (below) means we
      // never re-inject (A9-M1) the old vault's FM or arm a write onto the new
      // vault's same-named file.
      const identity = captureVaultIdentity();
      // Audit-7 H1 — seed the FM cache from a FRESH disk read HERE, inside the
      // chained command body, so vaultStore.save()/quit (which await
      // historyStore.whenChainSettled() before flushing) cover this read. The
      // seed used to run in the writer BEFORE historyStore.execute(); a Ctrl+S /
      // quit landing in that pre-chain await window saw an empty chain, reported
      // a premature "Saved", and tore down the renderer before the field write
      // was scheduled — a silent loss with no .filo/.dirty sentinel (the vault
      // was clean at edit time). No-op when an open editor / prior edit already
      // seeded the cache, or when the disk read fails.
      await seedDocumentFrontmatterFromDisk(this.docId, vaultStore.path, this.relPath);
      // A9-H1 — swap landed mid-seed: abandon before any index/merge/schedule/markDirty sink.
      if (!isStillSameVault(identity)) return;
      if (!documentStore.getFrontmatter(this.docId)) {
        // Disk read failed (ENOENT / transient) — fall back to the vault-index
        // snapshot, exactly as the writer's old ensureSeededFm did, so the merge
        // has a full FM object and the source-preserving write can't drop keys.
        documentStore.setFrontmatter(
          this.docId,
          (vaultIndexStore.getMetadata(this.relPath)?.frontmatter ?? {}) as Record<string, unknown>,
        );
      }
      // Recapture the inverse from the just-seeded cache so undo restores the
      // TRUE prior value of each patched key — the writer computed it before
      // this seed ran, off a possibly-stale index / empty cache.
      this.inversePatch = this.snapshot(captureInverseFromCache(this.docId, this.patch));
      // Phase 4 — mergeFrontmatter feeds the DISPLAY cache; the delta is the
      // write SOURCE (applied to fresh disk in the gateway), so an untouched
      // external key is preserved by construction instead of dropped from a
      // stale cache. Decoupled — the cache is never the write source.
      documentStore.mergeFrontmatter(this.docId, this.patch);
    }
    // The delta routes through the gateway's fresh-disk apply (docId path). The
    // null-docId card is dead in production (the writer routes it through
    // UpdateOrphanFrontmatterCommand), so it keeps the legacy no-delta path.
    scheduleFrontmatterWrite(
      this.relPath,
      this.docId,
      this.docId ? patchToFrontmatterDelta(this.patch) : undefined,
    );
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
    // A8-M5 — on the FIRST execute, recompute the inverse from the CURRENT
    // on-disk frontmatter, mirroring the docId path's captureInverseFromCache.
    // The writer computed `inversePatch` from the (possibly-hours-stale) vault
    // index at construction; if an external editor added/changed a patched key
    // since the last index rebuild, that stale inverse is wrong two ways:
    //   1. execute would FALSELY conflict — `applyOrphanPatchRebased` compares
    //      the fresh disk value against this `expectedCurrent`, so a stale
    //      mismatch makes it KEEP the external value and DROP the user's edit.
    //   2. undo would restore the stale value (''/absent) instead of the TRUE
    //      prior on-disk value.
    // Recomputing from a fresh disk read fixes both. Only on the first execute
    // (not redo): a redo must replay against the value THIS command wrote, which
    // the inverse already holds. A read failure keeps the construction-time
    // inverse (best-effort, matching the docId path's index fallback).
    if (!this.hasExecuted) {
      this.hasExecuted = true;
      // A9-H1 — guard the inverse recompute against a swap during the flush/read
      // (don't read the new vault's same-named file); the write below bails too.
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
  // L29 (Audit-6) — which of the three fields this command actually changed,
  // computed once at construction. `apply` only writes the changed ones, so an
  // undo/redo of a collapse toggle no longer also re-stamps the column's
  // wipLimit/width — which would clobber an out-of-band edit to those fields
  // made between this command's execute and its undo.
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
  // A9-H1 — capture identity before reading the live vault path; a swap during
  // the flush/read must not apply this command's patch to the new vault's file.
  const identity = captureVaultIdentity();
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
  // A9-L5 — disk FM SOURCE, threaded into the docId-less write below so it
  // source-preserves instead of full-dumping. Only the disk-read branch sets it
  // (the index fallback has no source, so that degraded path keeps the full-dump).
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

  // A9-H1 — swap during the drain/read: don't write this patch onto the new vault.
  if (!isStillSameVault(identity)) return;

  const commit = async (patch: Record<string, unknown>): Promise<void> => {
    // FILO-UR-1 — thread an explicit DELTA, not a cleaned whole object. The old
    // merge + drop-empty-keys loop deleted present-but-empty disk keys (aliases:,
    // cssclasses:) and the CST engine spliced them out — loss on execute AND undo.
    const delta = patchToFrontmatterDelta(patch);
    // A9-L2 — do NOT swallow a failed orphan write (pre-fix this catch only
    // reportError'd, so the command resolved SUCCESS and markDirty'd while disk
    // stayed stale). Letting the rejection propagate makes execute()/undo()
    // reject so the history wrapper rolls the command back, matching the docId
    // path; the gateway's trackComponentWrite already kept `.filo/.dirty` dirty +
    // toasted. markDirty below runs ONLY past a successful write (a throw skips it).
    await writeMarkdownFile({
      vaultRoot,
      relPath,
      frontmatterDelta: delta,
      body,
      callerId: `kanban-orphan-patch:${relPath}`,
      docId: null,
      // A9-L5 / FILO-UR-1 — delta branch derives its baseline from its own fresh
      // in-chain read; baseRawFm stays threaded for the no-delta fallback.
      originalFrontmatter: baseRawFm,
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
          // A9-L2 — commit now rejects on write failure; this fire-and-forget
          // toast path isn't wrapped by the history runner, so surface + swallow.
          void commit(forced).catch((err) =>
            reportError('updateOrphanFrontmatter', err, `Failed to update ${relPath}`),
          );
        },
      },
    ],
  });
}

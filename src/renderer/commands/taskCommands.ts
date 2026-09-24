import { Command, cloneForSnapshot } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { documentStore } from '../stores/document.svelte';
import { uiStore } from '../stores/ui.svelte';
import { vaultStore } from '../stores/vault.svelte';
import { vaultIndexStore } from '../stores/vaultIndex.svelte';
import type {
  TaskListBoard,
  TaskListSection,
  TileDefinition,
} from '../schema/index';
import type {
  TaskPlacement,
  PartialTaskStyle,
} from '../schema/placement';
import {
  scheduleFrontmatterWrite,
  flushFrontmatterWriteForPath,
} from '../lib/boards/frontmatterWriteScheduler';
import { seedDocumentFrontmatterFromDisk } from '../lib/boards/seedFrontmatterFromDisk';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { applyFrontmatterPatchRebased, captureInverseFromCache } from './frontmatterRebase';
import { patchToFrontmatterDelta } from '../lib/vault/frontmatterDelta';
import { writeMarkdownAndReconcile } from '../lib/vault/syncOpenEditorsAfterDiskMutation';
import { reportError } from '../lib/utils/errorBus';
import { deleteVaultPath } from '../lib/vault/vaultOperations';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import type { DeletedFileSnapshot } from './tileCommands';

// ── Task List Commands ──
//
// These wrap the existing `boardCacheStore.persist*` methods so list-style
// board mutations participate in the per-board undo/redo stack. Structural
// commands (Add/Delete/Move/Section…) snapshot the affected slice and
// replay it; field commands (UpdateTaskField) capture before/after
// frontmatter patches and schedule the debounced write on both legs.
//
// Backing files are never created or removed by Command undo/redo — the
// Vault API owns file-system side effects. Re-adding a placement after
// undo simply links it back to the existing `.md`. The one opt-in
// exception is `DeleteTaskCommand` with `DeleteTaskFileOptions`:
// when the user explicitly chooses "Delete task & file", that command owns
// the disk delete and restores the snapshotted body on undo, mirroring
// Mind Map's `DeleteTilesCommand`.

/**
 * Captures the current shape of a Task List board's sections + tasks +
 * tileDefs. Exported for use by section commands (sibling file) which need
 * to snapshot the same slice for their own undo paths.
 */
// Deep-clone (not a one-level spread): nested `style` / tileDef fields would
// otherwise stay aliased to the live `$state` proxy, and an in-place mutation
// between snapshot and undo would corrupt the retained snapshot.
export function snapshotTaskListSlice(boardId: string): {
  sections: TaskListSection[];
  tasks: TaskPlacement[];
  defs: Record<string, TileDefinition>;
} | null {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'tasklist') return null;
  const tl = cached.board as TaskListBoard;
  return {
    sections: cloneForSnapshot((tl.sections ?? []) as TaskListSection[]),
    tasks: cloneForSnapshot((tl.tasks ?? []) as TaskPlacement[]),
    defs: cloneForSnapshot(cached.tileDefs),
  };
}

export function restoreTaskListSlice(
  boardId: string,
  snapshot: { sections: TaskListSection[]; tasks: TaskPlacement[]; defs: Record<string, TileDefinition> },
): void {
  // Replace tileDefs first so persistTaskListStructure's task array refers
  // to defs that exist. updateEntry replaces the map wholesale, so a def
  // that was removed by execute() comes back here. Clone on the way back in
  // too so the retained snapshot stays pristine for a redo→undo cycle.
  boardCacheStore.updateEntry(boardId, { tileDefs: cloneForSnapshot(snapshot.defs) });
  boardCacheStore.persistTaskListStructure(
    boardId,
    cloneForSnapshot(snapshot.sections),
    cloneForSnapshot(snapshot.tasks),
  );
}

/** What a create-exclusive seed actually created. */
export interface SeededFile {
  relPath: string;
  title: string;
}

export class AddTaskCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private def: TileDefinition;
  private position: number;
  private style?: PartialTaskStyle;
  private targetSectionId?: string;
  private sectionsBefore: TaskListSection[] | null;
  // Optional backing-`.md` seed folded INTO the command so it runs on the
  // history chain. Awaited on the first execute only; absent for callers (e.g.
  // file-drop) whose `.md` already exists. May resolve the FINAL path it created
  // (the create-exclusive helper bumps to ` (n)` when the name exists).
  private seedBackingFile?: () => Promise<SeededFile | void>;
  private hasExecuted = false;

  constructor(
    boardId: string,
    def: TileDefinition,
    position: number,
    style?: PartialTaskStyle,
    targetSectionId?: string,
    seedBackingFile?: () => Promise<SeededFile | void>,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // Deep-clone def + style so the caller can't mutate shared nested fields
    // after construction and corrupt what undo/redo re-applies.
    this.def = this.snapshot(def);
    this.position = position;
    this.style = style ? this.snapshot(style) : style;
    this.targetSectionId = targetSectionId;
    this.seedBackingFile = seedBackingFile;
    this.description = `Add task "${def.title ?? ''}"`;
    const snap = snapshotTaskListSlice(boardId);
    this.sectionsBefore = snap ? snap.sections : null;
  }

  async execute(): Promise<void> {
    const isFirst = !this.hasExecuted;
    this.hasExecuted = true;
    // Placement first, synchronously (before any await) so callers/tests that
    // inspect the cache right after execute() — and the placement-only path
    // (file-drop, round-trip tests) — are unaffected.
    boardCacheStore.persistAddTaskPlacement(
      this.boardId,
      this.def,
      this.position,
      this.style,
      this.targetSectionId,
    );
    // Seed the backing `.md` on the FIRST execute, inside the chained command
    // body, so save()/quit (which drain via whenChainSettled()) can't persist the
    // placement but lose the `.md` and its metadata. Skipped on redo (re-seeding
    // would overwrite later edits). On seed failure, roll the placement back so
    // no orphan row references a missing file.
    if (isFirst && this.seedBackingFile) {
      let seeded: SeededFile | void;
      try {
        seeded = await this.seedBackingFile();
      } catch (err) {
        this.removePlacement();
        throw err;
      }
      // The def was cloned (and its placement persisted) BEFORE
      // the seed ran, so a bumped name must re-stamp the cached def; redo then
      // re-adds the bumped path, which is where the file actually lives.
      const current = (this.def as { filePath?: string }).filePath;
      if (seeded && seeded.relPath !== current) {
        this.def = { ...this.def, filePath: seeded.relPath, title: seeded.title } as TileDefinition;
        boardCacheStore.persistUpdateTile(this.def.id, { filePath: seeded.relPath, title: seeded.title }, this.boardId);
      }
    }
  }

  /** Title of the task as created (reflects any ` (n)` name bump). */
  get currentTitle(): string {
    return this.def.title ?? '';
  }

  undo() {
    this.removePlacement();
  }

  private removePlacement(): void {
    boardCacheStore.removeTaskPlacement(this.boardId, this.def.id);
    // The remove/add section-position shifts aren't symmetric at boundary
    // indices, so restoring the pre-add sections snapshot guarantees an
    // exact round-trip.
    if (this.sectionsBefore) {
      boardCacheStore.persistTaskListStructure(this.boardId, this.sectionsBefore.map((s) => ({ ...s })));
    }
  }
}

/**
 * Opt-in backing-file delete. When the user picks "Delete task &
 * file", the caller pre-reads the `.md` body (so undo can restore it) and
 * passes it here. Absent these options the command is placement-only and the
 * file is left on disk — the default, undo-safe behaviour.
 */
export interface DeleteTaskFileOptions {
  /** Pre-read backing-.md snapshot; present only when the user opted in and
   *  the body was small enough to snapshot. */
  fileSnapshot?: DeletedFileSnapshot;
  /** Vault root; required when `fileSnapshot` is set. */
  vaultRoot?: string;
}

/**
 * Removes one task placement (and optionally its backing file).
 *
 * The placement position and the section slices are snapshotted in the
 * CONSTRUCTOR as absolute indices. Instances batched into one BatchCommand
 * must therefore be ordered by DESCENDING position (`orderForBatchDelete`):
 * the batch undoes in reverse, and only then does each re-insert land on the
 * index it was taken from.
 */
export class DeleteTaskCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private snapshotDef: TileDefinition | null;
  private snapshotPlacement: TaskPlacement | null;
  private sectionsBefore: TaskListSection[] | null;
  // When set, execute() also deletes the backing .md and undo()
  // writes the snapshotted body back BEFORE restoring the placement, mirroring
  // DeleteTilesCommand. Null on the default placement-only path.
  private fileSnapshot: DeletedFileSnapshot | null;
  private vaultRoot: string | undefined;
  /** Last execute()'s file-delete IPC (Promise.allSettled-wrapped; resolves
   *  immediately on the placement-only path). Awaited by tests / redo. */
  lastExecuteCompletion: Promise<unknown> = Promise.resolve();
  /** Last undo()'s file-restore IPC. Awaited by tests / a sequencing redo. */
  lastUndoCompletion: Promise<unknown> = Promise.resolve();

  constructor(boardId: string, tileId: string, fileOpts: DeleteTaskFileOptions = {}) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    this.description = fileOpts.fileSnapshot ? `Delete task and file` : `Delete task`;
    // allow-shallow: DeletedFileSnapshot is flat { rel, content } primitives.
    this.fileSnapshot = fileOpts.fileSnapshot ? { ...fileOpts.fileSnapshot } : null;
    this.vaultRoot = fileOpts.vaultRoot;
    const cached = boardCacheStore.cache[boardId];
    this.snapshotDef = null;
    this.snapshotPlacement = null;
    this.sectionsBefore = null;
    if (cached && cached.board.type === 'tasklist') {
      const tl = cached.board as TaskListBoard;
      const placements = (tl.tasks ?? []) as TaskPlacement[];
      const p = placements.find((x) => x.tileId === tileId);
      if (p) this.snapshotPlacement = this.snapshot(p);
      const def = cached.tileDefs[tileId];
      // Deep-clone so a later tag edit or external rewrite can't mutate the
      // snapshot's nested fields (e.g. the `tags` array) through the cache.
      if (def) this.snapshotDef = this.snapshot(def);
      this.sectionsBefore = ((tl.sections ?? []) as TaskListSection[]).map((s) => this.snapshot(s));
    }
  }

  async execute() {
    // Placement removal stays synchronous (it runs before the first await), so
    // existing callers / tests that assert on cache state right after execute()
    // — and the placement-only path used by cascade / bulk delete — are
    // unaffected.
    boardCacheStore.removeTaskPlacement(this.boardId, this.tileId);
    if (this.vaultRoot && this.fileSnapshot) {
      const vaultRoot = this.vaultRoot;
      const rel = this.fileSnapshot.rel;
      // Sequence behind any prior execute/undo IPC so a rapid Ctrl+Y / Ctrl+Z
      // can't let this delete race the prior undo's restore write (the same
      // guard DeleteTilesCommand uses). Both priors are allSettled wrappers,
      // so awaiting them never rejects.
      const prior = Promise.allSettled([this.lastExecuteCompletion, this.lastUndoCompletion]);
      this.lastExecuteCompletion = prior.then(() => this.deleteBackingFile(vaultRoot, rel));
      await this.lastExecuteCompletion;
    } else {
      this.lastExecuteCompletion = Promise.resolve();
    }
  }

  private async deleteBackingFile(vaultRoot: string, rel: string): Promise<void> {
    // vault:delete takes (vaultRoot, absoluteItemPath).
    const absPath = `${vaultRoot}/${rel}`;
    try {
      const result = await deleteVaultPath(vaultRoot, absPath);
      // ENOENT is the desired end state (file already gone) — suppress.
      if (!result.success && result.code !== 'ENOENT') {
        reportError(
          'deleteTask.execute',
          new Error(result.error ?? 'vault:delete returned !success'),
          `Failed to delete ${rel}`,
        );
      }
    } catch (err) {
      if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') return;
      reportError('deleteTask.execute', err, `Failed to delete ${rel}`);
    }
  }

  async undo() {
    // File-first: write the snapshotted body back BEFORE restoring the
    // placement so `persistAddTaskPlacement`'s seed-check sees the file we
    // just wrote and skips the empty-seed path (mirrors DeleteTilesCommand).
    if (this.vaultRoot && this.fileSnapshot) {
      const { rel, content } = this.fileSnapshot;
      const vaultRoot = this.vaultRoot;
      // Route through the coupled write+reconcile helper: the restored `.md` may
      // be open as a Document elsewhere, and that editor's stale cache would
      // invert this restore on its next save. `mode: 'full'` reloads the open
      // editor for the same path; `create: true` recreates the deleted file.
      this.lastUndoCompletion = writeMarkdownAndReconcile({
        vaultRoot,
        path: rel,
        content,
        mode: 'full',
        create: true,
      }).catch((err) => {
        uiStore.toast(
          `Task restored but file content could not be recovered: ${rel}`,
          'error',
          6000,
        );
        reportError('deleteTask.undo', err, `Failed to restore ${rel}`);
      });
      await this.lastUndoCompletion;
    } else {
      this.lastUndoCompletion = Promise.resolve();
    }
    this.restorePlacement();
  }

  private restorePlacement(): void {
    if (!this.snapshotDef || !this.snapshotPlacement) return;
    boardCacheStore.persistAddTaskPlacement(
      this.boardId,
      this.snapshotDef,
      this.snapshotPlacement.position,
      this.snapshotPlacement.style,
    );
    if (this.sectionsBefore) {
      boardCacheStore.persistTaskListStructure(
        this.boardId,
        this.sectionsBefore.map((s) => ({ ...s })),
      );
    }
  }
}

/**
 * Structural mutation that replaces both the placements and the sections
 * array for a Task List board. Used by drag-drop block moves, indent /
 * outdent, and section reorder. Snapshots are full slices so undo is
 * unambiguous regardless of which fields actually changed.
 */
export class MoveTaskBlockCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private before: { sections: TaskListSection[]; tasks: TaskPlacement[] };
  private after: { sections: TaskListSection[]; tasks: TaskPlacement[] };

  constructor(
    boardId: string,
    before: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    after: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    description = 'Move tasks',
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // Deep-clone so any nested style /
    // tags field on a placement can't leak through to the snapshot.
    this.before = this.snapshot(before);
    this.after = this.snapshot(after);
    this.description = description;
  }

  execute() {
    boardCacheStore.persistTaskListStructure(
      this.boardId,
      this.after.sections.map((s) => ({ ...s })),
      this.after.tasks.map((p) => ({ ...p })),
    );
  }

  undo() {
    boardCacheStore.persistTaskListStructure(
      this.boardId,
      this.before.sections.map((s) => ({ ...s })),
      this.before.tasks.map((p) => ({ ...p })),
    );
  }
}

/**
 * Merges a frontmatter patch into a task's `.md` file via the shared
 * documentStore live cache. Captures the prior values of every patched
 * field so undo can restore them exactly (an empty string deletes the
 * field via mergeFrontmatter's cleaning rule, matching what users see
 * when they "clear" a property in the UI).
 */
export class UpdateTaskFieldCommand extends Command {
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
  // When set, undo/redo treat the patch as a coupled pair on a conflict
  // (a recurrence roll-forward writes {completed, dueDate} together). Set by
  // buildTaskFieldCommand when the patch carries both keys.
  private atomic: boolean;

  constructor(
    boardId: string,
    relPath: string,
    docId: string | null,
    patch: Record<string, unknown>,
    inversePatch: Record<string, unknown>,
    description?: string,
    atomic = false,
  ) {
    super();
    // Refuse a null docId: without one the patch is never merged and the write
    // re-emits unchanged FM, so Apply and Undo would be silent no-ops.
    // `buildTaskFieldCommand` routes null-docId edits through a fallback.
    if (!docId) {
      throw new Error(
        'UpdateTaskFieldCommand requires a non-null docId; route null-docId task edits through the orphan-write fallback instead',
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
    this.atomic = atomic;
    this.description = description ?? `Update task ${Object.keys(patch).join(', ')}`;
  }

  async execute(): Promise<void> {
    // Drain pending debounced writes before merging the new patch so the
    // prior in-memory state lands on disk first. Awaited: otherwise a fast
    // Apply → Undo races the still-debounced forward write against the inverse.
    // Drains only THIS path (the race is same-docId), so a bulk batch of field
    // commands doesn't do O(N²) global flushes.
    await flushFrontmatterWriteForPath(this.relPath);
    // First execute = the user's own action: apply it directly (the inverse
    // patch was just read from this same live cache). A redo re-applies an old
    // patch and must rebase like undo so an external edit since isn't clobbered.
    const isRedo = this.hasExecuted;
    this.hasExecuted = true;
    if (isRedo) {
      // Awaited: the rebase re-reads disk when no cache is seeded.
      await applyFrontmatterPatchRebased({
        docId: this.docId,
        relPath: this.relPath,
        targetBoardId: this.targetBoardId,
        applying: this.patch,
        expectedCurrent: this.inversePatch,
        label: this.relPath,
        atomic: this.atomic,
      });
      return;
    }
    // Capture the active vault BEFORE the seed await; a vault swap can commit
    // while the disk read is in flight, and resuming would inject the old
    // vault's frontmatter and write onto the new vault's same-named file.
    const identity = captureVaultIdentity();
    // Seed the FM cache from a fresh disk read inside the chained command body,
    // so save()/quit (which await historyStore.whenChainSettled()) cover this
    // read — seeding before execute() let a quit in that window lose the edit.
    // No-op when the cache is already seeded or the disk read fails.
    await seedDocumentFrontmatterFromDisk(this.docId, vaultStore.path, this.relPath);
    // A swap landed mid-seed: abandon. Do NOT fall back to the index, merge,
    // schedule a write, or mark the now-foreign board dirty.
    if (!isStillSameVault(identity)) return;
    if (!documentStore.getFrontmatter(this.docId)) {
      // Disk read failed (ENOENT / transient) — fall back to the vault-index
      // snapshot so the merge has a full FM object.
      documentStore.setFrontmatter(
        this.docId,
        (vaultIndexStore.getMetadata(this.relPath)?.frontmatter ?? {}) as Record<string, unknown>,
      );
    }
    // Recapture the inverse from the just-seeded cache so undo restores the TRUE
    // prior value of each patched key — `buildTaskFieldCommand` computed it from
    // the (possibly-stale) vault index before this disk seed ran.
    this.inversePatch = this.snapshot(captureInverseFromCache(this.docId, this.patch));
    // mergeFrontmatter feeds the DISPLAY cache only; the delta is the write
    // SOURCE (applied to a fresh disk read in the gateway), so an untouched
    // external key survives instead of being dropped from a stale cache.
    documentStore.mergeFrontmatter(this.docId, this.patch);
    scheduleFrontmatterWrite(this.relPath, this.docId, patchToFrontmatterDelta(this.patch));
    boardCacheStore.markDirty(this.targetBoardId);
  }

  async undo(): Promise<void> {
    await flushFrontmatterWriteForPath(this.relPath); // own path only
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
      atomic: this.atomic,
    });
  }
}

/**
 * Add or remove a tile id from a Task List board's `collapsedSubtasks` set.
 * Snapshots both states so undo restores the exact prior set even if the user
 * subsequently toggled other rows.
 */
export class ToggleSubtaskCollapsedCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private before: string[];
  private after: string[];

  constructor(
    boardId: string,
    before: string[],
    after: string[],
    description?: string,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // allow-shallow: arrays of primitive strings.
    this.before = [...before];
    this.after = [...after];
    this.description = description ?? 'Toggle subtask collapse';
  }

  execute() {
    boardCacheStore.setTaskListCollapsedSubtasks(this.boardId, [...this.after]);
  }

  undo() {
    boardCacheStore.setTaskListCollapsedSubtasks(this.boardId, [...this.before]);
  }
}

/**
 * Flips a Task List placement's `locked` flag. The lock lives on the placement
 * (not on the backing `.md`) so the same task can be locked on this board
 * without affecting other boards that reference the same file.
 */
export class TogglePlacementLockCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private before: boolean;
  private after: boolean;

  constructor(boardId: string, tileId: string, before: boolean, after: boolean) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    this.before = before;
    this.after = after;
    this.description = after ? 'Lock task' : 'Unlock task';
  }

  execute() {
    boardCacheStore.setTaskPlacementLocked(this.boardId, this.tileId, this.after);
  }

  undo() {
    boardCacheStore.setTaskPlacementLocked(this.boardId, this.tileId, this.before);
  }
}

/**
 * Applies a partial style patch to a Task List placement. The cache method
 * *merges* the patch onto any existing style, so to restore the prior state
 * exactly we wipe the placement style (pass `null`) and then re-apply the
 * full snapshot. The wipe round-trips cleanly because `null` / `{}` deletes
 * `placement.style` in `boardCacheStore.updateTaskPlacementStyle`.
 */
export class UpdatePlacementStyleCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private beforeStyle: PartialTaskStyle | null;
  private afterPatch: PartialTaskStyle;

  constructor(
    boardId: string,
    tileId: string,
    beforeStyle: PartialTaskStyle | null,
    afterPatch: PartialTaskStyle,
    description?: string,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    // Deep-clone the style payloads so nested colour / font
    // overrides can't leak through caller-side reference mutation.
    this.beforeStyle = beforeStyle ? this.snapshot(beforeStyle) : null;
    this.afterPatch = this.snapshot(afterPatch);
    this.description = description ?? 'Update task style';
  }

  execute() {
    boardCacheStore.updateTaskPlacementStyle(this.boardId, this.tileId, { ...this.afterPatch });
  }

  undo() {
    // Wipe first so the cache method's merge becomes a wholesale replace.
    boardCacheStore.updateTaskPlacementStyle(this.boardId, this.tileId, null);
    if (this.beforeStyle && Object.keys(this.beforeStyle).length > 0) {
      boardCacheStore.updateTaskPlacementStyle(this.boardId, this.tileId, { ...this.beforeStyle });
    }
  }
}

/**
 * Alt+Up / Alt+Down within a Task List section. Delegates to
 * `MoveTaskBlockCommand` so the actual replay path is the same proven
 * snapshot/restore that drag-reorder uses — this class is the entry point
 * keyboard handlers call.
 */
export class ReorderTaskWithinSectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private inner: MoveTaskBlockCommand;

  constructor(
    boardId: string,
    before: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    after: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    direction: -1 | 1,
  ) {
    super();
    this.targetBoardId = boardId;
    this.description = direction < 0 ? 'Move task up' : 'Move task down';
    this.inner = new MoveTaskBlockCommand(boardId, before, after, this.description);
  }

  execute() {
    this.inner.execute();
  }

  undo() {
    this.inner.undo();
  }
}

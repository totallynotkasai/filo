import { Command, cloneForSnapshot } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { documentStore } from '../stores/document.svelte';
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
  flushAllPendingFrontmatterWrites,
} from '../lib/boards/frontmatterWriteScheduler';

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
// undo simply links it back to the existing `.md`.

/**
 * Captures the current shape of a Task List board's sections + tasks +
 * tileDefs. Exported for use by section commands (sibling file) which need
 * to snapshot the same slice for their own undo paths.
 */
// M3 (2026-05-28) — deep-clone via the shared `cloneForSnapshot` helper.
// The previous one-level spread left each task/section's nested `style` (and
// each tileDef's nested fields) aliased to the live `$state` proxy, so an
// in-place mutation between snapshot and undo would corrupt the retained
// snapshot. Routing through the same JSON-clone every other command uses
// fully detaches the snapshot.
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

export class AddTaskCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private def: TileDefinition;
  private position: number;
  private style?: PartialTaskStyle;
  private targetSectionId?: string;
  private sectionsBefore: TaskListSection[] | null;

  constructor(
    boardId: string,
    def: TileDefinition,
    position: number,
    style?: PartialTaskStyle,
    targetSectionId?: string,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // Phase 31 B4.4 — `this.snapshot(...)` deep-clones the def so the caller
    // can't mutate shared nested fields (tags array, frontmatter snapshots)
    // after construction and corrupt the undo snapshot.
    this.def = this.snapshot(def);
    this.position = position;
    this.style = style;
    this.targetSectionId = targetSectionId;
    this.description = `Add task "${def.title ?? ''}"`;
    const snap = snapshotTaskListSlice(boardId);
    this.sectionsBefore = snap ? snap.sections : null;
  }

  execute() {
    boardCacheStore.persistAddTaskPlacement(
      this.boardId,
      this.def,
      this.position,
      this.style,
      this.targetSectionId,
    );
  }

  undo() {
    boardCacheStore.removeTaskPlacement(this.boardId, this.def.id);
    // The remove/add section-position shifts aren't symmetric at boundary
    // indices, so restoring the pre-add sections snapshot guarantees an
    // exact round-trip.
    if (this.sectionsBefore) {
      boardCacheStore.persistTaskListStructure(this.boardId, this.sectionsBefore.map((s) => ({ ...s })));
    }
  }
}

export class DeleteTaskCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private snapshotDef: TileDefinition | null;
  private snapshotPlacement: TaskPlacement | null;
  private sectionsBefore: TaskListSection[] | null;

  constructor(boardId: string, tileId: string) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    this.description = `Delete task`;
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
      // Phase 31 B4.4 — `this.snapshot(...)` deep-clones the def so the undo
      // snapshot captures every nested field (tags, frontmatter) intact.
      // Shallow `{...def}` left the `tags` array aliased with the cache, so a
      // subsequent tag-edit on a sibling tile (or external rewrite) corrupted
      // the snapshot before undo ever ran.
      if (def) this.snapshotDef = this.snapshot(def);
      this.sectionsBefore = ((tl.sections ?? []) as TaskListSection[]).map((s) => this.snapshot(s));
    }
  }

  execute() {
    boardCacheStore.removeTaskPlacement(this.boardId, this.tileId);
  }

  undo() {
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
    // Phase R3 — deep-clone via `this.snapshot(...)` so any nested style /
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
  private docId: string | null;
  private patch: Record<string, unknown>;
  private inversePatch: Record<string, unknown>;

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
    this.description = description ?? `Update task ${Object.keys(patch).join(', ')}`;
  }

  async execute(): Promise<void> {
    // Drain pending debounced writes before merging the new patch so the
    // prior in-memory state lands on disk first. Without this, a rapid
    // toggle → undo can race the still-debounced forward write against the
    // inverse patch's fresh write at the same docId.
    //
    // Phase 6 / 6.4 — must `await` rather than fire-and-forget; mirrors
    // UpdateCardFieldCommand. The previous `void` discarded the flush
    // completion, so a fast Apply → Undo would overlap: the forward
    // debounced write was still in-flight when undo queued the inverse
    // patch and the inverse landed on disk first.
    await flushAllPendingFrontmatterWrites();
    if (this.docId) documentStore.mergeFrontmatter(this.docId, this.patch);
    scheduleFrontmatterWrite(this.relPath, this.docId);
    boardCacheStore.markDirty(this.boardId);
  }

  async undo(): Promise<void> {
    await flushAllPendingFrontmatterWrites();
    if (this.docId) documentStore.mergeFrontmatter(this.docId, this.inversePatch);
    scheduleFrontmatterWrite(this.relPath, this.docId);
    boardCacheStore.markDirty(this.boardId);
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
    // Phase R3 — deep-clone the style payloads so nested colour / font
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

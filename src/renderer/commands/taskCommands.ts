import { Command, cloneForSnapshot } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { defTitle } from '../stores/noteMeta';
import type {
  TaskListBoard,
  TaskListSection,
  TileDefinition,
} from '../schema/index';
import type {
  TaskPlacement,
  PartialTaskStyle,
} from '../schema/placement';
import { NoteFieldCommand } from './noteFieldCommand';
import { restoreFiles, stillTrashed, trashFiles, type TrashedItem } from './trashedFiles';
import type { DrainToken } from '../lib/vault/vaultOperations';
import { applyMove, layoutOf, movedTasks, regroup, type SectionKey, type TaskLayout } from '../lib/tasklist/sectionMembership';

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

/** The live sections and tasks of a loaded Task List, or null. */
function liveTaskList(boardId: string): { sections: TaskListSection[]; tasks: TaskPlacement[] } | null {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'tasklist') return null;
  const tl = cached.board as TaskListBoard;
  return { sections: (tl.sections ?? []) as TaskListSection[], tasks: (tl.tasks ?? []) as TaskPlacement[] };
}

/**
 * Runs `change` (one task added or removed) and then recomputes every
 * section's start from the live order, so each other task stays in the
 * section it was in just before, whatever else changed the board since this
 * command was recorded. Putting back recorded absolute starts would misplace
 * tasks once anything else added or removed one. `placed` names the section a
 * task added by `change` belongs to.
 */
function keepingSections(boardId: string, change: () => void, placed: Record<string, SectionKey> = {}): void {
  const before = liveTaskList(boardId);
  change();
  const after = liveTaskList(boardId);
  if (!before || !after || after.sections.length === 0) return;
  const sectionOf = { ...layoutOf(before.sections, before.tasks).sectionOf, ...placed };
  const next = regroup(after.sections, after.tasks, sectionOf);
  boardCacheStore.persistTaskListStructure(boardId, next.sections, next.tasks);
}

/**
 * Where a task was: its section and that section's task order at the time,
 * so it can go back beside whichever of those neighbours are still there.
 */
interface TaskSpot {
  section: SectionKey;
  sectionOrder: string[];
}

function spotOf(boardId: string, tileId: string): TaskSpot | null {
  const live = liveTaskList(boardId);
  if (!live) return null;
  const { order, sectionOf } = layoutOf(live.sections, live.tasks);
  if (!Object.prototype.hasOwnProperty.call(sectionOf, tileId)) return null;
  const section = sectionOf[tileId] ?? null;
  return { section, sectionOrder: order.filter((id) => sectionOf[id] === section) };
}

/** The index in the live `tasks` a task at `spot` goes back to. */
function indexForSpot(boardId: string, tileId: string, spot: TaskSpot, fallback: number): number {
  const live = liveTaskList(boardId);
  if (!live) return fallback;
  const { sectionOf } = layoutOf(live.sections, live.tasks);
  const at = spot.sectionOrder.indexOf(tileId);
  const indexOf = (id: string): number =>
    sectionOf[id] === spot.section ? live.tasks.findIndex((p) => p.tileId === id) : -1;
  for (let k = at - 1; k >= 0; k--) {
    const idx = indexOf(spot.sectionOrder[k] ?? '');
    if (idx >= 0) return idx + 1;
  }
  for (let k = at + 1; k < spot.sectionOrder.length; k++) {
    const idx = indexOf(spot.sectionOrder[k] ?? '');
    if (idx >= 0) return idx;
  }
  const first = live.tasks.findIndex((p) => sectionOf[p.tileId] === spot.section);
  return first >= 0 ? first : Math.min(fallback, live.tasks.length);
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
    this.description = `Add task "${defTitle(def)}"`;
  }

  async execute(): Promise<void> {
    const isFirst = !this.hasExecuted;
    this.hasExecuted = true;
    // Placement first, synchronously (before any await) so callers/tests that
    // inspect the cache right after execute() — and the placement-only path
    // (file-drop, round-trip tests) — are unaffected.
    const add = (): void => boardCacheStore.persistAddTaskPlacement(
      this.boardId,
      this.def,
      this.position,
      this.style,
      this.targetSectionId,
    );
    // A redo lands on a board other changes may have reshaped since: the task
    // goes into its section and every other task stays in its own.
    if (isFirst || !this.targetSectionId) add();
    else keepingSections(this.boardId, add, { [this.def.id]: this.targetSectionId });
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
        this.def = { ...this.def, filePath: seeded.relPath } as TileDefinition;
        boardCacheStore.persistUpdateTile(this.def.id, { filePath: seeded.relPath }, this.boardId);
      }
    }
  }

  /** Title of the task as created. */
  get currentTitle(): string {
    return defTitle(this.def);
  }

  undo() {
    this.removePlacement();
  }

  private removePlacement(): void {
    keepingSections(this.boardId, () => boardCacheStore.removeTaskPlacement(this.boardId, this.def.id));
  }
}

/**
 * Opt-in backing-file delete. When the user picks "Delete task & file", the
 * note moves into Filo's trash with the task and undo moves it back. Absent
 * these options the command is placement-only and the file stays on disk.
 */
export interface DeleteTaskFileOptions {
  /** Vault-relative note to move into Filo's trash with the task. */
  filePath?: string;
  /** Vault root; required when `filePath` is set. */
  vaultRoot?: string;
  /**
   * The drained op the first execute runs inside, if any: its trash move then
   * runs under that drain instead of waiting for the op to finish.
   */
  drain?: DrainToken;
}

/**
 * Removes one task placement (and optionally its backing file).
 *
 * The task's section and that section's order are snapshotted in the
 * CONSTRUCTOR. Undo puts the task back beside the nearest of its old
 * neighbours still in that section, so tasks added or removed meanwhile
 * (another delete in the same batch, a cascade) don't shift where it lands.
 */
export class DeleteTaskCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private snapshotDef: TileDefinition | null;
  private snapshotPlacement: TaskPlacement | null;
  private spot: TaskSpot | null;
  // When set, execute() also moves the note into Filo's trash and undo()
  // moves it back BEFORE restoring the placement, as DeleteTilesCommand does.
  // Null on the default placement-only path.
  private filePath: string | null;
  private trashed: TrashedItem[] = [];
  private vaultRoot: string | undefined;
  /** For the first execute only; see `DeleteTaskFileOptions.drain`. */
  private drain: DrainToken | undefined;
  /** Last execute()'s move into the trash (resolves at once on the
   *  placement-only path). Awaited by tests / redo. */
  lastExecuteCompletion: Promise<unknown> = Promise.resolve();
  /** Last undo()'s restore from the trash. Awaited by tests / a sequencing redo. */
  lastUndoCompletion: Promise<unknown> = Promise.resolve();

  constructor(boardId: string, tileId: string, fileOpts: DeleteTaskFileOptions = {}) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    this.description = fileOpts.filePath ? `Delete task and file` : `Delete task`;
    this.filePath = fileOpts.filePath ?? null;
    this.vaultRoot = fileOpts.vaultRoot;
    this.drain = fileOpts.drain;
    const cached = boardCacheStore.cache[boardId];
    this.snapshotDef = null;
    this.snapshotPlacement = null;
    this.spot = null;
    if (cached && cached.board.type === 'tasklist') {
      const tl = cached.board as TaskListBoard;
      const placements = (tl.tasks ?? []) as TaskPlacement[];
      const p = placements.find((x) => x.tileId === tileId);
      if (p) this.snapshotPlacement = this.snapshot(p);
      const def = cached.tileDefs[tileId];
      // Deep-clone so a later tag edit or external rewrite can't mutate the
      // snapshot's nested fields (e.g. the `tags` array) through the cache.
      if (def) this.snapshotDef = this.snapshot(def);
      this.spot = spotOf(boardId, tileId);
    }
  }

  async execute() {
    // Placement removal stays synchronous (it runs before the first await), so
    // existing callers / tests that assert on cache state right after execute()
    // — and the placement-only path used by cascade / bulk delete — are
    // unaffected.
    boardCacheStore.removeTaskPlacement(this.boardId, this.tileId);
    if (this.vaultRoot && this.filePath) {
      const vaultRoot = this.vaultRoot;
      const rel = this.filePath;
      const drain = this.drain;
      this.drain = undefined;
      // Sequence behind any prior execute/undo so a rapid Ctrl+Y / Ctrl+Z
      // can't let this move race the prior undo's restore (the same guard
      // DeleteTilesCommand uses). Both priors are allSettled wrappers, so
      // awaiting them never rejects.
      const prior = Promise.allSettled([this.lastExecuteCompletion, this.lastUndoCompletion]);
      this.lastExecuteCompletion = prior.then(async () => {
        this.trashed = [...this.trashed, ...await trashFiles(vaultRoot, [rel], 'deleteTask.execute', drain)];
      });
      await this.lastExecuteCompletion;
    } else {
      this.lastExecuteCompletion = Promise.resolve();
    }
  }

  async undo() {
    if (!this.vaultRoot || !this.filePath) {
      // Placement-only: nothing on disk to wait for.
      this.lastUndoCompletion = Promise.resolve();
      this.restorePlacement();
      return;
    }
    // File first: the note comes back before the placement so
    // `persistAddTaskPlacement`'s seed-check finds it and never seeds an
    // empty note (as DeleteTilesCommand does).
    const prior = Promise.allSettled([this.lastExecuteCompletion, this.lastUndoCompletion]);
    this.lastUndoCompletion = prior.then(async () => {
      if (this.vaultRoot && this.trashed.length > 0) {
        const restored = await restoreFiles(this.vaultRoot, this.trashed, 'deleteTask.undo');
        this.trashed = stillTrashed(this.trashed, restored);
        const moved = restored.find((r) => r.restoredPath !== r.rel);
        if (moved) {
          // The task follows the restored copy, and a redo trashes it, not a
          // newer file that took the old name meanwhile.
          this.filePath = moved.restoredPath;
          if (this.snapshotDef && this.snapshotDef.type === 'text') {
            this.snapshotDef = { ...this.snapshotDef, filePath: moved.restoredPath };
          }
        }
      }
    });
    await this.lastUndoCompletion;
    this.restorePlacement();
  }

  private restorePlacement(): void {
    const def = this.snapshotDef;
    const placement = this.snapshotPlacement;
    if (!def || !placement) return;
    const spot = this.spot;
    const index = spot ? indexForSpot(this.boardId, this.tileId, spot, placement.position) : placement.position;
    keepingSections(
      this.boardId,
      () => boardCacheStore.persistAddTaskPlacement(this.boardId, def, index, placement.style, undefined, placement),
      spot ? { [this.tileId]: spot.section } : {},
    );
  }
}

/**
 * A move of tasks within or between the sections of a Task List (drag, move
 * to section, keyboard reorder). It keeps only the move: the tasks that moved
 * and the order and section of every task before and after (ids only). Undo
 * and redo put just those tasks back beside their old or new neighbours on
 * the board as it is then, and recompute the section starts, so a task added
 * or removed meanwhile (off this stack) is neither undone nor misplaced. A
 * whole-array snapshot would put back the arrays as they were.
 */
export class MoveTaskBlockCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private moved: string[];
  private layoutBefore: TaskLayout;
  private layoutAfter: TaskLayout;

  constructor(
    boardId: string,
    before: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    after: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    description = 'Move tasks',
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.layoutBefore = this.snapshot(layoutOf(before.sections, before.tasks));
    this.layoutAfter = this.snapshot(layoutOf(after.sections, after.tasks));
    this.moved = movedTasks(this.layoutBefore, this.layoutAfter);
    this.description = description;
  }

  execute() {
    this.apply(this.layoutAfter);
  }

  undo() {
    this.apply(this.layoutBefore);
  }

  private apply(target: TaskLayout): void {
    const live = liveTaskList(this.boardId);
    if (!live) return;
    const next = applyMove(live.sections, live.tasks, this.moved, target);
    boardCacheStore.persistTaskListStructure(this.boardId, next.sections, next.tasks);
  }
}

/**
 * A change to a task's note frontmatter (`completed`, due date, priority…).
 * See `NoteFieldCommand` for the execute / undo / redo rules. `atomic`
 * keeps a recurrence roll-forward (`completed` + `dueDate`) in one piece.
 */
export class UpdateTaskFieldCommand extends NoteFieldCommand {
  constructor(
    boardId: string,
    relPath: string,
    patch: Record<string, unknown>,
    inversePatch: Record<string, unknown>,
    description?: string,
    atomic = false,
    forwardFrom: ((fm: Readonly<Record<string, unknown>>) => Record<string, unknown>) | null = null,
  ) {
    super(boardId, relPath, patch, inversePatch, description ?? `Update task ${Object.keys(patch).join(', ')}`, atomic, forwardFrom);
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
 * Alt+Up / Alt+Down within a Task List section. Delegates to
 * `MoveTaskBlockCommand` so the actual replay path is the same proven
 * snapshot/restore that drag-reorder uses — this class is the entry point
 * keyboard handlers call.
 */
// allow-own-board-only: its inner move is on the same board
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

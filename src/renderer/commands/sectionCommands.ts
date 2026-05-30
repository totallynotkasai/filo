import { Command } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import type { TaskListSection } from '../schema/index';
import type { TaskPlacement } from '../schema/placement';
import { snapshotTaskListSlice, restoreTaskListSlice } from './taskCommands';

export class AddSectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  /**
   * Phase 31 A6.1 — captured DELTA: the single new section, identified by
   * ID. Avoids the snapshot-replace trap where an out-of-band add/delete
   * between execute and undo would be silently reverted by replaying the
   * whole sections array.
   */
  private newSection: TaskListSection;

  constructor(
    boardId: string,
    // Legacy params kept for sectionOps call-site compatibility. The
    // `after` array is consulted only to find the newly-added section
    // (matching it by id-not-in-before); everything else falls through
    // to the live cache read at execute/undo time.
    before: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    after: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    title: string,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    const beforeIds = new Set(before.sections.map((s) => s.id));
    const newSection = after.sections.find((s) => !beforeIds.has(s.id));
    if (!newSection) {
      // Fallback to the last after-section (legacy callers always append).
      const last = after.sections[after.sections.length - 1];
      // allow-shallow: TaskListSection has primitive fields only (id,
      // title, position, collapsed).
      this.newSection = last ? { ...last } : { id: '', title, position: 0, collapsed: false };
    } else {
      // allow-shallow: TaskListSection is primitive-only.
      this.newSection = { ...newSection };
    }
    this.description = `Add section "${title}"`;
  }

  execute() {
    const cached = boardCacheStore.cache[this.boardId];
    const board = cached?.board as { sections?: TaskListSection[] } | undefined;
    if (!board?.sections) return;
    // No-op if a re-execute hits a tree that already contains the section
    // (out-of-band re-add or redo after partial undo).
    if (board.sections.some((s) => s.id === this.newSection.id)) return;
    boardCacheStore.persistTaskListStructure(this.boardId, [
      ...board.sections,
      { ...this.newSection },
    ]);
  }

  undo() {
    const cached = boardCacheStore.cache[this.boardId];
    const board = cached?.board as { sections?: TaskListSection[] } | undefined;
    if (!board?.sections) return;
    boardCacheStore.persistTaskListStructure(
      this.boardId,
      board.sections.filter((s) => s.id !== this.newSection.id),
    );
  }
}

export class DeleteSectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private before: ReturnType<typeof snapshotTaskListSlice>;
  private after: ReturnType<typeof snapshotTaskListSlice>;

  constructor(
    boardId: string,
    before: ReturnType<typeof snapshotTaskListSlice>,
    after: ReturnType<typeof snapshotTaskListSlice>,
    title: string,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // Phase R3 — deep-clone via `this.snapshot(...)` so nested style fields
    // on `tileDefs[]` and Task placements stay detached from the live cache.
    this.before = before ? this.snapshot(before) : null;
    this.after = after ? this.snapshot(after) : null;
    this.description = `Delete section "${title}"`;
  }

  execute() {
    if (!this.after) return;
    restoreTaskListSlice(this.boardId, this.after);
  }

  undo() {
    if (!this.before) return;
    restoreTaskListSlice(this.boardId, this.before);
  }
}

export class RenameSectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private sectionId: string;
  private prevTitle: string;
  private nextTitle: string;

  constructor(
    boardId: string,
    sectionId: string,
    prevTitle: string,
    nextTitle: string,
    // Phase 31 A6.1 — the third argument (legacy snapshot of sectionsBefore)
    // is retained for back-compat with sectionOps's call site but no longer
    // used. The delta-aware apply reads CURRENT sections from the cache so
    // an out-of-band AddSection / DeleteSection between execute and undo
    // doesn't get reverted alongside this rename.
    _sectionsBefore?: TaskListSection[],
  ) {
    super();
    void _sectionsBefore;
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.sectionId = sectionId;
    this.prevTitle = prevTitle;
    this.nextTitle = nextTitle;
    this.description = `Rename section to "${nextTitle}"`;
  }

  private apply(title: string) {
    // A6.1 — read the LIVE sections, mutate only the matching ID, write back.
    // The previous implementation rebuilt the array from a constructor-time
    // snapshot, which would drop any sections added out-of-band.
    const cached = boardCacheStore.cache[this.boardId];
    const board = cached?.board as { sections?: TaskListSection[] } | undefined;
    if (!board?.sections) return;
    const next = board.sections.map((s) =>
      s.id === this.sectionId ? { ...s, title } : s,
    );
    boardCacheStore.persistTaskListStructure(this.boardId, next);
  }

  execute() { this.apply(this.nextTitle); }
  undo() { this.apply(this.prevTitle); }
}

export class ReorderSectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private before: { sections: TaskListSection[]; tasks: TaskPlacement[] };
  private after: { sections: TaskListSection[]; tasks: TaskPlacement[] };

  constructor(
    boardId: string,
    before: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    after: { sections: TaskListSection[]; tasks: TaskPlacement[] },
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // Phase R3 — deep-clone the structure so style fields on placements
    // can't leak through from the live cache to the snapshot.
    this.before = this.snapshot(before);
    this.after = this.snapshot(after);
    this.description = `Reorder sections`;
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

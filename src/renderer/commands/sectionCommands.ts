import { Command, cloneForSnapshot } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import type { TaskListSection, TileDefinition } from '../schema/index';
import type { TaskPlacement } from '../schema/placement';
import { snapshotTaskListSlice } from './taskCommands';

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
  /**
   * Phase 31 A6.1 / Audit5 2.5 (#9) — captured DELTA, not a whole-slice
   * snapshot. `removedSection` is the deleted section marker; `removedPlacements`
   * + `removedDefs` are the section's OWN tasks (delete-tasks mode only — both
   * empty for keep-tasks). execute/undo apply this delta against the LIVE cache,
   * so a task added/edited (or a sibling section renamed/collapsed) between
   * execute and undo survives — the prior `restoreTaskListSlice` replay reverted
   * the whole `tileDefs`/`tasks`/`sections` arrays, silently undoing those
   * out-of-band edits (the wholesale `tileDefs` clobber lost sibling content).
   */
  private removedSection: TaskListSection;
  private removedPlacements: TaskPlacement[];
  private removedDefs: Record<string, TileDefinition>;

  constructor(
    boardId: string,
    before: ReturnType<typeof snapshotTaskListSlice>,
    after: ReturnType<typeof snapshotTaskListSlice>,
    title: string,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    // Derive the delta from the before/after slice diff (keeps sectionOps'
    // call shape unchanged). The deleted section is present in `before` but
    // absent from `after`; the removed tasks are those in `before.tasks` not in
    // `after.tasks` (an empty set means keep-tasks mode — only the marker goes).
    const beforeSections = before?.sections ?? [];
    const afterSectionIds = new Set((after?.sections ?? []).map((s) => s.id));
    const removed = beforeSections.find((s) => !afterSectionIds.has(s.id));
    this.removedSection = this.snapshot(
      removed ?? { id: '', title, position: 0, collapsed: false },
    );
    const afterTileIds = new Set((after?.tasks ?? []).map((p) => p.tileId));
    const removedPlacements = (before?.tasks ?? []).filter(
      (p) => !afterTileIds.has(p.tileId),
    );
    this.removedPlacements = this.snapshot(removedPlacements);
    const removedDefs: Record<string, TileDefinition> = {};
    for (const p of removedPlacements) {
      const def = before?.defs?.[p.tileId];
      if (def) removedDefs[p.tileId] = def;
    }
    this.removedDefs = this.snapshot(removedDefs);
    this.description = `Delete section "${title}"`;
  }

  execute() {
    const board = boardCacheStore.cache[this.boardId]?.board as
      | { sections?: TaskListSection[] }
      | undefined;
    if (!board?.sections) return;
    // delete-tasks mode: drop each owned task. removeTaskPlacement also drops
    // its def and shifts section positions; no-op set in keep-tasks mode.
    for (const p of this.removedPlacements) {
      boardCacheStore.removeTaskPlacement(this.boardId, p.tileId);
    }
    // Remove ONLY the deleted section marker from the LIVE sections — any
    // out-of-band section add / rename / collapse stays intact.
    const liveSections =
      ((boardCacheStore.cache[this.boardId]?.board as { sections?: TaskListSection[] })
        ?.sections ?? []) as TaskListSection[];
    boardCacheStore.persistTaskListStructure(
      this.boardId,
      liveSections.filter((s) => s.id !== this.removedSection.id),
    );
  }

  undo() {
    const cached = boardCacheStore.cache[this.boardId];
    if (!cached || cached.board.type !== 'tasklist') return;
    // Restore the section's defs by MERGING into the live map — preserves any
    // def added/edited out-of-band and brings back the ones execute removed.
    if (Object.keys(this.removedDefs).length > 0) {
      boardCacheStore.updateEntry(this.boardId, {
        tileDefs: { ...cached.tileDefs, ...cloneForSnapshot(this.removedDefs) },
      });
    }
    const board = cached.board as {
      sections?: TaskListSection[];
      tasks?: TaskPlacement[];
    };
    const liveTasks = [...((board.tasks ?? []) as TaskPlacement[])];
    const liveSections = (board.sections ?? []) as TaskListSection[];
    // Re-insert the section's tasks as a contiguous block at the section's
    // original start, shift live sections at/after that point, then re-insert
    // the marker. Full placement objects are spliced back (style/locked and any
    // passthrough field intact), unlike a persistAddTaskPlacement re-add.
    const insertAt = Math.min(Math.max(this.removedSection.position, 0), liveTasks.length);
    const block = this.removedPlacements.map((p) => ({ ...p }));
    const shiftedSections = liveSections.map((s) =>
      s.position >= insertAt ? { ...s, position: s.position + block.length } : { ...s },
    );
    const nextSections = [
      ...shiftedSections,
      { ...this.removedSection, position: insertAt },
    ];
    if (block.length > 0) {
      const nextTasks = [
        ...liveTasks.slice(0, insertAt),
        ...block,
        ...liveTasks.slice(insertAt),
      ];
      boardCacheStore.persistTaskListStructure(this.boardId, nextSections, nextTasks);
    } else {
      // keep-tasks mode: leave the tasks array untouched (no tasks arg).
      boardCacheStore.persistTaskListStructure(this.boardId, nextSections);
    }
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

/**
 * Audit-6 H1 — apply a target section ORDER to the LIVE Task List cache.
 *
 * Section `position` values are absolute indices into the flat `tasks` array,
 * so the sections partition that array into contiguous slices. Reordering the
 * sections means permuting those slices and re-deriving the positions. We read
 * the slices LIVE (current section boundaries) and carry each one along with
 * its section, so:
 *  - an out-of-band task add/edit (which changed a slice's contents/length)
 *    rides through the reorder and its undo intact;
 *  - a section deleted out-of-band drops out (filtered against the live set);
 *  - a section ADDED out-of-band is appended in live order so it isn't lost.
 *
 * Bails (safe no-op) if the board vanished or isn't a tasklist.
 */
function applySectionOrderLive(boardId: string, targetOrder: string[]): void {
  if (targetOrder.length === 0) return;
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== 'tasklist') return;
  const board = cached.board as { sections?: TaskListSection[]; tasks?: TaskPlacement[] };
  const liveSorted = [...((board.sections ?? []) as TaskListSection[])].sort(
    (a, b) => a.position - b.position,
  );
  if (liveSorted.length === 0) return;
  const liveTasks = (board.tasks ?? []) as TaskPlacement[];

  // Tasks before the first section's start index belong to no section (a
  // leading "Unsectioned" bucket); keep them anchored at the front.
  const headSlice = liveTasks.slice(0, Math.max(0, liveSorted[0].position));

  // Each live section owns the contiguous slice [position, nextPosition).
  const sliceById = new Map<string, TaskPlacement[]>();
  const sectionById = new Map<string, TaskListSection>();
  for (let i = 0; i < liveSorted.length; i++) {
    const s = liveSorted[i];
    const start = s.position;
    const end = liveSorted[i + 1]?.position ?? liveTasks.length;
    sliceById.set(s.id, liveTasks.slice(start, end));
    sectionById.set(s.id, s);
  }

  // Requested order (filtered to sections that still exist) + any section added
  // out-of-band since the command was captured, appended in live order.
  const targetSet = new Set(targetOrder);
  const orderedIds = [
    ...targetOrder.filter((id) => sectionById.has(id)),
    ...liveSorted.filter((s) => !targetSet.has(s.id)).map((s) => s.id),
  ];

  // Re-derive the flat task array + section positions from the slices.
  const nextTasks: TaskPlacement[] = [...headSlice];
  const nextSections: TaskListSection[] = [];
  let cursor = headSlice.length;
  for (const id of orderedIds) {
    const section = sectionById.get(id);
    if (!section) continue;
    const slice = sliceById.get(id) ?? [];
    nextSections.push({ ...section, position: cursor });
    nextTasks.push(...slice);
    cursor += slice.length;
  }
  boardCacheStore.persistTaskListStructure(boardId, nextSections, nextTasks);
}

export class ReorderSectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  /**
   * Audit-6 H1 — the full section-id ORDER before/after the reorder.
   *
   * `moveSection` (context-menu Move up/down) transposes one adjacent pair, but
   * a svelte-dnd-action section drag can move a section across MULTIPLE slots,
   * changing 3+ positions at once. The prior Audit5 adjacent-swap encoding only
   * set `idA/idB` when EXACTLY two positions changed — so a multi-slot drag left
   * both empty and execute/undo were silent no-ops: the dragged section snapped
   * back and the move wasn't undoable. Capturing the WHOLE order makes the
   * command a general N-section reorder, applied against the LIVE cache so an
   * out-of-band task add/edit or sibling collapse between execute and undo still
   * survives (see `applySectionOrderLive`). Adjacent swaps stay correct — they
   * are just the 2-element case of an N-element permutation.
   */
  private beforeOrder: string[];
  private afterOrder: string[];
  /** True when before/after orders are identical — execute/undo are no-ops. */
  private isNoop: boolean;

  constructor(
    boardId: string,
    before: { sections: TaskListSection[]; tasks: TaskPlacement[] },
    after: { sections: TaskListSection[]; tasks: TaskPlacement[] },
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.beforeOrder = [...before.sections]
      .sort((a, b) => a.position - b.position)
      .map((s) => s.id);
    this.afterOrder = [...after.sections]
      .sort((a, b) => a.position - b.position)
      .map((s) => s.id);
    this.isNoop =
      this.beforeOrder.length === this.afterOrder.length &&
      this.beforeOrder.every((id, i) => id === this.afterOrder[i]);
    this.description = `Reorder sections`;
  }

  execute() {
    if (this.isNoop) return;
    applySectionOrderLive(this.boardId, this.afterOrder);
  }

  undo() {
    if (this.isNoop) return;
    applySectionOrderLive(this.boardId, this.beforeOrder);
  }
}

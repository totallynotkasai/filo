import { Command, cloneForSnapshot } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import type { TaskListSection, TileDefinition } from '../schema/index';
import type { TaskPlacement } from '../schema/placement';
import { snapshotTaskListSlice } from './taskCommands';
import { applyMove, layoutOf, type TaskLayout } from '../lib/tasklist/sectionMembership';

export class AddSectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  /**
   * Captured DELTA: the single new section, identified by ID. Replaying the
   * whole sections array would silently revert an out-of-band add/delete
   * made between execute and undo.
   */
  private newSection: TaskListSection;
  /**
   * When this add was the FIRST real section on a section-less board, it also
   * materialises the virtual `__default__` placeholder into a real section (so
   * existing unsectioned tasks keep a home). Folding it into the command lets
   * undo strip BOTH and restore the section-less `[]` state. Null when the
   * board already had a persisted section.
   */
  private autoDefault: TaskListSection | null;

  constructor(boardId: string, newSection: TaskListSection, autoDefault: TaskListSection | null = null) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.autoDefault = autoDefault ? this.snapshot(autoDefault) : null;
    // Deep-clone: TaskListSection carries an optional nested `style` object,
    // which a shallow spread would alias to the live section.
    this.newSection = this.snapshot(newSection);
    this.description = `Add section "${newSection.title}"`;
  }

  execute() {
    const cached = boardCacheStore.cache[this.boardId];
    const board = cached?.board as { sections?: TaskListSection[] } | undefined;
    if (!board?.sections) return;
    let sections = board.sections as TaskListSection[];
    // Re-materialise the auto-default first. On the FIRST execute this
    // turns the section-less `[]` into `[default]`; on a redo (after an undo that
    // stripped the board back to `[]`) it restores the default the same way. At
    // position 0 it owns the leading unsectioned tasks; persistTaskListStructure
    // clamps/normalises positions, so the new tail section lands correctly.
    const auto = this.autoDefault;
    if (auto && !sections.some((s) => s.id === auto.id)) {
      sections = [this.snapshot(auto), ...sections];
    }
    // No-op the new-section add if it's already present (out-of-band re-add or
    // redo after a partial undo) — but still persist if we just re-added the
    // default above.
    if (sections.some((s) => s.id === this.newSection.id)) {
      if (sections !== board.sections) {
        boardCacheStore.persistTaskListStructure(this.boardId, sections);
      }
      return;
    }
    boardCacheStore.persistTaskListStructure(this.boardId, [
      ...sections,
      // Deep-clone again so the persisted copy can't alias this command's
      // retained `newSection.style`.
      this.snapshot(this.newSection),
    ]);
  }

  undo() {
    const cached = boardCacheStore.cache[this.boardId];
    const board = cached?.board as { sections?: TaskListSection[] } | undefined;
    if (!board?.sections) return;
    let next = (board.sections as TaskListSection[]).filter((s) => s.id !== this.newSection.id);
    // Also strip the auto-materialised default when it's the ONLY section
    // left (nothing else was added since, so the board is back to its "section-
    // less + one add" shape). Restoring `[]` makes add-then-undo a true on-disk
    // no-op; the virtual default re-appears. When other real sections exist the
    // default is now load-bearing (it partitions the task array) — leave it.
    const auto = this.autoDefault;
    if (auto && next.length === 1 && next[0]?.id === auto.id) {
      next = [];
    }
    boardCacheStore.persistTaskListStructure(this.boardId, next);
  }
}

export class DeleteSectionCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  /**
   * Captured DELTA, not a whole-slice snapshot. `removedSection` is the deleted
   * section marker; `removedPlacements` + `removedDefs` are the section's OWN
   * tasks (delete-tasks mode only — both empty for keep-tasks). execute/undo
   * apply this delta against the LIVE cache, so out-of-band edits to other
   * tasks/sections made between execute and undo survive.
   */
  private removedSection: TaskListSection;
  private removedPlacements: TaskPlacement[];
  private removedDefs: Record<string, TileDefinition>;
  /**
   * Ids of the sections that FOLLOWED the removed one in array order at
   * construction time. Among sections tied at the same `position` the LAST in
   * array order owns the slice (see `persistTaskListStructure`), so undo must
   * re-insert the marker at its original slot: appending a restored EMPTY
   * section after its tied successor would re-home all the successor's tasks
   * into it. undo() splices the marker in front of the first surviving
   * successor, or appends when none survive (the original tail slot).
   */
  private successorIds: string[];
  /**
   * Where every task sat before the delete, and which of them were the
   * section's. Undo puts those back in the section beside their old
   * neighbours on the board as it is then; section starts are absolute
   * indices, so restoring the recorded start would re-home whatever tasks
   * an add or remove elsewhere had shifted there.
   */
  private beforeLayout: TaskLayout;
  private memberIds: string[];

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
    // Capture the array-order successors as the undo re-insert anchor.
    const removedIdx = removed ? beforeSections.indexOf(removed) : -1;
    this.successorIds =
      removedIdx >= 0 ? beforeSections.slice(removedIdx + 1).map((s) => s.id) : [];
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
    this.beforeLayout = layoutOf(beforeSections, before?.tasks ?? []);
    this.memberIds = this.beforeLayout.order.filter(
      (id) => removed !== undefined && this.beforeLayout.sectionOf[id] === removed.id,
    );
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
    // The section's own placements come back whole (style, lock and any
    // passthrough field intact), appended for now; applyMove places them.
    const live = new Set(((board.tasks ?? []) as TaskPlacement[]).map((p) => p.tileId));
    const tasks = [
      ...((board.tasks ?? []) as TaskPlacement[]),
      ...this.removedPlacements.filter((p) => !live.has(p.tileId)).map((p) => ({ ...p })),
    ];
    const liveSections = ((board.sections ?? []) as TaskListSection[]).map((s) => ({ ...s }));
    // The marker goes back at its original array slot (before the first
    // surviving successor, see `successorIds`), starting where that
    // successor starts: tied, the later section owns the rows, so the
    // marker owns nothing until applyMove moves its tasks into it.
    const successorSet = new Set(this.successorIds);
    const markerIdx = liveSections.findIndex((s) => successorSet.has(s.id));
    const successor = markerIdx >= 0 ? liveSections[markerIdx] : undefined;
    const marker = { ...this.removedSection, position: successor?.position ?? tasks.length };
    const sections =
      markerIdx >= 0
        ? [...liveSections.slice(0, markerIdx), marker, ...liveSections.slice(markerIdx)]
        : [...liveSections, marker];
    const next = applyMove(sections, tasks, this.memberIds, this.beforeLayout);
    boardCacheStore.persistTaskListStructure(this.boardId, next.sections, next.tasks);
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
    // The third argument (sectionsBefore) is unused, kept for sectionOps's call
    // site. The apply reads CURRENT sections from the cache so an out-of-band
    // add/delete between execute and undo isn't reverted with this rename.
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
    // Read the LIVE sections, mutate only the matching ID, write back, so
    // sections added out-of-band aren't dropped.
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
 * Folds or opens a Task List section. An undo step, as folding a Kanban
 * column, a frame or a task's subtasks is: a fold saved in the board is one
 * policy everywhere. Applied to the live section by id, so a section added or
 * renamed between execute and undo is left as it is.
 */
export class SetSectionCollapsedCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private sectionId: string;
  private collapsed: boolean;

  constructor(boardId: string, sectionId: string, collapsed: boolean) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.sectionId = sectionId;
    this.collapsed = collapsed;
    this.description = collapsed ? 'Collapse section' : 'Expand section';
  }

  private apply(collapsed: boolean) {
    const board = boardCacheStore.cache[this.boardId]?.board as { sections?: TaskListSection[] } | undefined;
    if (!board?.sections?.some((s) => s.id === this.sectionId && s.collapsed !== collapsed)) return;
    const next = board.sections.map((s) => (s.id === this.sectionId ? { ...s, collapsed } : s));
    boardCacheStore.persistTaskListStructure(this.boardId, next);
  }

  execute() { this.apply(this.collapsed); }
  undo() { this.apply(!this.collapsed); }
}

/**
 * Apply a target section ORDER to the LIVE Task List cache.
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
  const headSlice = liveTasks.slice(0, Math.max(0, liveSorted[0]?.position ?? 0));

  // Each live section owns the contiguous slice [position, nextPosition).
  const sliceById = new Map<string, TaskPlacement[]>();
  const sectionById = new Map<string, TaskListSection>();
  for (let i = 0; i < liveSorted.length; i++) {
    const s = liveSorted[i];
    if (!s) continue; // i < liveSorted.length; narrow for the type-checker
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
   * The full section-id ORDER before/after the reorder.
   *
   * A section drag can move a section across MULTIPLE slots, so the command is
   * a general N-section reorder (an adjacent swap is the 2-element case),
   * applied against the LIVE cache so out-of-band edits between execute and
   * undo survive (see `applySectionOrderLive`).
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

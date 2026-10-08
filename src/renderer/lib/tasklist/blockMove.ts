/**
 * Task-block math for Task List Board drag operations.
 *
 * A "block" is the set of placements that move together as a single drag
 * unit: the dragged task plus every transitive subtask under it, and — when
 * the drag originated from a multi-selected row — every other selected task
 * (plus *their* descendants).
 *
 * These helpers are pure. They operate on a row view of `(tileId, parent)`
 * pairs so they don't depend on the full TaskRow projection; callers pass in
 * the rows they already have. No DOM, no Svelte, no store access.
 */

import type { TaskPlacement, TaskListSection } from '../../schema/index';

/**
 * Minimal row shape needed by these helpers — accepting just `tile.id` and
 * `parent` keeps the API decoupled from TaskRow's full projection and makes
 * unit testing trivial.
 */
export interface RowLike {
  tile: { id: string };
  parent: string;
}

/**
 * Returns `[tileId, ...transitive descendants]` in DFS order. Defensive
 * against cycles via a visited set — if the data is corrupt and a parent
 * chain loops back, we stop rather than recursing forever.
 */
export function collectDescendantIds(rows: RowLike[], tileId: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const r of rows) {
      if (r.parent === id) walk(r.tile.id);
    }
  };
  walk(tileId);
  return out;
}

/**
 * Where a new subtask of `parentTileId` goes in `placements`: after the last
 * task under the parent (its subtasks and theirs) in the parent's section, so
 * subtasks stay in the order they were added. Siblings show in placement
 * order, so right after the parent would put the newest first. Past the
 * section's end the task would join the next section. The end of the list
 * when the parent isn't placed.
 */
export function subtaskInsertIndex(
  rows: RowLike[],
  placements: TaskPlacement[],
  sections: TaskListSection[],
  parentTileId: string,
): number {
  const parentIdx = placements.findIndex((p) => p.tileId === parentTileId);
  if (parentIdx < 0) return placements.length;
  const sectionEnd = sections.reduce(
    (end, s) => (s.position > parentIdx && s.position < end ? s.position : end),
    placements.length,
  );
  const under = new Set(collectDescendantIds(rows, parentTileId));
  let last = parentIdx;
  for (let i = parentIdx + 1; i < sectionEnd; i++) {
    const tileId = placements[i]?.tileId;
    if (tileId !== undefined && under.has(tileId)) last = i;
  }
  return last + 1;
}

/**
 * Walks the parent chain and returns the depth in the subtask hierarchy:
 * 0 = top-level, 1 = subtask, 2 = sub-subtask. Returns `Infinity` if a cycle
 * is detected (defensive, capped at 8 hops). Used to enforce the 3-level cap.
 */
export function getTaskDepth(rows: RowLike[], tileId: string): number {
  return depthOf(new Map(rows.map((r) => [r.tile.id, r])), tileId);
}

/**
 * Every row's depth (as `getTaskDepth`), sharing one lookup, for a view that
 * shows them all: `getTaskDepth` per row builds its lookup each time.
 */
export function buildTaskDepths(rows: RowLike[]): Map<string, number> {
  const byId = new Map(rows.map((r) => [r.tile.id, r]));
  return new Map(rows.map((r) => [r.tile.id, depthOf(byId, r.tile.id)]));
}

function depthOf(byId: Map<string, RowLike>, tileId: string): number {
  let depth = 0;
  let current = byId.get(tileId);
  let safety = 0;
  while (current?.parent && safety < 8) {
    depth++;
    current = byId.get(current.parent);
    safety++;
  }
  return safety >= 8 ? Infinity : depth;
}

/**
 * Returns the full set of tile ids participating in a drag, in placement
 * order. `seeds` is the set of tiles the user dragged (one for solo drag,
 * many for multi-select); the helper expands each to include its
 * descendants, then orders the union to match the current placements array
 * so the block stays contiguous on drop.
 */
export function resolveDragBlockIds(
  rows: RowLike[],
  placements: TaskPlacement[],
  seeds: string[],
): string[] {
  const seen = new Set<string>();
  for (const id of seeds) {
    for (const descId of collectDescendantIds(rows, id)) seen.add(descId);
  }
  const ordered: string[] = [];
  for (const p of placements) {
    if (seen.has(p.tileId)) ordered.push(p.tileId);
  }
  return ordered;
}

/**
 * Per-section svelte-dnd-action items array shape. The library identifies
 * each item by `id`; we keep it minimal so the items mirror is cheap to
 * shallow-compare on every drag-tick.
 */
export interface RowDndItem {
  id: string;
}

/**
 * Build the post-drop placements array from svelte-dnd-action's per-section
 * `items` mirrors. Section `position` markers are recomputed from the new
 * ordering. The renderer emits one zone per visible section (real + leading
 * synthetic); this helper concatenates them in `displaySections` order
 * and renumbers `position`.
 *
 * `itemsBySection` keys must include exactly the same set of section ids
 * present in `displaySectionsOrdered` (or the matching `leadingSectionId`).
 * Missing keys fall back to the pre-drop slice for that section so a partial
 * mirror never erases a section's rows.
 */
export function rebuildPlacementsFromDndItems(args: {
  placements: TaskPlacement[];
  sections: TaskListSection[];
  /** Section ids in render order. Leading bucket (id === leadingSectionId)
   * may appear in this list. Real sections must include their persisted id. */
  displaySectionIds: string[];
  /** Sentinel id used by the renderer for the synthetic leading bucket. */
  leadingSectionId: string;
  /** Per-section new items lists from dndzone consider/finalize events. */
  itemsBySection: Record<string, RowDndItem[]>;
}): { placements: TaskPlacement[]; sections: TaskListSection[] } {
  const { placements, sections, displaySectionIds, leadingSectionId, itemsBySection } = args;
  const placementByTileId = new Map(placements.map((p) => [p.tileId, p]));
  const sortedSections = [...sections].sort((a, b) => a.position - b.position);

  // Pre-drop slice per section id (for fallback when the items mirror is
  // missing a section that didn't participate in the drag).
  const leadingEnd = sortedSections[0]?.position ?? placements.length;
  const fallbackSlice = new Map<string, TaskPlacement[]>();
  fallbackSlice.set(leadingSectionId, placements.slice(0, leadingEnd));
  for (let i = 0; i < sortedSections.length; i++) {
    const s = sortedSections[i];
    if (!s) continue; // i < sortedSections.length; narrow for the type-checker
    const start = s.position;
    const end = sortedSections[i + 1]?.position ?? placements.length;
    fallbackSlice.set(s.id, placements.slice(start, end));
  }
  const realSectionById = new Map(sections.map((s) => [s.id, s]));
  // A drawn id that is neither a real section nor the leading bucket is the
  // board's stand-in "Task List" section (a board with no sections), which
  // holds every task no real section owns: the leading bucket's.
  const sliceBefore = (sid: string): TaskPlacement[] =>
    fallbackSlice.get(sid) ?? (realSectionById.has(sid) ? [] : (fallbackSlice.get(leadingSectionId) ?? []));

  // The mirrors hold only the rows on screen. Rows hidden by a collapsed
  // parent, "Show completed" off, a smart list or a filter are in no mirror,
  // and rebuilding from the mirrors alone would drop them from the board.
  const onScreen = new Set<string>();
  for (const sid of displaySectionIds) {
    for (const it of itemsBySection[sid] ?? []) onScreen.add(it.id);
  }

  const nextPlacements: TaskPlacement[] = [];
  const nextSections: TaskListSection[] = [];
  const emitted = new Set<string>();
  let cursor = 0;

  for (const sid of displaySectionIds) {
    const items = itemsBySection[sid];
    let slice: TaskPlacement[];
    if (items) {
      // Map items back to placements; drop any unknown ids defensively.
      const visible = items
        .map((it) => placementByTileId.get(it.id))
        .filter((p): p is TaskPlacement => p !== undefined);
      slice = withHiddenRows(visible, sliceBefore(sid), onScreen);
    } else {
      slice = sliceBefore(sid);
    }
    slice = slice.filter((p) => {
      if (emitted.has(p.tileId)) return false;
      emitted.add(p.tileId);
      return true;
    });

    if (sid !== leadingSectionId) {
      const real = realSectionById.get(sid);
      if (real) nextSections.push({ ...real, position: cursor });
    }
    nextPlacements.push(...slice);
    cursor += slice.length;
  }

  // Sections that didn't render (e.g. legacy out-of-display) keep their
  // entries appended at the end with their original relative order so we
  // don't silently drop them.
  for (const s of sections) {
    if (nextSections.find((ns) => ns.id === s.id)) continue;
    nextSections.push({ ...s, position: cursor });
    const slice = (fallbackSlice.get(s.id) ?? []).filter((p) => !emitted.has(p.tileId));
    for (const p of slice) emitted.add(p.tileId);
    nextPlacements.push(...slice);
    cursor += slice.length;
  }

  // Renumber placements 0..n.
  const renumbered = nextPlacements.map((p, i) => ({ ...p, position: i }));

  // Restore the caller's original section ordering by id so undo/redo can
  // diff cleanly against `snapshotSections()` shape.
  const orderById = new Map(sections.map((s, i) => [s.id, i]));
  nextSections.sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0));

  return { placements: renumbered, sections: nextSections };
}

/**
 * Put a section's hidden rows back among its visible rows after a drop. Each
 * hidden row follows the visible row it followed before (the nearest earlier
 * row of `before` still on screen in this section), so a collapsed parent
 * keeps its subtasks and a hidden completed task keeps its place. A hidden
 * row with no such row goes to the top of the section.
 */
function withHiddenRows(
  visible: TaskPlacement[],
  before: TaskPlacement[],
  onScreen: ReadonlySet<string>,
): TaskPlacement[] {
  const visibleHere = new Set(visible.map((p) => p.tileId));
  const head: TaskPlacement[] = [];
  const after = new Map<string, TaskPlacement[]>();
  let anchor: string | null = null;
  for (const p of before) {
    if (visibleHere.has(p.tileId)) {
      anchor = p.tileId;
      continue;
    }
    if (onScreen.has(p.tileId)) continue; // moved to another section
    if (anchor === null) head.push(p);
    else after.set(anchor, [...(after.get(anchor) ?? []), p]);
  }
  if (head.length === 0 && after.size === 0) return visible;
  const out = [...head];
  for (const p of visible) {
    out.push(p, ...(after.get(p.tileId) ?? []));
  }
  return out;
}

/**
 * Where a dragged block lands inside its destination section, counted in the
 * section's full slice with the block taken out (the `insertOffset` of
 * `moveTaskBlock`). The block goes just before the first visible row that
 * follows it on screen, so hidden rows stay with the visible row they belong
 * to; with no such row it goes to the end of the section.
 */
export function blockInsertOffset(args: {
  placements: TaskPlacement[];
  sections: TaskListSection[];
  /** `null` ⇒ the leading bucket. */
  targetSectionId: string | null;
  blockIds: string[];
  /** The destination zone's items, in their dropped order. */
  destItems: RowDndItem[];
  anchorId: string;
}): number {
  const { placements, sections, targetSectionId, blockIds, destItems, anchorId } = args;
  const blockSet = new Set(blockIds);
  const sorted = [...sections].sort((a, b) => a.position - b.position);
  let start = 0;
  let end = sorted[0]?.position ?? placements.length;
  if (targetSectionId !== null) {
    const i = sorted.findIndex((s) => s.id === targetSectionId);
    if (i < 0) return placements.length;
    start = sorted[i]?.position ?? 0;
    end = sorted[i + 1]?.position ?? placements.length;
  }
  const remaining = placements.slice(start, end).filter((p) => !blockSet.has(p.tileId));
  const anchorIdx = destItems.findIndex((it) => it.id === anchorId);
  const next = destItems.slice(anchorIdx + 1).find((it) => !blockSet.has(it.id));
  if (!next) return remaining.length;
  const idx = remaining.findIndex((p) => p.tileId === next.id);
  return idx < 0 ? remaining.length : idx;
}

/** True when both arrays name exactly the same set of tiles. */
export function sameTileIds(a: TaskPlacement[], b: TaskPlacement[]): boolean {
  const ids = new Set(a.map((p) => p.tileId));
  const other = new Set(b.map((p) => p.tileId));
  if (ids.size !== other.size) return false;
  for (const id of other) if (!ids.has(id)) return false;
  return true;
}

/**
 * After computing a fresh placements array from dndzone items, splice
 * non-anchor block members so the entire multi-block lands contiguously next
 * to the anchor's new position. Anchor stays put; non-anchor members are
 * removed from wherever the items mirror placed them and re-inserted right
 * after the anchor in the order given by `blockIds` (anchor included).
 *
 * Pass `blockIds` ordered so the anchor is in front; the helper preserves
 * the relative order of the rest.
 *
 * Returns a freshly renumbered placement array. No-op when blockIds has
 * fewer than two members.
 */
export function spliceBlockContiguous(
  placements: TaskPlacement[],
  anchorId: string,
  blockIds: string[],
): TaskPlacement[] {
  if (blockIds.length < 2) return placements;
  const blockSet = new Set(blockIds);
  const anchorIdxInInput = placements.findIndex((p) => p.tileId === anchorId);
  if (anchorIdxInInput < 0) return placements;
  // Preserve the block's relative order from the input `placements` so the
  // visible sequence after drop matches the user's prior selection layout.
  const blockOrdered = placements.filter((p) => blockSet.has(p.tileId));
  const remaining = placements.filter((p) => !blockSet.has(p.tileId));
  // Count how many block members lived *before* anchor — those shift the
  // insertion index left by that count once the block is extracted.
  const blockBeforeAnchor = placements
    .slice(0, anchorIdxInInput)
    .filter((p) => blockSet.has(p.tileId)).length;
  const insertAt = anchorIdxInInput - blockBeforeAnchor;
  const next = [
    ...remaining.slice(0, insertAt),
    ...blockOrdered,
    ...remaining.slice(insertAt),
  ];
  return next.map((p, i) => ({ ...p, position: i }));
}

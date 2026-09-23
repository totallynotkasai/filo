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
 * Walks the parent chain and returns the depth in the subtask hierarchy:
 * 0 = top-level, 1 = subtask, 2 = sub-subtask. Returns `Infinity` if a cycle
 * is detected (defensive, capped at 8 hops). Used to enforce the 3-level cap.
 */
export function getTaskDepth(rows: RowLike[], tileId: string): number {
  const byId = new Map(rows.map((r) => [r.tile.id, r]));
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
 * Same-section block reorder: extracts every placement whose `tileId` is in
 * `blockIds` and reinserts the block contiguously next to `targetTileId`.
 *
 * `dropBelow` mirrors the user-visible drop indicator: when `true` the block
 * lands just after the target row; when `false` it lands just before.
 *
 * `fallbackTargetIdx` is used only when the target tile can't be found in
 * the remaining (post-extraction) array — clamped into range.
 *
 * Returns a freshly renumbered placement array (`position: 0..n-1`).
 * Returns the input untouched if no block tiles are found.
 */
export function spliceBlockMove(args: {
  placements: TaskPlacement[];
  blockIds: string[];
  targetTileId: string;
  dropBelow: boolean;
  fallbackTargetIdx: number;
}): TaskPlacement[] {
  const { placements, blockIds, targetTileId, dropBelow, fallbackTargetIdx } = args;
  const blockSet = new Set(blockIds);
  const remaining: TaskPlacement[] = [];
  const block: TaskPlacement[] = [];
  for (const p of placements) {
    if (blockSet.has(p.tileId)) block.push(p);
    else remaining.push(p);
  }
  if (block.length === 0) return placements;
  const targetIdxInRemaining = remaining.findIndex((p) => p.tileId === targetTileId);
  const baseIdx = targetIdxInRemaining >= 0
    ? targetIdxInRemaining
    : Math.min(Math.max(fallbackTargetIdx, 0), remaining.length);
  const insertAt = dropBelow ? baseIdx + 1 : baseIdx;
  const reordered = [
    ...remaining.slice(0, insertAt),
    ...block,
    ...remaining.slice(insertAt),
  ];
  return reordered.map((p, i) => ({ ...p, position: i }));
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
 * Result of classifying a drag-and-drop finalize against the prior placements
 * snapshot. The component branches on `kind` and routes each branch through
 * its existing undo command (frontmatter merge for indent/outdent; structural
 * persist for reorder).
 */
export type DndFinalizeResult =
  | { kind: 'noop' }
  | { kind: 'indent'; tileId: string; parent: string }
  | { kind: 'outdent'; tileId: string }
  | {
      kind: 'reorder';
      placements: TaskPlacement[];
      sections: TaskListSection[];
      crossSection: boolean;
    };

/**
 * Build the post-drop placements array from svelte-dnd-action's per-section
 * `items` mirrors. Section `position` markers are recomputed from the new
 * ordering. The renderer emits one zone per visible section (real + leading
 * synthetic); this helper concatenates them in `displaySectionsOrdered` order
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

  const nextPlacements: TaskPlacement[] = [];
  const nextSections: TaskListSection[] = [];
  const realSectionById = new Map(sections.map((s) => [s.id, s]));
  let cursor = 0;

  for (const sid of displaySectionIds) {
    const items = itemsBySection[sid];
    let slice: TaskPlacement[];
    if (items) {
      // Map items back to placements; drop any unknown ids defensively.
      slice = items
        .map((it) => placementByTileId.get(it.id))
        .filter((p): p is TaskPlacement => p !== undefined);
    } else {
      slice = fallbackSlice.get(sid) ?? [];
    }

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
    const slice = fallbackSlice.get(s.id) ?? [];
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

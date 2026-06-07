/**
 * taskMove — pure helpers for moving a task (with its subtask descendants)
 * between sections of a Task List Board.
 *
 * The flat `tasks[]` placement array is *not* guaranteed to keep a parent
 * task and its subtasks contiguous: a subtask whose `parent` frontmatter
 * field points elsewhere may live anywhere in the array. The rendering
 * layer reconstructs the parent/child tree at view time. When the user
 * drags a task between sections we must physically move that task plus
 * every descendant to the destination, then update each `section.position`
 * marker so the partition (section ranges) reflects the new layout.
 *
 * No DOM, no Svelte imports. Unit-testable in isolation.
 */

import type { TaskPlacement, TaskListSection } from '../../schema/index';

export interface TaskMoveInput {
  placements: TaskPlacement[];
  sections: TaskListSection[];
  /** Tile id being dragged. */
  draggedId: string;
  /**
   * Transitive descendants of the dragged tile (caller computes via
   * `collectDescendantIds`). The dragged id itself may or may not be
   * present in this list; the helper handles both.
   */
  descendantIds: string[];
  /**
   * Section id the block is being dropped into. `null` ⇒ leading bucket
   * (before the first persisted section). Pass the *real* section id, not
   * the synthetic `__default__` placeholder — the caller is responsible
   * for materialising the default before calling this helper.
   */
  targetSectionId: string | null;
  /**
   * Offset within the target section where the block should land. 0 ⇒
   * top of the section; `sectionSize` ⇒ end. Values out of range are
   * clamped. Counted in the section's *current* size (before the move).
   */
  insertOffset: number;
}

export interface TaskMoveResult {
  placements: TaskPlacement[];
  sections: TaskListSection[];
}

/**
 * Move a task (plus its descendants) into a section at a given offset.
 * Returns fresh `placements` and `sections` arrays. Sections that didn't
 * give or receive any block tiles keep their relative ordering and have
 * their `position` markers adjusted only by the net shift caused by the
 * move.
 */
export function moveTaskBlock(input: TaskMoveInput): TaskMoveResult {
  const { placements, sections, draggedId, descendantIds, targetSectionId, insertOffset } = input;

  const blockIdSet = new Set<string>([draggedId, ...descendantIds]);
  const block: TaskPlacement[] = [];
  const remaining: TaskPlacement[] = [];
  const blockOriginalIndices: number[] = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (!p) continue; // i < placements.length; narrow for the type-checker
    if (blockIdSet.has(p.tileId)) {
      block.push(p);
      blockOriginalIndices.push(i);
    } else {
      remaining.push(p);
    }
  }

  if (block.length === 0) {
    // Dragged id not found — no-op.
    return { placements, sections };
  }

  // Step 1: compute section positions in the `remaining` array. A section's
  // position shifts left by however many block tiles originally lived
  // strictly *before* it.
  const sortedSections = [...sections].sort((a, b) => a.position - b.position);
  const sectionsAfterRemoval: TaskListSection[] = sortedSections.map((s) => {
    const blockTilesBefore = blockOriginalIndices.filter((idx) => idx < s.position).length;
    return { ...s, position: Math.max(0, s.position - blockTilesBefore) };
  });

  // Step 2: figure out insertion index in `remaining` array.
  //
  // If targetSectionId is `null` ⇒ leading bucket: insert just before the
  // first remaining section (or at 0 if there are no sections).
  //
  // Otherwise ⇒ insert at the target section's adjusted start + offset
  // (clamped to the section's current size in `remaining`).
  let insertionIndex: number;
  if (targetSectionId === null) {
    const leadingEnd = sectionsAfterRemoval[0]?.position ?? remaining.length;
    insertionIndex = Math.max(0, Math.min(leadingEnd, insertOffset));
  } else {
    const targetIdx = sectionsAfterRemoval.findIndex((s) => s.id === targetSectionId);
    if (targetIdx < 0) {
      // Unknown target section — treat as append.
      insertionIndex = remaining.length;
    } else {
      // targetIdx came from findIndex and is >= 0 in this branch, so it is in range
      const t = sectionsAfterRemoval[targetIdx]!;
      const tEnd = sectionsAfterRemoval[targetIdx + 1]?.position ?? remaining.length;
      const sectionSize = tEnd - t.position;
      const clamped = Math.max(0, Math.min(sectionSize, insertOffset));
      insertionIndex = t.position + clamped;
    }
  }

  // Step 3: splice block into remaining at insertionIndex.
  const nextPlacements: TaskPlacement[] = [
    ...remaining.slice(0, insertionIndex),
    ...block,
    ...remaining.slice(insertionIndex),
  ];

  // Step 4: shift sections whose adjusted position is strictly after the
  // insertion index by block.length. The target section's position must NOT
  // shift — the block is logically *inside* it.
  //
  // Sections originally BEFORE the target must NOT shift past the insertion
  // index either. When all of a "before-target" section's tiles WERE the
  // block (so its adjusted position collapses to the target's), the naive
  // shift would push it past the target — visually re-ordering the sections
  // AND, worse, sweeping a passenger tile (one that lived in a later
  // section unaffected by the move) out of its home section. See the
  // cross-section multi-drag snap-back test in taskMove.test.ts.
  //
  // Edge case: when targetSectionId is null (leading bucket), every
  // remaining section is downstream of the insertion and shifts. When
  // insertionIndex equals a section's adjusted start, that section's first
  // tile is now pushed below the block — those AFTER-target sections also
  // shift.
  const targetOriginalIdx =
    targetSectionId === null ? -1 : sortedSections.findIndex((s) => s.id === targetSectionId);
  const originalIdxById = new Map<string, number>();
  sortedSections.forEach((s, i) => originalIdxById.set(s.id, i));

  const nextSections = sectionsAfterRemoval.map((s) => {
    if (targetSectionId !== null && s.id === targetSectionId) return s;
    const sOriginalIdx = originalIdxById.get(s.id) ?? 0;
    // Before-target sections don't shift past the insertion — they're
    // visually above the target and the inserted block doesn't push them
    // anywhere. (Their tasks may have been removed and they may now be
    // empty, but they stay where they were.)
    if (targetOriginalIdx >= 0 && sOriginalIdx < targetOriginalIdx) return s;
    if (s.position >= insertionIndex) {
      return { ...s, position: s.position + block.length };
    }
    return s;
  });

  // Restore the caller's original section ordering.
  const indexById = new Map(sections.map((s, i) => [s.id, i]));
  nextSections.sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0));

  return { placements: nextPlacements, sections: nextSections };
}

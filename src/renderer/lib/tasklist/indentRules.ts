/**
 * Whether a task may become a subtask of another. One rule for every way of
 * indenting (a horizontal drag, Tab on a focused row), so the keyboard can't
 * make a tree the drag refuses.
 */

import type { TaskPlacement, TaskListSection } from '../../schema/index';
import { collectDescendantIds, getTaskDepth, type RowLike } from './blockMove';
import { sectionIdForPlacementIndex } from './sectionMath';

/** Deepest level a task can sit at: 0 = top level, 2 = sub-subtask. */
export const MAX_TASK_DEPTH = 2;

export interface IndentRuleInput {
  rows: RowLike[];
  placements: TaskPlacement[];
  sections: TaskListSection[];
  tileId: string;
  newParentId: string;
}

/** Levels below `tileId` (0 for a task with no subtasks). */
function subtreeHeight(rows: RowLike[], tileId: string): number {
  let height = 0;
  for (const id of collectDescendantIds(rows, tileId)) {
    if (id === tileId) continue;
    let levels = 0;
    let cur = rows.find((r) => r.tile.id === id);
    while (cur && cur.tile.id !== tileId && levels < 8) {
      levels++;
      cur = rows.find((r) => r.tile.id === cur?.parent);
    }
    height = Math.max(height, levels);
  }
  return height;
}

/**
 * Why `tileId` can't go under `newParentId`, or null when it can. Refused:
 * a parent in another section (the child's placement would stay in this
 * one), the task itself or one of its own subtasks (a cycle), and anything
 * that would put the task or one of its subtasks deeper than
 * `MAX_TASK_DEPTH`.
 */
export function indentProblem(input: IndentRuleInput): string | null {
  const { rows, placements, sections, tileId, newParentId } = input;
  if (newParentId === tileId || collectDescendantIds(rows, tileId).includes(newParentId)) {
    return 'Cannot indent under own subtask';
  }
  const idx = placements.findIndex((p) => p.tileId === tileId);
  const parentIdx = placements.findIndex((p) => p.tileId === newParentId);
  if (
    idx >= 0 &&
    parentIdx >= 0 &&
    sectionIdForPlacementIndex(sections, idx) !== sectionIdForPlacementIndex(sections, parentIdx)
  ) {
    return 'Cannot indent under a task in another section';
  }
  if (getTaskDepth(rows, newParentId) + 1 + subtreeHeight(rows, tileId) > MAX_TASK_DEPTH) {
    return 'Maximum subtask depth reached';
  }
  return null;
}

import { SetTaskParentCommand } from '../../commands/index';
import type { TaskPlacement } from '../../schema/index';
import type { TaskRow } from '../tasks/taskListModel';

/**
 * A Task List's subtask hierarchy lives on the board: a task's parent is a
 * tile id on that board (`TaskPlacement.parentTileId`), which would mean
 * nothing in the note or on another board. Notes written by older builds may
 * name a `parent:` in their frontmatter; it is read when the placement has no
 * parent of its own, and never written or removed (no note write just to
 * move the field).
 */

/** The task's parent id: the placement's, else the note's (`''`: top level). */
export function taskParent(placement: TaskPlacement, noteParent: string): string {
  return placement.parentTileId ?? noteParent;
}

/**
 * The command that makes `row` a subtask of `newParent` (`''`: top level), or
 * null when the board already says so. Outdenting a task whose note names a
 * parent writes `''` on the placement, since only that overrides the note;
 * otherwise a top-level task leaves the field off.
 */
export function buildSetParentCommand(
  boardId: string,
  row: TaskRow,
  newParent: string,
  description?: string,
): SetTaskParentCommand | null {
  const before = row.placement.parentTileId;
  const after = newParent !== '' ? newParent : row.noteParent ? '' : undefined;
  if (before === after) return null;
  return new SetTaskParentCommand(boardId, row.tile.id, before, after, description);
}

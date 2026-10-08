/**
 * Where Alt+Up / Alt+Down move a Task List row, and which row Tab indents it
 * under, read off one section's rows as drawn (`FlatSection.entries`): the
 * sort, the groups and the subtasks already applied, folded subtasks left
 * out. Both keys work with the row's level, as an outliner does:
 *   • a row's block is the row and the rows drawn under it (its subtasks);
 *   • its sibling above or below is the nearest row at the same level under
 *     the same parent, and with a Group By, in the same group.
 * Alt+Up / Alt+Down swap the block with its sibling's block, so one press
 * moves it one place on screen. Tab makes the row a subtask of its sibling
 * above (one level in).
 */

import type { FlatRowEntry } from './taskListViewModel.svelte';

/** A row as drawn: its id, its level, and whether it heads a Group By group. */
export interface DrawnRow {
  id: string;
  depth: number;
  opensGroup: boolean;
}

export function drawnRows(entries: readonly FlatRowEntry[]): DrawnRow[] {
  return entries.map((e) => ({ id: e.row.tile.id, depth: e.depth, opensGroup: e.group !== undefined }));
}

/** The end (exclusive) of the block row `i` heads: the row and the deeper rows drawn under it. */
function blockEnd(rows: readonly DrawnRow[], i: number): number {
  const depth = rows[i]?.depth ?? 0;
  let end = i + 1;
  while (end < rows.length && (rows[end]?.depth ?? 0) > depth) end++;
  return end;
}

/** A top-level row that heads a group starts a list of its own: nothing at its level is above it. */
function startsGroup(row: DrawnRow | undefined): boolean {
  return row !== undefined && row.depth === 0 && row.opensGroup;
}

/** The index of the row drawn above row `i` at its level (its sibling), or -1. */
function siblingAbove(rows: readonly DrawnRow[], i: number): number {
  const row = rows[i];
  if (!row || startsGroup(row)) return -1;
  for (let j = i - 1; j >= 0; j--) {
    const depth = rows[j]?.depth ?? 0;
    if (depth < row.depth) return -1;
    if (depth === row.depth) return j;
  }
  return -1;
}

/** The index of the row drawn below row `i`'s block at its level (its sibling), or -1. */
function siblingBelow(rows: readonly DrawnRow[], i: number): number {
  const row = rows[i];
  const next = rows[blockEnd(rows, i)];
  if (!row || !next || next.depth !== row.depth || startsGroup(next)) return -1;
  return blockEnd(rows, i);
}

/**
 * The section's row ids in their new order once `id`'s block has moved one
 * place up (-1) or down (1) past its sibling's block, or null when it has no
 * sibling that way (the first or last at its level).
 */
export function movedOrder(rows: readonly DrawnRow[], id: string, direction: -1 | 1): string[] | null {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const ids = rows.map((r) => r.id);
  const end = blockEnd(rows, i);
  if (direction < 0) {
    const j = siblingAbove(rows, i);
    if (j < 0) return null;
    return [...ids.slice(0, j), ...ids.slice(i, end), ...ids.slice(j, i), ...ids.slice(end)];
  }
  const j = siblingBelow(rows, i);
  if (j < 0) return null;
  const siblingEnd = blockEnd(rows, j);
  return [...ids.slice(0, i), ...ids.slice(j, siblingEnd), ...ids.slice(i, end), ...ids.slice(siblingEnd)];
}

/** The row Tab makes `id` a subtask of (its sibling above), or null when it has none. */
export function indentParentFor(rows: readonly DrawnRow[], id: string): string | null {
  const j = siblingAbove(rows, rows.findIndex((r) => r.id === id));
  return j < 0 ? null : (rows[j]?.id ?? null);
}

/**
 * Task List board — pure filter / sort / group / smart-list helpers.
 *
 * Extracted from TaskListBoard.svelte so the reactive shell stays focused on
 * UI orchestration. Every function here is pure: same inputs → same output,
 * no store access, no DOM. Safe for unit testing under Vitest + jsdom.
 *
 * The `TaskRow` shape is the post-frontmatter-merge projection a row needs
 * to render. The board derives it by walking placements, looking up the
 * backing tile, reading the .md's frontmatter via FIELD_READERS, and
 * spreading the result into a TaskRow per visible placement.
 */

import type { Tile, TaskPlacement } from '../../schema/index';
import type { Priority } from './frontmatterReaders';
import type { RecurrenceMode } from './recurrence';
import { naturalCompare } from '../utils/naturalSort';
import { parseLocalIsoDate } from '../utils/dateFormat';
import { PRIORITY_LABEL } from '../../constants/taskPriorities';

export type GroupBy = 'status' | 'priority' | 'tag' | 'dueDate' | 'category' | 'none';
export type SortBy = 'title' | 'created' | 'dueDate' | 'priority' | 'manual';
export type SmartListId =
  | 'all'
  | 'today'
  | 'upcoming'
  | 'overdue'
  | 'no-date'
  | 'completed';

export interface TaskRow {
  placement: TaskPlacement;
  tile: Tile;
  completed: boolean;
  priority: Priority;
  dueDate: string;
  dueTime: string;
  startDate: string;
  status: string;
  tags: string[];
  /** The parent task's tile id on this board ('' at top level). */
  parent: string;
  /** The note's own `parent:` (older builds wrote it); read only when the placement has none. */
  noteParent?: string;
  recurrence: string;
  recurrenceMode: RecurrenceMode;
  recurrenceAnchor?: string;
  category: string;
  /**
   * The note's fields haven't arrived yet (the vault is still being read at
   * open): the fields above are blanks, not "not done / no priority".
   */
  fieldsPending?: boolean;
}

export interface GroupKey {
  key: string;
  label: string;
}

/**
 * Numeric weight per priority value, used by `compareRows` when `sortBy ===
 * 'priority'`. Lower number sorts first (urgent first, none last).
 */
export const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

/**
 * Default group ordering per `groupBy` mode. `tag` is dynamic (depends on the
 * tags present) and reads as `[]` here — the renderer falls back to
 * alphabetical when this is empty for the active mode.
 */
export const GROUP_ORDER: Record<GroupBy, string[]> = {
  status: ['todo', 'in-progress', 'done'],
  priority: ['urgent', 'high', 'medium', 'low', 'none'],
  dueDate: ['overdue', 'today', 'this-week', 'later', 'no-date'],
  tag: [],
  category: [],
  none: ['all'],
};

/**
 * A future `startDate` defers a task: it hides from focused smart lists
 * (Today / Upcoming) until the start date arrives, but stays visible in All.
 * Mirrors Things' / OmniFocus' defer-date semantics.
 *
 * `today` must be normalised to midnight local-time by the caller. We don't
 * compute it here so a derivation that already paid for it can reuse one
 * Date across many rows.
 */
export function isDeferred(r: TaskRow, today: Date): boolean {
  if (!r.startDate) return false;
  const start = parseLocalIsoDate(r.startDate);
  if (!start) return false;
  return start.getTime() > today.getTime();
}

/**
 * Returns true if `r` belongs in the given smart-list bucket.
 */
export function smartListMatch(r: TaskRow, list: SmartListId, today: Date): boolean {
  if (list === 'all') return true;
  if (list === 'completed') return r.completed;
  if (list === 'no-date') return !r.dueDate && !isDeferred(r, today);
  if (!r.dueDate) return false;
  const due = parseLocalIsoDate(r.dueDate);
  if (!due) return false;
  if (list === 'today') {
    return due.getTime() === today.getTime() && !r.completed && !isDeferred(r, today);
  }
  if (list === 'upcoming') {
    return due.getTime() > today.getTime() && !r.completed && !isDeferred(r, today);
  }
  if (list === 'overdue') return due.getTime() < today.getTime() && !r.completed;
  return true;
}

/**
 * Compares two TaskRows under the given `sortBy` mode. Designed for use as
 * an `Array.prototype.sort` comparator after currying — see usage in
 * TaskListBoard.svelte's `sortedRows` derivation.
 *
 * `manual` sort falls through to `placement.position`, which is the
 * canonical ordering and reflects user drag-drop reorders.
 */
export function compareRows(a: TaskRow, b: TaskRow, sortBy: SortBy): number {
  if (sortBy === 'title') return naturalCompare(a.tile.title, b.tile.title);
  if (sortBy === 'created') return (a.tile.createdAt ?? 0) - (b.tile.createdAt ?? 0);
  if (sortBy === 'dueDate') {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    const dateCmp = a.dueDate.localeCompare(b.dueDate);
    if (dateCmp !== 0) return dateCmp;
    // Same date — tiebreak by time. Rows without a time sort after rows
    // with one so explicit appointments stay above all-day tasks.
    if (!a.dueTime && !b.dueTime) return 0;
    if (!a.dueTime) return 1;
    if (!b.dueTime) return -1;
    return a.dueTime.localeCompare(b.dueTime);
  }
  if (sortBy === 'priority') {
    return (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4);
  }
  return a.placement.position - b.placement.position;
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/**
 * Resolves the bucket a row belongs to under the active `groupBy` mode.
 * `key` is the stable identifier (used for collapse-state persistence,
 * `GROUP_ORDER` lookup); `label` is the user-facing header text.
 */
/**
 * Filter inputs for `filterTaskRows`. Mirrors the transient UI state held in
 * TaskListBoard.svelte. `showCompleted` is the toggle; `smartList` short-
 * circuits to completed-only when set to `'completed'`. Tag filter is
 * intersection (every selected tag must be present on the row).
 */
export interface TaskFilterInputs {
  smartList: SmartListId;
  showCompleted: boolean;
  priority: Priority | null;
  status: string | null;
  tags: string[];
}

/**
 * Pure filter — caller supplies the canonical inputs and a normalized `today`.
 * Returns a new array; never mutates input.
 *
 * Behaviour matches TaskListBoard's `filteredRows` derivation exactly so the
 * component can delegate without semantic drift. Centralising here lets the
 * filter be unit-tested without the Svelte runtime.
 */
export function filterTaskRows(
  rows: TaskRow[],
  today: Date,
  inputs: TaskFilterInputs,
): TaskRow[] {
  const wantTags = inputs.tags.map((t) => t.replace(/^#/, ''));
  const byFields = inputs.smartList !== 'all' || !inputs.showCompleted || !!inputs.priority || !!inputs.status || wantTags.length > 0;
  return rows.filter((r) => {
    // A filter on fields waits for them: a row whose note hasn't been read
    // would pass "not completed" / "no date" on blanks.
    if (r.fieldsPending && byFields) return false;
    if (inputs.smartList === 'completed') {
      if (!r.completed) return false;
    } else if (!inputs.showCompleted && r.completed) {
      return false;
    }
    if (!smartListMatch(r, inputs.smartList, today)) return false;
    if (inputs.priority && r.priority !== inputs.priority) return false;
    if (inputs.status && statusBucket(r).key !== statusFilterKey(inputs.status)) return false;
    if (wantTags.length > 0) {
      if (!wantTags.every((w) => r.tags.includes(w))) return false;
    }
    return true;
  });
}

/**
 * The status a task is in, the one rule Group by Status and Filter by Status
 * share: a completed task is Done, a task with no `status:` (every task made
 * in Filo) is To Do, and `doing` / `in_progress` are In Progress.
 */
export function statusBucket(r: Pick<TaskRow, 'completed' | 'status'>): GroupKey {
  if (r.completed) return { key: 'done', label: 'Done' };
  if (r.status === 'in-progress' || r.status === 'in_progress' || r.status === 'doing') {
    return { key: 'in-progress', label: 'In Progress' };
  }
  if (r.status === 'todo' || r.status === '') return { key: 'todo', label: 'To Do' };
  if (r.status === 'done') return { key: 'done', label: 'Done' };
  return { key: r.status, label: capitalize(r.status) };
}

/**
 * A filter's status (from the menu, a saved view or an older `lastView`) as
 * the bucket it names: a view saved on `doing` keeps finding In Progress.
 */
function statusFilterKey(status: string): string {
  if (status === 'done') return 'done';
  return statusBucket({ completed: false, status: status.toLowerCase() }).key;
}

/**
 * The statuses Filter by Status offers: the buckets the board's tasks are
 * in, in the group order (To Do, In Progress, Done), then the rest by name.
 * The active filter stays listed while no task is in it, so it can be
 * turned off where it was turned on.
 */
export function statusFilterOptions(rows: readonly TaskRow[], active: string | null): GroupKey[] {
  const found = new Map<string, GroupKey>();
  for (const r of rows) {
    if (r.fieldsPending) continue;
    const b = statusBucket(r);
    if (!found.has(b.key)) found.set(b.key, b);
  }
  if (active) {
    const key = statusFilterKey(active);
    if (!found.has(key)) found.set(key, statusBucket({ completed: key === 'done', status: key }));
  }
  const order = GROUP_ORDER.status;
  return [...found.values()].sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
    return naturalCompare(a.label, b.label);
  });
}

export function groupKey(r: TaskRow, groupBy: GroupBy, today: Date): GroupKey {
  if (groupBy === 'status') return statusBucket(r);
  if (groupBy === 'priority') {
    return { key: r.priority, label: PRIORITY_LABEL[r.priority] };
  }
  if (groupBy === 'dueDate') {
    if (!r.dueDate) return { key: 'no-date', label: 'No Due Date' };
    const due = parseLocalIsoDate(r.dueDate);
    if (!due) return { key: 'no-date', label: 'No Due Date' };
    if (due.getTime() < today.getTime()) return { key: 'overdue', label: 'Overdue' };
    // Whole calendar days: a day with a clock change lasts 23 or 25 hours,
    // so the raw millisecond gap to tomorrow can be under one day.
    const days = Math.round((due.getTime() - today.getTime()) / 86400000);
    if (days < 1) return { key: 'today', label: 'Today' };
    if (days < 7) return { key: 'this-week', label: 'This Week' };
    return { key: 'later', label: 'Later' };
  }
  if (groupBy === 'tag') {
    if (r.tags.length === 0) return { key: 'untagged', label: 'Untagged' };
    const t = r.tags[0];
    return { key: `tag:${t}`, label: `#${t}` };
  }
  if (groupBy === 'category') {
    const c = r.category.trim();
    if (!c) return { key: 'uncategorised', label: 'Uncategorised' };
    return { key: `category:${c.toLowerCase()}`, label: c };
  }
  return { key: 'all', label: 'All Tasks' };
}

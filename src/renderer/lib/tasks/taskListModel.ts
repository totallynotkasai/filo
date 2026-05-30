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
  parent: string;
  recurrence: string;
  recurrenceMode: RecurrenceMode;
  category: string;
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
  const start = new Date(r.startDate);
  if (Number.isNaN(start.getTime())) return false;
  start.setHours(0, 0, 0, 0);
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
  const due = new Date(r.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  due.setHours(0, 0, 0, 0);
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
 * `manual` sort falls through to `placement.position`, which is the V7
 * canonical ordering and reflects user drag-drop reorders.
 */
export function compareRows(a: TaskRow, b: TaskRow, sortBy: SortBy): number {
  if (sortBy === 'title') return a.tile.title.localeCompare(b.tile.title);
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
  return rows.filter((r) => {
    if (inputs.smartList === 'completed') {
      if (!r.completed) return false;
    } else if (!inputs.showCompleted && r.completed) {
      return false;
    }
    if (!smartListMatch(r, inputs.smartList, today)) return false;
    if (inputs.priority && r.priority !== inputs.priority) return false;
    if (inputs.status && r.status !== inputs.status) return false;
    if (wantTags.length > 0) {
      if (!wantTags.every((w) => r.tags.includes(w))) return false;
    }
    return true;
  });
}

export function groupKey(r: TaskRow, groupBy: GroupBy): GroupKey {
  if (groupBy === 'status') {
    if (r.completed) return { key: 'done', label: 'Done' };
    if (r.status === 'in-progress' || r.status === 'in_progress' || r.status === 'doing') {
      return { key: 'in-progress', label: 'In Progress' };
    }
    if (r.status === 'todo' || r.status === '') return { key: 'todo', label: 'To Do' };
    return { key: r.status, label: capitalize(r.status) };
  }
  if (groupBy === 'priority') {
    const label = r.priority === 'none' ? 'No Priority' : capitalize(r.priority);
    return { key: r.priority, label };
  }
  if (groupBy === 'dueDate') {
    if (!r.dueDate) return { key: 'no-date', label: 'No Due Date' };
    const today = new Date(new Date().toDateString());
    const due = new Date(r.dueDate);
    if (due < today) return { key: 'overdue', label: 'Overdue' };
    const diff = (due.getTime() - today.getTime()) / 86400000;
    if (diff < 1) return { key: 'today', label: 'Today' };
    if (diff < 7) return { key: 'this-week', label: 'This Week' };
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

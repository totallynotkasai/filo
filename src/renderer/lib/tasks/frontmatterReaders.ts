/**
 * Frontmatter readers for task / Kanban-card metadata.
 *
 * Each reader takes the raw frontmatter map (an `unknown`-valued record from
 * the vault index or a note model) and returns a typed, canonical value with
 * tolerant fallbacks for hand-edited YAML. Shared between TaskListBoard and
 * KanbanCard so the two boards agree on how to interpret the same fields.
 *
 * Pure functions — no I/O, no store access. Safe for unit testing under
 * Vitest + jsdom.
 */

import type { RecurrenceMode } from './recurrence';
import { orderPreservingTagsField } from '../utils/normalizeTagsField';

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

type Frontmatter = Record<string, unknown>;

/** The strings a `completed:` value may say "done" with (YAML 1.1 booleans, and a quoted `"true"`). */
const DONE_WORDS: ReadonlySet<string> = new Set(['true', 'yes', 'on']);

export const FIELD_READERS = {
  /**
   * YAML 1.2 reads `completed: yes` (and `on`, and a quoted `"true"`) as a
   * string, but a note written by hand or by an app on YAML 1.1 means done.
   * Read only: a toggle writes a real `true` / `false`.
   */
  completed(fm: Frontmatter): boolean {
    const v = fm.completed;
    if (typeof v === 'string') return DONE_WORDS.has(v.trim().toLowerCase());
    return v === true;
  },

  priority(fm: Frontmatter): Priority {
    const p = String(fm.priority ?? 'none').toLowerCase();
    if (p === 'urgent' || p === 'high' || p === 'medium' || p === 'low') return p;
    return 'none';
  },

  dueDate(fm: Frontmatter): string {
    const v = fm.dueDate;
    return typeof v === 'string' ? v : '';
  },

  /**
   * Tolerates `"5pm"` or `"17:30"` and canonicalises to `HH:MM`. Returns `''`
   * when the value is not parseable. The frontmatter canonicaliser stores
   * `HH:MM`, but tasks may carry hand-edited values.
   */
  dueTime(fm: Frontmatter): string {
    const v = fm.dueTime;
    if (typeof v !== 'string') return '';
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (!m) return '';
    const h = Math.max(0, Math.min(23, parseInt(m[1] ?? '', 10)));
    const min = Math.max(0, Math.min(59, parseInt(m[2] ?? '', 10)));
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  },

  startDate(fm: Frontmatter): string {
    const v = fm.startDate;
    return typeof v === 'string' ? v : '';
  },

  status(fm: Frontmatter): string {
    const v = fm.status;
    return typeof v === 'string' && v.trim() ? v.toLowerCase() : '';
  },

  parent(fm: Frontmatter): string {
    const v = fm.parent;
    return typeof v === 'string' ? v : '';
  },

  recurrence(fm: Frontmatter): string {
    const v = fm.recurrence;
    return typeof v === 'string' ? v.trim() : '';
  },

  recurrenceMode(fm: Frontmatter): RecurrenceMode {
    const v = fm.recurrenceMode;
    return v === 'completion' ? 'completion' : 'schedule';
  },

  /**
   * The original day a month-based schedule repeats on (see
   * `recurrence.ts`). Only a well-formed `YYYY-MM-DD` counts; anything else
   * reads as absent so the schedule re-anchors on the due date.
   */
  recurrenceAnchor(fm: Frontmatter): string | undefined {
    const v = fm.recurrenceAnchor;
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined;
  },

  category(fm: Frontmatter): string {
    const v = fm.category;
    return typeof v === 'string' ? v.trim() : '';
  },

  /** Through the one tags normaliser, so a row shows the tags every other view shows. */
  tags(fm: Frontmatter): string[] {
    return orderPreservingTagsField(fm.tags);
  },
} as const;

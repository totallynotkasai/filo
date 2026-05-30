/**
 * Frontmatter readers for task / Kanban-card metadata.
 *
 * Each reader takes the raw frontmatter map (an `unknown`-valued record from
 * vaultIndexStore / documentStore) and returns a typed, canonical value with
 * tolerant fallbacks for hand-edited YAML. Shared between TaskListBoard and
 * KanbanCard so the two boards agree on how to interpret the same fields.
 *
 * Pure functions — no I/O, no store access. Safe for unit testing under
 * Vitest + jsdom.
 */

import type { RecurrenceMode } from './recurrence';

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

type Frontmatter = Record<string, unknown>;

export const FIELD_READERS = {
  completed(fm: Frontmatter): boolean {
    return fm.completed === true;
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
    const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
    const min = Math.max(0, Math.min(59, parseInt(m[2], 10)));
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

  category(fm: Frontmatter): string {
    const v = fm.category;
    return typeof v === 'string' ? v.trim() : '';
  },

  tags(fm: Frontmatter): string[] {
    const v = fm.tags;
    if (Array.isArray(v)) {
      return v
        .map((t) => String(t).replace(/^#/, '').trim())
        .filter((t) => t.length > 0);
    }
    if (typeof v === 'string') {
      return v
        .split(/[,\s]+/)
        .map((t) => t.replace(/^#/, '').trim())
        .filter(Boolean);
    }
    return [];
  },
} as const;

export type FieldName = keyof typeof FIELD_READERS;

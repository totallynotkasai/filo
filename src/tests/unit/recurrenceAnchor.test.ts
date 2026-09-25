import { describe, it, expect } from 'vitest';
import { nextDueDate } from '@renderer/lib/tasks/recurrence';
import { FIELD_READERS } from '@renderer/lib/tasks/frontmatterReaders';
import {
  completionPatchForRow,
  recurrenceChangePatch,
} from '@renderer/lib/tasklist/frontmatterWriter';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import type { Tile } from '@renderer/schema/index';

/**
 * Monthly / yearly schedule-mode recurrence must not drift after a month-end
 * clamp: Jan 31 → Feb 28 must come back to Mar 31, not stay on the 28th for
 * ever. The original day is remembered in `recurrenceAnchor` frontmatter.
 */

/** Local-time date (month is 1-based, unlike `new Date`). */
function day(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}

interface ScheduleCase {
  name: string;
  due: string;
  rec: string;
  anchor?: string;
  completed: Date;
  expected: string;
}

const SCHEDULE_CASES: ScheduleCase[] = [
  { name: 'Jan 31 monthly clamps to Feb 28', due: '2026-01-31', rec: 'monthly', completed: day(2026, 1, 31), expected: '2026-02-28' },
  { name: 'Feb 28 with anchor 01-31 returns to Mar 31', due: '2026-02-28', rec: 'monthly', anchor: '2026-01-31', completed: day(2026, 2, 28), expected: '2026-03-31' },
  { name: 'Mar 31 with anchor 01-31 clamps to Apr 30', due: '2026-03-31', rec: 'monthly', anchor: '2026-01-31', completed: day(2026, 3, 31), expected: '2026-04-30' },
  { name: 'leap Feb 29 yearly clamps to 2029-02-28', due: '2028-02-29', rec: 'yearly', completed: day(2028, 2, 29), expected: '2029-02-28' },
  { name: 'yearly anchored on Feb 29 stays on Feb 28 in a non-leap year', due: '2029-02-28', rec: 'yearly', anchor: '2028-02-29', completed: day(2029, 2, 28), expected: '2030-02-28' },
  { name: 'yearly anchored on Feb 29 returns to Feb 29 in the next leap year', due: '2031-02-28', rec: 'yearly', anchor: '2028-02-29', completed: day(2031, 2, 28), expected: '2032-02-29' },
  { name: 'overdue catch-up steps from the base, not from each clamp', due: '2026-01-31', rec: 'monthly', completed: day(2026, 4, 5), expected: '2026-04-30' },
  { name: 'a hand-moved due date re-anchors (stale anchor ignored)', due: '2026-03-15', rec: 'monthly', anchor: '2026-01-31', completed: day(2026, 3, 15), expected: '2026-04-15' },
  { name: 'a hand-moved due date on a clamp-looking day re-anchors', due: '2026-04-29', rec: 'monthly', anchor: '2026-01-31', completed: day(2026, 4, 29), expected: '2026-05-29' },
  { name: 'every 2 months from Jan 31', due: '2026-01-31', rec: 'every 2 months', completed: day(2026, 1, 31), expected: '2026-03-31' },
  { name: 'every 2 months overdue catch-up keeps the 31st', due: '2025-12-31', rec: 'every 2 months', completed: day(2026, 3, 1), expected: '2026-04-30' },
  { name: 'every 2 months anchored returns to the 31st', due: '2026-04-30', rec: 'every 2 months', anchor: '2025-12-31', completed: day(2026, 4, 30), expected: '2026-06-30' },
  { name: 'yearly with an anchor in another month re-anchors', due: '2029-03-01', rec: 'yearly', anchor: '2028-02-29', completed: day(2029, 3, 1), expected: '2030-03-01' },
  { name: 'a malformed anchor is ignored', due: '2026-02-28', rec: 'monthly', anchor: 'soon', completed: day(2026, 2, 28), expected: '2026-03-28' },
  { name: 'weekly is unaffected by an anchor', due: '2026-05-15', rec: 'weekly', anchor: '2026-01-31', completed: day(2026, 5, 15), expected: '2026-05-22' },
  { name: 'daily is unaffected by an anchor', due: '2026-05-15', rec: 'daily', anchor: '2026-01-31', completed: day(2026, 5, 15), expected: '2026-05-16' },
  { name: 'weekly overdue catch-up unchanged', due: '2026-05-04', rec: 'weekly', completed: day(2026, 5, 25), expected: '2026-06-01' },
];

describe('nextDueDate: monthly / yearly schedule anchor', () => {
  for (const c of SCHEDULE_CASES) {
    it(c.name, () => {
      expect(nextDueDate(c.due, c.rec, 'schedule', c.completed, c.anchor)).toBe(c.expected);
    });
  }

  it('completion mode ignores the anchor', () => {
    expect(nextDueDate('2026-02-28', 'monthly', 'completion', day(2026, 3, 10), '2026-01-31'))
      .toBe('2026-04-10');
  });
});

describe('FIELD_READERS.recurrenceAnchor', () => {
  it('returns a valid ISO date', () => {
    expect(FIELD_READERS.recurrenceAnchor({ recurrenceAnchor: '2026-01-31' })).toBe('2026-01-31');
  });

  it('returns undefined when absent or malformed', () => {
    expect(FIELD_READERS.recurrenceAnchor({})).toBeUndefined();
    expect(FIELD_READERS.recurrenceAnchor({ recurrenceAnchor: 31 })).toBeUndefined();
    expect(FIELD_READERS.recurrenceAnchor({ recurrenceAnchor: 'Jan 31' })).toBeUndefined();
  });
});

function mkRow(over: Partial<TaskRow>): TaskRow {
  const tile: Tile = { id: 't', type: 'text', title: 't' } as Tile;
  return {
    placement: { tileId: 't', position: 0 },
    tile,
    completed: false,
    priority: 'none',
    dueDate: '',
    dueTime: '',
    startDate: '',
    status: '',
    tags: [],
    parent: '',
    recurrence: 'monthly',
    recurrenceMode: 'schedule',
    category: '',
    ...over,
  } as TaskRow;
}

describe('completionPatchForRow: recurrenceAnchor', () => {
  it('records the anchor when a day-31 monthly task clamps', () => {
    const row = mkRow({ dueDate: '2026-01-31' });
    expect(completionPatchForRow(row, day(2026, 1, 31))).toEqual({
      completed: false,
      dueDate: '2026-02-28',
      recurrenceAnchor: '2026-01-31',
    });
  });

  it('uses the stored anchor and does not rewrite it when unchanged', () => {
    const row = mkRow({ dueDate: '2026-02-28', recurrenceAnchor: '2026-01-31' });
    expect(completionPatchForRow(row, day(2026, 2, 28))).toEqual({
      completed: false,
      dueDate: '2026-03-31',
    });
  });

  it('records the anchor for day 29 monthly', () => {
    const row = mkRow({ dueDate: '2026-01-29' });
    expect(completionPatchForRow(row, day(2026, 1, 29))).toEqual({
      completed: false,
      dueDate: '2026-02-28',
      recurrenceAnchor: '2026-01-29',
    });
  });

  it('never adds the key for a monthly task on days 1-28', () => {
    const row = mkRow({ dueDate: '2026-01-28' });
    expect(completionPatchForRow(row, day(2026, 1, 28))).toEqual({
      completed: false,
      dueDate: '2026-02-28',
    });
  });

  it('records a Feb 29 yearly anchor', () => {
    const row = mkRow({ dueDate: '2028-02-29', recurrence: 'yearly' });
    expect(completionPatchForRow(row, day(2028, 2, 29))).toEqual({
      completed: false,
      dueDate: '2029-02-28',
      recurrenceAnchor: '2028-02-29',
    });
  });

  it('does not record an anchor for a yearly task on a day that never clamps', () => {
    const row = mkRow({ dueDate: '2026-01-31', recurrence: 'yearly' });
    expect(completionPatchForRow(row, day(2026, 1, 31))).toEqual({
      completed: false,
      dueDate: '2027-01-31',
    });
  });

  it('replaces a stale anchor when the due date was moved to another month-end day', () => {
    const row = mkRow({ dueDate: '2026-04-30', recurrenceAnchor: '2026-01-29' });
    expect(completionPatchForRow(row, day(2026, 4, 30))).toEqual({
      completed: false,
      dueDate: '2026-05-30',
      recurrenceAnchor: '2026-04-30',
    });
  });

  it('drops a stale anchor when the due date was moved to an ordinary day', () => {
    const row = mkRow({ dueDate: '2026-03-15', recurrenceAnchor: '2026-01-31' });
    expect(completionPatchForRow(row, day(2026, 3, 15))).toEqual({
      completed: false,
      dueDate: '2026-04-15',
      recurrenceAnchor: '',
    });
  });

  it('never adds the key in completion mode', () => {
    const row = mkRow({ dueDate: '2026-01-31', recurrenceMode: 'completion' });
    expect(completionPatchForRow(row, day(2026, 1, 31))).toEqual({
      completed: false,
      dueDate: '2026-02-28',
    });
  });

  it('never adds the key for weekly tasks', () => {
    const row = mkRow({ dueDate: '2026-01-31', recurrence: 'weekly' });
    expect(completionPatchForRow(row, day(2026, 1, 31))).toEqual({
      completed: false,
      dueDate: '2026-02-07',
    });
  });
});

describe('recurrenceChangePatch', () => {
  it('clearing the recurrence also unsets the anchor', () => {
    expect(recurrenceChangePatch('')).toEqual({ recurrence: '', recurrenceAnchor: '' });
  });

  it('changing the recurrence also unsets the anchor', () => {
    expect(recurrenceChangePatch('weekly')).toEqual({ recurrence: 'weekly', recurrenceAnchor: '' });
  });
});

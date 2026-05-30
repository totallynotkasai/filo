import { describe, it, expect } from 'vitest';
import { parseRecurrence, nextDueDate } from '@renderer/lib/tasks/recurrence';

describe('parseRecurrence', () => {
  it('parses single-word presets', () => {
    expect(parseRecurrence('daily')).toEqual({ kind: 'fixed', count: 1, unit: 'd' });
    expect(parseRecurrence('weekly')).toEqual({ kind: 'fixed', count: 1, unit: 'w' });
    expect(parseRecurrence('monthly')).toEqual({ kind: 'fixed', count: 1, unit: 'm' });
    expect(parseRecurrence('yearly')).toEqual({ kind: 'fixed', count: 1, unit: 'y' });
    expect(parseRecurrence('annually')).toEqual({ kind: 'fixed', count: 1, unit: 'y' });
  });

  it('parses weekday / weekdays as a special kind', () => {
    expect(parseRecurrence('weekday')).toEqual({ kind: 'weekday' });
    expect(parseRecurrence('weekdays')).toEqual({ kind: 'weekday' });
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(parseRecurrence('  DAILY  ')).toEqual({ kind: 'fixed', count: 1, unit: 'd' });
    expect(parseRecurrence('Weekly')).toEqual({ kind: 'fixed', count: 1, unit: 'w' });
  });

  it('parses every-N forms', () => {
    expect(parseRecurrence('every 2 d')).toEqual({ kind: 'fixed', count: 2, unit: 'd' });
    expect(parseRecurrence('every 3 weeks')).toEqual({ kind: 'fixed', count: 3, unit: 'w' });
    expect(parseRecurrence('every 6 months')).toEqual({ kind: 'fixed', count: 6, unit: 'm' });
    expect(parseRecurrence('every 1 year')).toEqual({ kind: 'fixed', count: 1, unit: 'y' });
    expect(parseRecurrence('every 14d')).toEqual({ kind: 'fixed', count: 14, unit: 'd' });
  });

  it('returns null for malformed or empty input', () => {
    expect(parseRecurrence('')).toBeNull();
    expect(parseRecurrence('always')).toBeNull();
    expect(parseRecurrence('every 0 d')).toBeNull();
    expect(parseRecurrence('every -1 w')).toBeNull();
    expect(parseRecurrence('every two days')).toBeNull();
  });
});

describe('nextDueDate: schedule mode (current due + interval)', () => {
  // Pinned far in the past so the schedule-mode roll-forward (audit 1.4) never
  // triggers for these cases — the task is completed long before its due date,
  // so each asserts pure interval arithmetic (next = currentDue + one interval).
  const COMPLETED = new Date(2020, 0, 1);

  it('daily advances by 1 day', () => {
    expect(nextDueDate('2026-05-10', 'daily', 'schedule', COMPLETED)).toBe('2026-05-11');
  });

  it('weekly advances by 7 days', () => {
    expect(nextDueDate('2026-05-10', 'weekly', 'schedule', COMPLETED)).toBe('2026-05-17');
  });

  it('monthly advances by 1 calendar month', () => {
    expect(nextDueDate('2026-05-10', 'monthly', 'schedule', COMPLETED)).toBe('2026-06-10');
  });

  it('monthly clamps Jan 31 to last day of February (non-leap)', () => {
    expect(nextDueDate('2026-01-31', 'monthly', 'schedule', COMPLETED)).toBe('2026-02-28');
  });

  it('monthly clamps Jan 31 to Feb 29 in a leap year', () => {
    expect(nextDueDate('2028-01-31', 'monthly', 'schedule', COMPLETED)).toBe('2028-02-29');
  });

  it('monthly wraps year boundary', () => {
    expect(nextDueDate('2026-12-15', 'monthly', 'schedule', COMPLETED)).toBe('2027-01-15');
  });

  it('yearly advances by 1 year', () => {
    expect(nextDueDate('2026-05-10', 'yearly', 'schedule', COMPLETED)).toBe('2027-05-10');
  });

  it('yearly clamps Feb 29 to Feb 28 the next year', () => {
    expect(nextDueDate('2028-02-29', 'yearly', 'schedule', COMPLETED)).toBe('2029-02-28');
  });

  it('every 2w advances by 14 days', () => {
    expect(nextDueDate('2026-05-10', 'every 2w', 'schedule', COMPLETED)).toBe('2026-05-24');
  });

  it('every 3d advances by 3 days', () => {
    expect(nextDueDate('2026-05-10', 'every 3d', 'schedule', COMPLETED)).toBe('2026-05-13');
  });

  it('weekday from a Friday lands on the next Monday', () => {
    // 2026-05-15 is a Friday.
    expect(nextDueDate('2026-05-15', 'weekday', 'schedule', COMPLETED)).toBe('2026-05-18');
  });

  it('weekday from a Monday lands on Tuesday (single day, still weekday)', () => {
    // 2026-05-18 is a Monday.
    expect(nextDueDate('2026-05-18', 'weekday', 'schedule', COMPLETED)).toBe('2026-05-19');
  });

  it('returns null when currentDue is missing', () => {
    expect(nextDueDate(undefined, 'daily', 'schedule', COMPLETED)).toBeNull();
  });

  it('returns null when currentDue is malformed', () => {
    expect(nextDueDate('not-a-date', 'daily', 'schedule', COMPLETED)).toBeNull();
    expect(nextDueDate('2026-02-30', 'daily', 'schedule', COMPLETED)).toBeNull();
  });
});

describe('nextDueDate: schedule mode rolls forward past overdue dates (audit 1.4)', () => {
  it('a weekly task several intervals overdue advances to the next FUTURE occurrence', () => {
    // due 2026-05-04, completed 2026-05-25 (3 weeks late): occurrences fall on
    // 05-04 / 05-11 / 05-18 / 05-25 / 06-01 -> first strictly after 05-25 is 06-01.
    const next = nextDueDate('2026-05-04', 'weekly', 'schedule', new Date(2026, 4, 25));
    expect(next).toBe('2026-06-01');
    // The whole point of the fix: next due is in the future, not still the past.
    expect(next! > '2026-05-25').toBe(true);
  });

  it('an "every 3d" task many intervals overdue lands strictly in the future', () => {
    // 05-01, 05-04, ..., 05-25, then 05-28 - first strictly after the 05-25 completion.
    expect(nextDueDate('2026-05-01', 'every 3d', 'schedule', new Date(2026, 4, 25)))
      .toBe('2026-05-28');
  });

  it('a task due exactly today rolls to the next interval (strictly future)', () => {
    expect(nextDueDate('2026-05-25', 'weekly', 'schedule', new Date(2026, 4, 25)))
      .toBe('2026-06-01');
  });

  it('a not-yet-overdue task still advances by exactly one interval (no over-roll)', () => {
    // due 2026-05-20, completed early on 05-18: one interval (05-27) is already
    // in the future, so it does not roll further.
    expect(nextDueDate('2026-05-20', 'weekly', 'schedule', new Date(2026, 4, 18)))
      .toBe('2026-05-27');
  });
});

describe('nextDueDate: completion mode (today + interval)', () => {
  // Completed on Friday 2026-05-15.
  const COMPLETED = new Date(2026, 4, 15, 14, 0);

  it('ignores currentDue and uses completedOn as the base', () => {
    expect(nextDueDate('2026-01-01', 'daily', 'completion', COMPLETED)).toBe('2026-05-16');
  });

  it('weekly from completion = +7 days', () => {
    expect(nextDueDate(undefined, 'weekly', 'completion', COMPLETED)).toBe('2026-05-22');
  });

  it('weekday from Friday completion = next Monday', () => {
    expect(nextDueDate(undefined, 'weekday', 'completion', COMPLETED)).toBe('2026-05-18');
  });

  it('weekday from Wednesday completion = Thursday', () => {
    const wed = new Date(2026, 4, 13, 14, 0); // 2026-05-13 is a Wednesday
    expect(nextDueDate(undefined, 'weekday', 'completion', wed)).toBe('2026-05-14');
  });

  it('works without a currentDue in completion mode', () => {
    expect(nextDueDate(undefined, 'every 2w', 'completion', COMPLETED)).toBe('2026-05-29');
  });
});

describe('nextDueDate: invalid recurrence', () => {
  it('returns null for unparseable recurrence strings', () => {
    expect(nextDueDate('2026-05-10', 'maybe', 'schedule', new Date())).toBeNull();
    expect(nextDueDate('2026-05-10', '', 'schedule', new Date())).toBeNull();
  });
});

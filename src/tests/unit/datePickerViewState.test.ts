import { describe, it, expect } from 'vitest';
import { DatePickerViewState } from '@renderer/lib/tasklist/datePickerViewState.svelte';
import { calendarCells, dateKeyMove, shiftDay, weekdayLabels, weekStartDay } from '@renderer/lib/tasklist/calendarGrid';

/**
 * DATE-1 (Task List audit 2026-06-08, Phase 1) — the date picker's visible
 * month was pinned by a self-resetting `$effect`: it re-derived the seed from
 * `value` on every viewMonth/viewYear change and reset them, so the ‹/› arrows
 * could never reach another month. The reactive view-state is extracted here so
 * the regression is locked in without mounting the component.
 *
 * The host calls `syncToValue(value)` from an `$effect` on every tick; the key
 * property is that a repeated call with the SAME value is a no-op that leaves
 * any navigation intact, while a CHANGED value re-seeds.
 */

describe('DatePickerViewState — seed + navigation (DATE-1)', () => {
  it('seeds the visible month from an ISO value', () => {
    const v = new DatePickerViewState();
    v.syncToValue('2026-05-20');
    expect([v.viewYear, v.viewMonth]).toEqual([2026, 4]); // May
  });

  it('falls back to `now` when value is empty/unparseable', () => {
    const now = new Date(2027, 8, 3); // 2027-09-03
    const v = new DatePickerViewState();
    v.syncToValue('', now);
    expect([v.viewYear, v.viewMonth]).toEqual([2027, 8]);
    v.syncToValue('not-a-date', now);
    expect([v.viewYear, v.viewMonth]).toEqual([2027, 8]);
  });

  it('advances forward across a year boundary', () => {
    const v = new DatePickerViewState();
    v.syncToValue('2026-11-15');
    v.nextMonth(); // Dec 2026
    expect([v.viewYear, v.viewMonth]).toEqual([2026, 11]);
    v.nextMonth(); // Jan 2027
    expect([v.viewYear, v.viewMonth]).toEqual([2027, 0]);
  });

  it('navigates backward across a year boundary', () => {
    const v = new DatePickerViewState();
    v.syncToValue('2026-01-10');
    v.prevMonth();
    expect([v.viewYear, v.viewMonth]).toEqual([2025, 11]); // Dec 2025
  });

  it('REGRESSION: re-syncing the SAME value does NOT reset navigation', () => {
    const v = new DatePickerViewState();
    v.syncToValue('2026-05-20'); // May
    v.nextMonth(); // June
    v.nextMonth(); // July
    expect([v.viewYear, v.viewMonth]).toEqual([2026, 6]);

    // The host's `$effect` re-runs and calls syncToValue with the unchanged
    // value. Pre-fix this snapped the grid back to May; now it must hold July.
    v.syncToValue('2026-05-20');
    expect([v.viewYear, v.viewMonth]).toEqual([2026, 6]);
  });

  it('re-seeds when the value genuinely changes (new date applied)', () => {
    const v = new DatePickerViewState();
    v.syncToValue('2026-05-20');
    v.nextMonth(); // navigated to June
    v.syncToValue('2026-12-01'); // a different value DOES re-seed
    expect([v.viewYear, v.viewMonth]).toEqual([2026, 11]); // December
  });
});

describe('the date picker grid and keys (calendarGrid)', () => {
  it('starts the week on the locale\'s first day', () => {
    expect(weekStartDay('en-GB')).toBe(1);
    expect(weekStartDay('en-US')).toBe(0);
    expect(weekStartDay('not a locale!')).toBe(0);
    expect(weekdayLabels(1, 'en-GB').map((d) => d.long)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  });

  it('shows six weeks from the week start on or before the 1st', () => {
    const monday = calendarCells(2026, 9, 1); // October 2026 starts on a Thursday
    expect(monday).toHaveLength(42);
    expect(monday[0]).toBe('2026-09-28');
    expect(calendarCells(2026, 9, 0)[0]).toBe('2026-09-27');
    expect(calendarCells(2026, 1, 0)[0]).toBe('2026-02-01'); // Feb 2026 starts on a Sunday
  });

  it('moves a day, a week, to the week\'s ends and by a month', () => {
    const wed = '2026-10-14';
    expect(dateKeyMove('ArrowLeft', wed, 1)).toEqual({ days: -1 });
    expect(dateKeyMove('ArrowDown', wed, 1)).toEqual({ days: 7 });
    expect(dateKeyMove('Home', wed, 1)).toEqual({ days: -2 });
    expect(dateKeyMove('End', wed, 1)).toEqual({ days: 4 });
    expect(dateKeyMove('Home', wed, 0)).toEqual({ days: -3 });
    expect(dateKeyMove('PageDown', wed, 1)).toEqual({ months: 1 });
    expect(dateKeyMove('x', wed, 1)).toBeNull();
    expect(shiftDay('2026-01-31', { months: 1 })).toBe('2026-02-28');
    expect(shiftDay('2026-12-31', { days: 1 })).toBe('2027-01-01');
  });

  it('the month buttons move the keyboard\'s day with the month', () => {
    const v = new DatePickerViewState();
    v.syncToValue('2026-01-31');
    v.nextMonth();
    expect(v.focusedIso).toBe('2026-02-28');
    v.move({ days: 1 });
    expect([v.viewYear, v.viewMonth, v.focusedIso]).toEqual([2026, 2, '2026-03-01']);
  });
});

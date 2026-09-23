import { describe, it, expect } from 'vitest';
import { DatePickerViewState } from '@renderer/lib/tasklist/datePickerViewState.svelte';

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

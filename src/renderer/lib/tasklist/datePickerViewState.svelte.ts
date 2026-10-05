/**
 * DatePickerViewState — the reactive state of `TaskDatePicker.svelte`: which
 * month the grid shows and which day the keyboard is on. Kept out of the
 * component so it can be unit-tested without mounting it; the calendar
 * arithmetic is `calendarGrid.ts`.
 *
 * Re-seeding viewMonth/viewYear from `value` inside an `$effect` that ALSO
 * read them would reset the view on every ‹/› navigation, making it impossible
 * to reach a different month. So `syncToValue` re-seeds ONLY when `value`
 * actually changed since the last seed, tracked in a PLAIN (non-reactive)
 * field. The component drives it from `$effect(() => view.syncToValue(value))`,
 * which reads only `value`, so navigation never triggers a reseed.
 */
import { localIsoDate, parseLocalIsoDate } from '../utils/dateFormat';
import { calendarCells, shiftDay, type DayMove } from './calendarGrid';

export class DatePickerViewState {
  /** 0-based month and full year of the currently-visible grid. */
  viewYear = $state(0);
  viewMonth = $state(0);
  /** The day the keyboard is on (`YYYY-MM-DD`): the chosen day, else today. */
  focusedIso = $state('');

  /** The `value` the view was last seeded from. PLAIN (non-reactive) on
   *  purpose — making it `$state` would re-introduce the reset loop. */
  private lastSeeded: string | null = null;

  /**
   * Idempotently seed the visible month and the keyboard's day from
   * `value`. A no-op when `value` is unchanged since the last seed, so the
   * host's `$effect` can call it on every tick without clobbering the user's
   * month navigation. Falls back to `now` (default: current date) when
   * `value` is empty/unparseable.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- throwaway scratch Date; only its getFullYear/getMonth are read into $state, the Date itself is never stored
  syncToValue(value: string, now: Date = new Date()): void {
    if (value === this.lastSeeded) return;
    this.lastSeeded = value;
    const seed = parseLocalIsoDate(value) ?? now;
    this.viewYear = seed.getFullYear();
    this.viewMonth = seed.getMonth();
    this.focusedIso = localIsoDate(seed);
  }

  /** The ‹ button: the month before, the keyboard's day with it. */
  prevMonth(): void {
    this.move({ months: -1 });
  }

  /** The › button: the month after, the keyboard's day with it. */
  nextMonth(): void {
    this.move({ months: 1 });
  }

  /** Moves the keyboard's day (by days, or by months) and shows its month. */
  move(by: DayMove): void {
    const next = shiftDay(this.focusedIso, by);
    const d = parseLocalIsoDate(next);
    if (!d) return;
    this.focusedIso = next;
    this.viewYear = d.getFullYear();
    this.viewMonth = d.getMonth();
  }

  /** The 42 days the grid shows for the visible month. */
  cells(weekStart: number): string[] {
    return calendarCells(this.viewYear, this.viewMonth, weekStart);
  }
}

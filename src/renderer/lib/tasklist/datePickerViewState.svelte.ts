/**
 * DatePickerViewState — the reactive "which month is the grid showing" state
 * for `TaskDatePicker.svelte`, extracted so it can be unit-tested without
 * mounting the component (the repo's vitest setup can't preprocess a `.svelte`
 * `<style>` block).
 *
 * Re-seeding viewMonth/viewYear from `value` inside an `$effect` that ALSO
 * read them would reset the view on every ‹/› navigation, making it impossible
 * to reach a different month. So `syncToValue` re-seeds ONLY when `value`
 * actually changed since the last seed, tracked in a PLAIN (non-reactive)
 * field. The component drives it from `$effect(() => view.syncToValue(value))`,
 * which reads only `value`, so navigation never triggers a reseed.
 */

/** Parse a strict `YYYY-MM-DD` string to a local Date, or null. */
function parseIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(parseInt(m[1] ?? '', 10), parseInt(m[2] ?? '', 10) - 1, parseInt(m[3] ?? '', 10));
}

export class DatePickerViewState {
  /** 0-based month and full year of the currently-visible grid. */
  viewYear = $state(0);
  viewMonth = $state(0);

  /** The `value` the view was last seeded from. PLAIN (non-reactive) on
   *  purpose — making it `$state` would re-introduce the reset loop. */
  private lastSeeded: string | null = null;

  /**
   * Idempotently seed the visible month from `value`. A no-op when `value`
   * is unchanged since the last seed, so the host's `$effect` can call it on
   * every tick without clobbering the user's month navigation. Falls back to
   * `now` (default: current date) when `value` is empty/unparseable.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- throwaway scratch Date; only its getFullYear/getMonth are read into $state, the Date itself is never stored
  syncToValue(value: string, now: Date = new Date()): void {
    if (value === this.lastSeeded) return;
    this.lastSeeded = value;
    const seed = parseIsoDate(value) ?? now;
    this.viewYear = seed.getFullYear();
    this.viewMonth = seed.getMonth();
  }

  prevMonth(): void {
    if (this.viewMonth === 0) {
      this.viewMonth = 11;
      this.viewYear -= 1;
    } else {
      this.viewMonth -= 1;
    }
  }

  nextMonth(): void {
    if (this.viewMonth === 11) {
      this.viewMonth = 0;
      this.viewYear += 1;
    } else {
      this.viewMonth += 1;
    }
  }
}

/**
 * The local calendar day, as a rune the views can read. A Task List's Today /
 * Upcoming / Overdue lists and its due-date groups depend on it; reading
 * `new Date()` inside a `$derived` gives the date of the last recompute, so a
 * window left open over midnight kept yesterday's lists until something else
 * changed.
 *
 * The day moves on at local midnight (a timer armed for it), and is checked
 * again when the window regains focus or becomes visible and every few
 * minutes, since a timer can fire late after the machine sleeps.
 *
 * Not vault state: the date is the same whichever vault is open.
 */

const RECHECK_MS = 5 * 60_000;

function startOfToday(now: number = Date.now()): number {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch; the rune is `today` (a number)
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// allow-module-state: the calendar day, the same for every vault
let today = $state(startOfToday());
// allow-module-state: the timers that move the day on; armed on first read
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
// allow-module-state: see midnightTimer
let recheckTimer: ReturnType<typeof setInterval> | null = null;

function recheck(): void {
  const now = startOfToday();
  if (now !== today) today = now;
}

function armMidnight(): void {
  if (midnightTimer !== null) clearTimeout(midnightTimer);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch; the rune is `today` (a number)
  const next = new Date(today);
  next.setDate(next.getDate() + 1);
  // A little past midnight, so the recheck lands on the new day.
  midnightTimer = setTimeout(() => {
    recheck();
    armMidnight();
  }, Math.max(1000, next.getTime() - Date.now() + 500));
}

function onWake(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  recheck();
  armMidnight();
}

function start(): void {
  if (recheckTimer !== null) return;
  armMidnight();
  recheckTimer = setInterval(onWake, RECHECK_MS);
  if (typeof window !== 'undefined') window.addEventListener('focus', onWake);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onWake);
}

export const clockStore = {
  /** Local midnight of the current day, in ms. Reading it starts the clock. */
  get today(): number {
    start();
    return today;
  },

  /** A fresh Date at local midnight of the current day (the caller's to keep). */
  todayDate(): Date {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a copy for the caller; reads of `today` track the day
    return new Date(this.today);
  },

  /** Stops the timers (tests). */
  stop(): void {
    if (midnightTimer !== null) clearTimeout(midnightTimer);
    if (recheckTimer !== null) clearInterval(recheckTimer);
    midnightTimer = null;
    recheckTimer = null;
    if (typeof window !== 'undefined') window.removeEventListener('focus', onWake);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onWake);
    today = startOfToday();
  },
};

/**
 * Cadence gate for the TimerTile coarse countdown persist.
 *
 * A RUNNING countdown can't write per tick (a per-100 ms write would re-arm the
 * board's 300 ms debounce forever, so the board never flushes), yet with no
 * writes its progress is unrecoverable on quit (the Svelte tree never unmounts,
 * so onDestroy's persist never runs) and on vault swap. A COARSE periodic
 * persist lets the board debounce flush between writes and loses at most one
 * cadence interval of countdown.
 *
 * Pure closure so the cadence contract (fires once per interval, never
 * faster) is unit-testable without mounting the component.
 */

export const TIMER_COARSE_PERSIST_MS = 45_000;

/**
 * Returns a predicate that yields true at most once per `intervalMs`,
 * anchored at `armedAtMs` (the moment the countdown started/resumed) so the
 * first persist comes one full interval after arming, not immediately.
 */
export function createCoarsePersistGate(
  armedAtMs: number,
  intervalMs: number = TIMER_COARSE_PERSIST_MS,
): (nowMs: number) => boolean {
  let lastMs = armedAtMs;
  return (nowMs: number): boolean => {
    if (nowMs - lastMs < intervalMs) return false;
    lastMs = nowMs;
    return true;
  };
}

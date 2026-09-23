/**
 * Audit-17 4.6 — cadence gate for the TimerTile coarse countdown persist.
 *
 * A RUNNING countdown deliberately writes nothing per tick (Audit2 4.1: the
 * per-100 ms write re-armed the board's 300 ms debounce forever, so the
 * board's writes never flushed), which made the progress unrecoverable on
 * quit (the Svelte tree never unmounts, so onDestroy's persist never runs)
 * and on vault swap (the pre-swap cache clear runs before unmount). The fix
 * is a COARSE periodic persist: at this cadence the board debounce flushes
 * between writes, so the 4.1 bug is not reintroduced, and at most one
 * cadence interval of countdown is lost.
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

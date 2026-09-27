/**
 * Loads every board type's code while the app is idle after a vault opens, so
 * the first open of a board doesn't wait for its chunk (TipTap alone is about
 * 1 MB). The loaders are the registry's own lazy `import()`s, which the module
 * system caches, so a later open resolves at once and nothing loads twice.
 */

/** Delay after a vault opens before the idle load starts. */
export const BOARD_PRELOAD_DELAY_MS = 1000;
/** Longest the idle load waits for the browser to go idle. */
export const BOARD_PRELOAD_IDLE_TIMEOUT_MS = 2000;

export type BoardModuleLoader = () => Promise<unknown>;

/**
 * Schedules the loaders to run once the app is idle, about
 * `BOARD_PRELOAD_DELAY_MS` after the call. Returns a cancel function, for a
 * vault that closes before it runs.
 *
 * A failed load is ignored here: opening that board runs the same import
 * again and shows "Failed to load board" if it still fails.
 */
export function scheduleBoardModulePreload(loaders: readonly BoardModuleLoader[]): () => void {
  let cancelled = false;
  let idleHandle: number | null = null;

  const run = (): void => {
    idleHandle = null;
    if (cancelled) return;
    for (const load of loaders) {
      void load().catch(() => undefined);
    }
  };

  const timer = setTimeout(() => {
    if (cancelled) return;
    // jsdom has no requestIdleCallback; there the load runs after the delay.
    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(run, { timeout: BOARD_PRELOAD_IDLE_TIMEOUT_MS });
    } else {
      run();
    }
  }, BOARD_PRELOAD_DELAY_MS);

  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (idleHandle !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleHandle);
    }
    idleHandle = null;
  };
}

/**
 * Minimal trailing-edge debounce.
 *
 * `trigger()` (re)arms a timer; the callback fires once, `delayMs` after the
 * LAST trigger in a burst. `cancel()` drops any pending fire (call it on
 * teardown so the timer can't fire after the owner unmounts).
 *
 * Used by the `vault:tree-updated` listener to coalesce a sync-storm /
 * multi-file git burst — which fires many tree-updated events in quick
 * succession — into a single tree reconcile, instead of one full-vault walk
 * (tree re-filter/sort + broken-ref recompute over every board) per event.
 */
export interface TrailingDebounce {
  /** (Re)arm the timer. The callback fires `delayMs` after the last call. */
  trigger(): void;
  /** Cancel any pending fire (no-op when nothing is pending). */
  cancel(): void;
  /** Whether a fire is currently scheduled. */
  readonly pending: boolean;
}

export function createTrailingDebounce(fn: () => void, delayMs: number): TrailingDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get pending(): boolean {
      return timer !== null;
    },
  };
}

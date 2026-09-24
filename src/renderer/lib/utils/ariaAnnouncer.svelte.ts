/**
 * Screen-reader live-region announcer.
 *
 * Holds the current announcement text for an `aria-live` region and auto-clears
 * it after `clearDelayMs` so the region doesn't retain stale text. Shared by
 * TaskListBoard and KanbanBoard so the auto-clear timer can be cancelled on
 * unmount (otherwise a board torn down within the clear window leaves a
 * `setTimeout` armed against orphaned component state).
 *
 * `dispose()` cancels the pending timer — call it from the host's `onDestroy`.
 */
export interface AriaAnnouncer {
  /** Current live-region text. Reactive — read it in the template. */
  readonly message: string;
  /** Announce `message`; the text auto-clears after the configured delay. */
  announce(message: string): void;
  /** Cancel the pending auto-clear timer. Call from the host's `onDestroy`. */
  dispose(): void;
}

export function createAriaAnnouncer(clearDelayMs = 4000): AriaAnnouncer {
  let message = $state('');
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    get message(): string {
      return message;
    },
    announce(next: string): void {
      // Re-assigning the same string wouldn't re-trigger aria-live; pad with a
      // zero-width space on repeat so the live region fires on every action.
      message = next === message ? `${next}​` : next;
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        message = '';
        clearTimer = null;
      }, clearDelayMs);
    },
    dispose(): void {
      if (clearTimer) {
        clearTimeout(clearTimer);
        clearTimer = null;
      }
    },
  };
}

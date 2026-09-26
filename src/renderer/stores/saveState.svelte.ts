/**
 * Save-state store: drives the toolbar's save indicator.
 *
 * App.svelte feeds it the write ledger's counts (`unsavedWork()`) on every
 * write-state change, and the store derives what the indicator shows:
 *   - 'saved'  (green): nothing pending, in flight or failed.
 *   - 'saving' (yellow): something is queued or being written.
 *   - 'error'  (red): a write failed; clickable, lists the failed paths.
 *
 * Also tracks the most recent failed paths (capped + dedup'd) for the error
 * popover's list and Retry button. A clean drain clears them.
 */

import { onVaultSwap } from '../core/vaultLifecycle';

export type SaveState = 'saving' | 'saved' | 'error';

const MAX_TRACKED_FAILED_PATHS = 50;

/**
 * How long work must stay unsaved before the indicator turns yellow. A save
 * that lands within it never flickers the indicator away from green.
 */
export const SAVING_SHOW_DELAY_MS = 150;

let state = $state<SaveState>('saved');
let failedPaths = $state<string[]>([]);

let showSavingTimer: ReturnType<typeof setTimeout> | null = null;

function cancelShowSaving(): void {
  if (showSavingTimer) {
    clearTimeout(showSavingTimer);
    showSavingTimer = null;
  }
}

export const saveStateStore = {
  get state() { return state; },
  /** Most recent failed paths (newest first). Capped at MAX_TRACKED_FAILED_PATHS. */
  get failedPaths() { return failedPaths; },

  /**
   * Push the ledger's counts:
   *   failed > 0                   → 'error' at once (sticky until a clean drain)
   *   inflight > 0 OR pending > 0  → 'saving', once it has lasted SAVING_SHOW_DELAY_MS
   *   nothing left                 → 'saved'
   *
   * `pending` counts queued-but-not-yet-fired writes (a keystroke inside its
   * debounce) and note bodies held in memory, so the indicator never reads
   * "saved" while text is unwritten. Defaults to 0 for two-arg callers.
   *
   * `failed > 0` is checked BEFORE inflight/pending: a write that wedges past
   * `writeTimeoutMs` is marked failed while its inflight increment never
   * settles, so inflight-first ordering would show a perpetual "saving"
   * spinner for a genuinely failed write.
   */
  setStatus(inflight: number, failed: number, pending: number = 0): void {
    if (failed > 0) {
      cancelShowSaving();
      state = 'error';
      return;
    }
    if (inflight > 0 || pending > 0) {
      if (state === 'saving' || showSavingTimer) return;
      // Leaving red: the failure has cleared, but work remains, so there is
      // no green moment to wait for.
      if (state === 'error') {
        state = 'saving';
        return;
      }
      showSavingTimer = setTimeout(() => {
        showSavingTimer = null;
        state = 'saving';
      }, SAVING_SHOW_DELAY_MS);
      return;
    }
    cancelShowSaving();
    state = 'saved';
    // A clean drain wipes the recorded failures so the popover doesn't stay
    // populated after the next successful save.
    if (failedPaths.length > 0) failedPaths = [];
  },

  /**
   * Record a failed write path. Newest first, dedup'd
   * against existing entries (so retries don't double-list), capped to
   * MAX_TRACKED_FAILED_PATHS so a tag-rewrite sweep with hundreds of
   * failures doesn't unbound the array.
   */
  noteFailedPath(path: string): void {
    if (!path) return;
    const existing = failedPaths.indexOf(path);
    if (existing === 0) return; // already the newest
    const next = existing >= 0
      ? [path, ...failedPaths.slice(0, existing), ...failedPaths.slice(existing + 1)]
      : [path, ...failedPaths];
    failedPaths = next.slice(0, MAX_TRACKED_FAILED_PATHS);
  },

  /** Explicit clear (e.g. user clicked Retry and it succeeded). */
  clearFailedPaths(): void {
    if (failedPaths.length > 0) failedPaths = [];
  },

  /** Test-only reset. */
  __reset(): void {
    cancelShowSaving();
    state = 'saved';
    failedPaths = [];
  },
};

// Vault-swap reset: clears the failed-paths list and forces the indicator back
// to green so a stale "error" badge from the outgoing vault can't leak into the
// new vault's toolbar before the first save completes.
onVaultSwap('pre-swap', 'saveState', () => {
  cancelShowSaving();
  state = 'saved';
  if (failedPaths.length > 0) failedPaths = [];
});

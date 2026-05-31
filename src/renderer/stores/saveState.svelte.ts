/**
 * Save-state store — reflects whether any debounced write is in flight,
 * whether the last batch failed, and the timestamp of the most recent
 * successful flush. Drives the toolbar's save indicator (P1-13).
 *
 * Updated via `boardSaver.setWriteStateListener` — the lib layer pushes
 * raw `{ inflight, failed }` counts and this store derives the user-
 * visible state machine on top.
 *
 * Phase C / C.10 — the store also tracks the most recent failed paths
 * (capped + dedup'd) so the toolbar can surface a popover listing them
 * with a Retry button. Failure reporting is driven by `trackComponentWrite`
 * callsites that push paths through `noteFailedPath`; success drains them
 * via `clearFailedPaths`.
 */

import { onVaultSwap } from '../core/vaultLifecycle';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const MAX_TRACKED_FAILED_PATHS = 50;

let state = $state<SaveState>('idle');
let failedPaths = $state<string[]>([]);

let savedDecayTimer: ReturnType<typeof setTimeout> | null = null;

export const saveStateStore = {
  get state() { return state; },
  /** Most recent failed paths (newest first). Capped at MAX_TRACKED_FAILED_PATHS. */
  get failedPaths() { return failedPaths; },

  /**
   * Push a raw status from boardSaver. The store derives the UX state:
   *   inflight > 0 OR pending > 0       → 'saving'
   *   idle, failed                      → 'error' (sticky until next clean drain)
   *   idle, no fail                     → 'saved' for 2s, then 'idle'
   *
   * Audit2 2.3 — `pending` (debounced-but-not-yet-inflight writes, e.g. a
   * markdown body keystroke still inside its 300 ms debounce) also counts as
   * "saving". Without it the indicator read a premature "idle"/"saved" while
   * text was unwritten. Defaults to 0 so legacy two-arg callers are unaffected.
   */
  setStatus(inflight: number, failed: number, pending: number = 0): void {
    if (inflight > 0 || pending > 0) {
      if (savedDecayTimer) {
        clearTimeout(savedDecayTimer);
        savedDecayTimer = null;
      }
      state = 'saving';
      return;
    }
    if (failed > 0) {
      state = 'error';
      return;
    }
    // inflight === 0 && failed === 0: a clean drain. Show "saved" briefly
    // so the user sees the indicator transition (otherwise rapid edits
    // never give the UI a chance to communicate success).
    state = 'saved';
    // Phase C / C.10 — a clean drain wipes the recorded failures so the
    // popover doesn't stay populated after the next successful save.
    if (failedPaths.length > 0) failedPaths = [];
    if (savedDecayTimer) clearTimeout(savedDecayTimer);
    savedDecayTimer = setTimeout(() => {
      // Only decay if the state is still "saved" — another save may have
      // started in the meantime and we don't want to clobber that.
      if (state === 'saved') state = 'idle';
      savedDecayTimer = null;
    }, 2000);
  },

  /**
   * Phase C / C.10 — record a failed write path. Newest first, dedup'd
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
    if (savedDecayTimer) clearTimeout(savedDecayTimer);
    savedDecayTimer = null;
    state = 'idle';
    failedPaths = [];
  },
};

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Clears the failed-paths list and forces the indicator back to idle so a
// stale "error" badge from the outgoing vault can't leak into the new
// vault's toolbar before the first save completes.
onVaultSwap('pre-swap', 'saveState', () => {
  if (savedDecayTimer) {
    clearTimeout(savedDecayTimer);
    savedDecayTimer = null;
  }
  state = 'idle';
  if (failedPaths.length > 0) failedPaths = [];
});

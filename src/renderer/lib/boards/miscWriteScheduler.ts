/**
 * miscWriteScheduler — per-key debounced writes for one-off `.filo/` files.
 *
 * Covers `.filo/tags.json`, `.filo/themes/*.json`,
 * `.filo/templates/*.template.json`, `.filo/viewports.json`, and any
 * other single-file write that doesn't belong on `scheduleBoardWrite`
 * (per-board JSON) or `scheduleConfigWrite` (the four
 * workspace/defaults/app/appearance bundle).
 *
 * Routes every write through the shared inflight / sentinel /
 * write-error pipeline (via `createScheduler`) so failures surface in
 * the same save-state path as board and config writes.
 *
 * Phase R1 (2026-05-26) — backing scheduler swapped to the unified
 * `createScheduler` primitive. The legacy in-flight tracking,
 * fire-and-forget timer plumbing, and reset-callback registration now
 * live in `writeScheduler.ts`; this module supplies the misc-specific
 * `performWrite` (a closure passed in via args), the corruption gate,
 * and the missing-source toast copy.
 */

import { BOARD_WRITE_DEBOUNCE_MS, WRITE_TIMEOUT_MS } from './boardWriteDebounce';
import {
  notifyWriteError,
  registerResetCallback,
  registerTestResetCallback,
} from './writeStateTracking';
import { isConfigPathCorrupt } from './configWriteScheduler';
import { createScheduler } from './writeScheduler';

export interface MiscWriteArgs {
  vaultRoot: string;
  path: string;
  write: () => Promise<void>;
}

const miscScheduler = createScheduler<MiscWriteArgs>({
  name: 'miscWriteScheduler',
  debounceMs: BOARD_WRITE_DEBOUNCE_MS,
  performWrite: async (args) => {
    try {
      await args.write();
    } catch (err) {
      console.error(`[boardSaver] misc write failed for ${args.path}:`, err);
      notifyWriteError({ kind: 'config', path: args.path, error: err });
      throw err;
    }
  },
  getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: args.path }),
  getFailureId: (args) => args.path,
  // Phase 23 M20 — gate the write against the corruption sentinel. Loaded
  // a `.filo/viewports.json` or `.filo/hotkeys.json` in a corrupt state?
  // Skip the write so the user's hand-edited file isn't silently
  // overwritten with in-memory defaults.
  shouldSkipWrite: (args) => isConfigPathCorrupt(args.path),
  missingSourceMessage: () =>
    "Filo couldn't save a pending change (tags / theme / template / viewport). Re-apply if needed.",
  // Audit-11 WC-1 / QC-2 — the per-key `args.write()` closure is an IPC write
  // (tags / theme / template / viewport) that a stalled network volume can wedge.
  // Bound for uniformity so a wedged misc write can't hang `flushAll` / quit.
  writeTimeoutMs: WRITE_TIMEOUT_MS,
});

// Self-register cleanup so vault swap and test reset don't leak between vaults.
// Phase C / C.3 — production reset (vault swap) MUST cancel pending misc
// timers. Without this, a `.filo/tags.json` / viewports / sidebar order
// timer armed against the previous vault path would fire after a new
// vault opens — its closure carries the OLD vaultRoot and would write
// into the wrong tree (or fail silently if the path was removed).
registerResetCallback(() => miscScheduler.reset());
registerTestResetCallback(() => miscScheduler.reset());

/**
 * Schedules a debounced single-file write keyed by `key`. Subsequent calls
 * with the same key cancel the previous timer (last-wins) so bulk-tag /
 * rapid-rename operations coalesce into one disk write. Participates in
 * the inflight / sentinel / write-error pipeline so failures surface in
 * the same toast + save-state path as board and config writes.
 *
 * The args getter is re-invoked at fire time so the write captures the
 * latest in-memory state, not the state at schedule time.
 *
 * `debounceMs` defaults to the shared `BOARD_WRITE_DEBOUNCE_MS` (300ms).
 * Pass a longer window for chatty streams like viewport pan/zoom where
 * the user is "done" only after a sustained pause.
 */
export function scheduleMiscWrite(
  key: string,
  getWriteArgs: () => MiscWriteArgs | null,
  debounceMs: number = BOARD_WRITE_DEBOUNCE_MS,
): void {
  miscScheduler.schedule(key, getWriteArgs, debounceMs);
}

/**
 * Flushes every pending misc write immediately. Called from
 * `vaultStore.save()` so Ctrl+S / quit drains tags / theme / template
 * writes alongside board and config writes.
 *
 * Returns `{ failed }` listing the paths whose flush rejected (or whose
 * source disappeared before flush). `vaultStore.save()` folds
 * `failed.length === 0` into its aggregate boolean so a misc-write
 * failure no longer silently lets Ctrl+S report "Saved".
 *
 * Phase R1 — the primitive's `flushAll` snapshots in-flight up-front and
 * awaits Promise.all on swallow-catched trackers, then attributes
 * captured-failure lists to the result. Replaces the legacy in-flight
 * map + inFlightMiscFailures Set with a single source of truth.
 */
export async function flushAllMisc(): Promise<{ failed: string[] }> {
  const result = await miscScheduler.flushAll();
  return { failed: result.failed };
}

/**
 * Drains a single key's pending misc write immediately and awaits any
 * in-flight write for it. Returns `{ ok }` reflecting the per-write outcome.
 *
 * F3 (2026-05-28) — `fileTagsStore.flushPendingSave` calls this so the
 * rename cascade can persist `.filo/tags.json` synchronously, in the same
 * critical section as the awaited board flush, instead of leaving it on the
 * 300ms misc debounce where a crash could straddle the write and drop a
 * tag-membership rename.
 */
export async function flushMiscWrite(key: string): Promise<{ ok: boolean }> {
  return miscScheduler.flush(key);
}

/**
 * Cancels every queued misc write without firing them. Called from the
 * vault-swap path so a timer armed against the previous vault can't fire
 * after a new vault opens — its closure would otherwise write to the
 * OLD vaultRoot.
 *
 * Does not adjust the inflight counter because the cancelled timers
 * already counted via their original `beginWrite` at schedule time;
 * `resetWriteTracking` resets the counter as part of the vault-swap
 * sequence.
 */
export function cancelAllPendingMiscWrites(): void {
  miscScheduler.cancelAll();
}

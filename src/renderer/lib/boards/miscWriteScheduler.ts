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
 * In-flight tracking and timer plumbing live in `writeScheduler.ts`; this
 * module supplies the misc-specific `performWrite` (a closure passed in via
 * args), the corruption gate, and the missing-source toast copy.
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
  /** The whole file the write puts on disk, for a rescue copy when it can't. */
  json?: string;
}

/** Each key's latest args getter, read for rescue copies. */
// allow-module-state: cleared by the registerResetCallback below (vault swap)
const latestMiscArgs = new Map<string, () => MiscWriteArgs | null>();

/** Paths whose "not saving" notice has shown this vault session. */
// allow-module-state: cleared by the registerResetCallback below (vault swap)
const corruptNoticeShown = new Set<string>();

const miscScheduler = createScheduler<MiscWriteArgs>({
  name: 'miscWriteScheduler',
  debounceMs: BOARD_WRITE_DEBOUNCE_MS,
  performWrite: async (args) => {
    // Loaded a `.filo/viewports.json` or `.filo/hotkeys.json` in a corrupt
    // state? Don't write over the user's file with in-memory defaults. The
    // change isn't on disk, though, so it counts as failed (save() says so,
    // leaving keeps a rescue copy) rather than as saved; a retry can't fix it.
    if (isConfigPathCorrupt(args.path)) {
      const error = Object.assign(
        new Error(`${args.path} is unreadable on disk; changes to it are not being saved so it isn't overwritten.`),
        { code: 'CONFIG_CORRUPT' },
      );
      if (!corruptNoticeShown.has(args.path)) {
        corruptNoticeShown.add(args.path);
        notifyWriteError({ kind: 'config', path: args.path, error });
      }
      throw error;
    }
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
  missingSourceMessage: () =>
    "Filo couldn't save a pending change (tags / theme / template / viewport). Re-apply if needed.",
  // The per-key `args.write()` closure is an IPC write
  // (tags / theme / template / viewport) that a stalled network volume can wedge.
  // Bound for uniformity so a wedged misc write can't hang `flushAll` / quit.
  writeTimeoutMs: WRITE_TIMEOUT_MS,
  retainIoError: true,
});

// Self-register cleanup so vault swap and test reset don't leak between vaults.
// Production reset (vault swap) MUST cancel pending misc
// timers. Without this, a `.filo/tags.json` / viewports / sidebar order
// timer armed against the previous vault path would fire after a new
// vault opens — its closure carries the OLD vaultRoot and would write
// into the wrong tree (or fail silently if the path was removed).
registerResetCallback(() => {
  miscScheduler.reset();
  latestMiscArgs.clear();
  corruptNoticeShown.clear();
});
registerTestResetCallback(() => {
  miscScheduler.reset();
  latestMiscArgs.clear();
  corruptNoticeShown.clear();
});

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
  latestMiscArgs.set(key, getWriteArgs);
  miscScheduler.schedule(key, getWriteArgs, debounceMs);
}

/**
 * The file each misc write would put on disk, for the writes not saved yet:
 * still queued or in flight, or whose path `isUnsaved` names (a failed write).
 */
export function unsavedMiscPayloads(isUnsaved: (path: string) => boolean): Array<{ relPath: string; json: string }> {
  const out: Array<{ relPath: string; json: string }> = [];
  for (const [key, getArgs] of latestMiscArgs) {
    let args: MiscWriteArgs | null = null;
    try {
      args = getArgs();
    } catch {
      args = null;
    }
    if (!args || args.json === undefined) continue;
    if (miscScheduler.hasWork(key) || isUnsaved(args.path)) out.push({ relPath: args.path, json: args.json });
  }
  return out;
}

/**
 * Flushes every pending misc write immediately. Called from
 * `vaultStore.save()` so Ctrl+S / quit drains tags / theme / template
 * writes alongside board and config writes.
 *
 * Returns `{ failed }` listing the paths whose flush rejected (or whose
 * source disappeared before flush). `vaultStore.save()` folds
 * `failed.length === 0` into its aggregate boolean so a misc-write
 * failure can't let Ctrl+S report "Saved".
 */
export async function flushAllMisc(): Promise<{ failed: string[] }> {
  const result = await miscScheduler.flushAll();
  return { failed: result.failed };
}

/**
 * Drains a single key's pending misc write immediately and awaits any
 * in-flight write for it. Returns `{ ok }` reflecting the per-write outcome.
 *
 * `fileTagsStore.flushPendingSave` calls this so the
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

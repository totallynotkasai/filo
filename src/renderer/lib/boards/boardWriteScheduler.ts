/**
 * boardWriteScheduler — debounced `.board.json` write pipeline.
 *
 * Drives the per-board pending-timer map, the scheduling/flush/cancel
 * surface, and the actual `writeBoardFile` payload-cleanup pass. Every
 * write routes through the shared inflight / sentinel / write-error
 * pipeline (via the `createScheduler` primitive) so failures surface in
 * the same save-state path as config and misc writes.
 *
 * Pending + in-flight + failure bookkeeping live in `createScheduler`. Two
 * board-specific behaviours hook into the primitive:
 *  - **Snapshot at fire time.** The deep clone of the `cached` board data
 *    happens at fire time, so N keystroke-rate schedules within a 300 ms
 *    window collapse to a single clone.
 *  - **Rename-mid-debounce path bookkeeping.** The
 *    `onReschedule` hook drops the old pendingVaultPath and notes the
 *    new one when the same boardId is rescheduled to a different path
 *    (e.g. rename happened between two `scheduleBoardWrite` calls).
 */

import type { BoardFileData } from './tileDefBuilder';
import { CURRENT_BOARD_FILE_VERSION } from '../../schema/boardFile';
import { BOARD_WRITE_DEBOUNCE_MS, WRITE_TIMEOUT_MS, ENOENT_RESTAT_DELAY_MS, writtenByteLength } from './boardWriteDebounce';
import {
  notifyWriteError,
  noteAdditionalPendingPath,
  dropPendingPath,
  markRecentSelfWrite,
  clearFailedPathAfterLateSuccess,
  registerResetCallback,
  registerTestResetCallback,
} from './writeStateTracking';
import { BoardDriftHeldError, holdBoardDrift, isBoardDriftHeld } from './boardDriftHold';
import { BoardMoveHeldError, isBoardMoveHeld } from './boardMoveHold';
import { hasUncopiedOlderFormat, keepOlderFormatFile } from './migratedBoards';
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { createScheduler } from './writeScheduler';
import { isAtOrUnder, vaultPath, type VaultPath } from '../../../shared/vaultPath';
import { registerPathRenamable } from '../vault/renamePathKeys';
import { getBaseline, hasBaselineDrifted, isBaselineUnverified, refreshBaselineAfterWrite, unverifiedLoadedContent } from '../vault/fileBaselineRegistry';

/**
 * The "board file changed outside Filo" question. The implementation lives in
 * `stores/boardDrift.ts` (it needs uiStore); `vaultExternalDriftPrompts.ts`
 * registers it at startup through `setBoardExternalEditHandler`.
 *
 * The writer never waits for the answer. It holds the board
 * (`boardDriftHold`), asks, and fails the write at once with
 * `BoardDriftHeldError`, which the scheduler retains without re-firing. The
 * handler carries out the answer: Reload discards the held write
 * (`discardBoardWrite`), Keep local re-fires it (`retryFailedBoardWrite`),
 * and a dismissal (`'defer'`) leaves the board held, its cache dirty.
 *
 * With no handler registered (tests, early boot) nothing can ask, so a drift
 * fails the write with `EXTERNAL_EDIT` and a failure notice; the external
 * edit is never overwritten.
 */
export type BoardExternalEditHandler = (path: string) => Promise<'reload' | 'keep-local' | 'defer'>;
let boardExternalEditHandler: BoardExternalEditHandler | null = null;

/**
 * Grace delay before the pre-write ENOENT re-stat (shared with the config
 * scheduler). Exported for the unit test's timer control.
 */
export const BOARD_ENOENT_RESTAT_DELAY_MS = ENOENT_RESTAT_DELAY_MS;

/** Starts the drift question without waiting for it; its failure is reported, never left unhandled. */
function askAboutDrift(handler: BoardExternalEditHandler, boardPath: string): void {
  void handler(boardPath).catch((err: unknown) => {
    console.error(`[boardWriteScheduler] drift question for "${boardPath}" failed:`, err);
  });
}

export function setBoardExternalEditHandler(handler: BoardExternalEditHandler | null): void {
  boardExternalEditHandler = handler;
}

/**
 * Board paths whose `.board.json` is being deleted. `deleteBoard` (boardCache)
 * marks the path BEFORE the `board:delete` IPC and clears it once any in-flight
 * write has drained. `writeBoardFile` checks it just before `board:save`: an
 * in-flight write (e.g. awaiting its pre-write stat) would otherwise resume
 * after the unlink and re-create the file as a ghost board — `cancelBoardWrite`
 * only reaches pending/parked timers. Cleared on vault swap.
 */
// allow-module-state: reset via the boardScheduler reset callback (vault swap)
const boardsBeingDeleted = new Set<string>();

export function markBoardPathDeleting(boardPath: string): void {
  if (boardPath) boardsBeingDeleted.add(boardPath);
}

export function clearBoardPathDeleting(boardPath: string): void {
  boardsBeingDeleted.delete(boardPath);
}

function isBoardPathDeleting(boardPath: string): boolean {
  return boardsBeingDeleted.has(boardPath);
}

/**
 * Board paths whose file vanished from disk while the board is
 * open (an external folder rename, a synced move). Until the re-check decides
 * (rebound by the reconcile rename / back on disk / really gone), a write to a
 * held path must NOT run: `board:save` is a creating channel and would
 * resurrect the old folder. Unlike `boardsBeingDeleted` (a clean no-op), a held
 * write THROWS `BoardPathHeldError` so the scheduler records it failed (the
 * crash sentinel stays dirty) and RETAINS its args; the re-check re-fires it to
 * the new path. `VaultPath` keys (case-folded). Cleared on vault swap.
 */
// allow-module-state: reset via the boardScheduler reset callback (vault swap)
const heldBoardPaths = new Set<VaultPath>(); // allow-no-rename-transfer: the hold is on the OLD path by design; the renamed-to path must stay writable

export class BoardPathHeldError extends Error {
  readonly code = 'BOARD_PATH_HELD';
  constructor(boardPath: string) {
    super(`Board "${boardPath}" is missing on disk; its write is held until Filo finds where it went.`);
    this.name = 'BoardPathHeldError';
  }
}

export function holdBoardPath(boardPath: string): void {
  if (boardPath) heldBoardPaths.add(vaultPath(boardPath));
}

export function releaseBoardPath(boardPath: string): void {
  heldBoardPaths.delete(vaultPath(boardPath));
}

export function isBoardPathHeld(boardPath: string): boolean {
  return heldBoardPaths.has(vaultPath(boardPath));
}

/**
 * Board paths the user chose to save at their original location although the
 * file (and maybe its folder) is gone. Only these writes may create the file
 * again, folder included; any other write of a missing board is a no-op or a
 * failure, never a resurrection. Cleared once the write lands, and on vault swap.
 */
// allow-module-state: reset via the boardScheduler reset callback (vault swap)
const boardsToRecreate = new Set<VaultPath>(); // allow-no-rename-transfer: the user chose this exact path

/** The next write of `boardPath` recreates it where it was (the "Save at original location" answer). */
export function recreateBoardAt(boardPath: string): void {
  if (boardPath) boardsToRecreate.add(vaultPath(boardPath));
}

/** True when the board has an unsaved (pending / in-flight / retained) write. */
export function boardHasUnsavedWrite(boardId: string): boolean {
  return boardScheduler.hasWork(boardId);
}

/** Re-fires the board's retained failed write (e.g. after a hold is released). */
export function retryFailedBoardWrite(boardId: string): Promise<{ failed: string[] }> {
  return boardScheduler.retryFailed(boardId);
}

/**
 * The board was read from disk in place of Filo's copy: nothing written,
 * retained or failed for it is owed any more.
 */
export function discardBoardWrite(boardId: string, boardPath: string, vaultRoot: string | undefined): void {
  boardScheduler.cancel(boardId, boardPath);
  boardScheduler.discardRetained(boardId);
  clearFailedPathAfterLateSuccess(vaultRoot, boardPath);
}

export interface BoardWriteArgs {
  vaultRoot: string;
  boardPath: string;
  cached: BoardFileData;
}

/**
 * Per-board scheduler. The primitive owns pending/in-flight/failure
 * tracking; this module supplies the per-write snapshot, the rename-
 * mid-debounce hook, and the missing-source toast copy.
 */
const boardScheduler = createScheduler<BoardWriteArgs>({
  name: 'boardWriteScheduler',
  debounceMs: BOARD_WRITE_DEBOUNCE_MS,
  // Clone at fire time / flushAll capture time, not at schedule time: N
  // keystroke-rate schedules within the debounce window collapse into one
  // serialise/parse, and `writeBoardFile`'s in-place mutations bite the
  // snapshot, not the live proxy.
  //
  // The `JSON.parse(JSON.stringify())` round-trip is the INTENDED
  // normalisation: `.board.json` is written via `JSON.stringify`, so the
  // snapshot equals the eventual on-disk value space. The cache only holds
  // JSON-safe data, so it's lossless in practice. If a field ever needs a
  // non-JSON type (Date, Set), switch to `structuredClone` AND teach
  // `writeBoardFile` to serialise it.
  snapshotArgs: (args) => ({
    ...args,
    cached: JSON.parse(JSON.stringify(args.cached)) as BoardFileData,
  }),
  performWrite: async (args, ctx) => {
    // Thread the per-fire currency check so a superseded write that lands late
    // skips its post-write drift-baseline stamp.
    await writeBoardFile(args.vaultRoot, args.boardPath, args.cached, ctx.isLatestWrite);
  },
  getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: args.boardPath }),
  getFailureId: (args) => args.boardPath,
  holdRetained: (args) => isBoardDriftHeld(args.boardPath) || isBoardMoveHeld(args.cached.board.id),
  // An in-app rename is moving the board's file: its write waits for the move.
  deferFire: (args) => isBoardMoveHeld(args.cached.board.id),
  onReschedule: (prev, next) => {
    // If the path changed between schedule calls (rename-mid-debounce), drop
    // the OLD entry from pendingVaultPaths before adding the new one —
    // otherwise it leaks into the sentinel forever (endWrite only touches the
    // new path).
    if (!next.path) return;
    if (prev.path && prev.path !== next.path) {
      dropPendingPath(prev.vaultRoot ?? next.vaultRoot, prev.path);
    }
    noteAdditionalPendingPath(next.vaultRoot, next.path);
  },
  missingSourceMessage: (key) =>
    `Filo couldn't save the latest changes (boardId: ${key}). Re-open the board and try again.`,
  // A board that failed at its old path (moved mid-write) and then saved at
  // its new one owes nothing at the old path any more.
  onEarlierFailureHealed: (failureId, sentinel) => clearFailedPathAfterLateSuccess(sentinel.vaultRoot, failureId),
  // `writeBoardFile` awaits the pre-write `vault:stat` (and, for an unverified
  // board, a read) plus `board:save`, any of which can wedge on a stalled
  // network volume. Bound it so a wedged board write can't hang `flushAll` /
  // quit. (It never awaits the drift question: see `boardDriftHold`.)
  writeTimeoutMs: WRITE_TIMEOUT_MS,
  retainIoError: true,
});

// A board file (or its folder) moved while a full save holds a copy of its
// write: the copy names the old path, so it is replaced by a write that reads
// the board's new one. Every rename runs this sweep after the board cache has
// rebound the board's path (`renameBoardPath`).
registerPathRenamable('boardWriteScheduler', (oldRel) => {
  boardScheduler.replaceCapturesUnder((path) => isAtOrUnder(path, oldRel));
});

/**
 * Schedules a debounced write for a specific board's .board.json file.
 *
 * The deep clone is taken at FIRE TIME, not at schedule time, so keystroke /
 * pointermove ticks share a single snapshot. Path bookkeeping for the sentinel
 * happens at schedule time so a rename-mid-debounce is detected as it occurs.
 */
export function scheduleBoardWrite(
  boardId: string,
  getWriteArgs: () => BoardWriteArgs | null,
): void {
  boardScheduler.schedule(boardId, getWriteArgs);
}

/**
 * Writes a single board's data to its .board.json file via IPC.
 *
 * NOTE: This function MUTATES `cached` in place — callers must pass an
 * isolated snapshot, never a live store reference. `scheduleBoardWrite`
 * already deep-clones at fire time, so the production pipeline is safe
 * (no second clone here, to avoid doubling the JSON.stringify cost).
 */
export async function writeBoardFile(
  vaultRoot: string,
  boardPath: string,
  cached: BoardFileData,
  // Optional currency check from the scheduler. When a later write superseded
  // this one, the post-write baseline stamp is SKIPPED so it can't anchor the
  // drift baseline to stale bytes. Defaults to "latest" for direct callers.
  isLatestWrite?: () => boolean,
): Promise<void> {
  // The board was deleted while this write was pending/in flight; skip as a
  // clean no-op so we don't re-create the just-unlinked `.board.json`.
  // (Re-checked right before `board:save` below.)
  if (isBoardPathDeleting(boardPath)) return;
  // Held (missing on disk, re-check pending): fail loudly and
  // let the scheduler retain the write rather than recreate the old path.
  if (isBoardPathHeld(boardPath)) throw new BoardPathHeldError(boardPath);
  // Its file is being moved (a rename forced this write out, e.g. a save
  // meanwhile): kept, and written at the path the move ends at.
  if (isBoardMoveHeld(cached.board.id)) throw new BoardMoveHeldError(boardPath);
  // Waiting for a Reload / Keep local answer: no write can land until it is
  // in. Show the question again if it was dismissed (one per path), and
  // refuse without a stat or a failure toast.
  if (isBoardDriftHeld(boardPath) && boardExternalEditHandler) {
    askAboutDrift(boardExternalEditHandler, boardPath);
    throw new BoardDriftHeldError(boardPath);
  }
  const recreate = boardsToRecreate.has(vaultPath(boardPath));
  const fileData = cached;
  // Stamp the envelope version on every write. The cache holds only the
  // current shape (defs are built by `buildTileDefinition`), so nothing else
  // needs cleaning on the way to disk.
  fileData.version = CURRENT_BOARD_FILE_VERSION;
  const payload = JSON.stringify(fileData, null, 2);

  // Pre-write drift check. If the on-disk mtime no longer
  // matches the baseline captured at load (or after the last successful
  // self-write), an external tool wrote to the .board.json since we last
  // knew about it. Hold the board and surface a Reload / Keep-local choice;
  // this write is refused meanwhile. A board whose load couldn't pin the
  // version on disk (unverified) is read and counts as drifted unless the file
  // already holds what Filo is about to write. No baseline and not unverified:
  // the file was never loaded (a first write), so there is nothing to compare.
  const baseline = getBaseline(boardPath);
  const unverified = baseline === undefined && isBaselineUnverified(boardPath);
  if (baseline !== undefined || unverified) {
    let preWriteStat: { mtimeMs: number; size: number } | undefined;
    try {
      preWriteStat = await invokeOk('vault:stat', vaultRoot, boardPath);
    } catch (err) {
      // ENOENT means the .board.json was deleted on disk (external tool / sync
      // client) while this write was armed. Falling through to `board:save`
      // would resurrect it and fight the sync, so abort as a clean no-op
      // (return, not throw) — the same outcome as `cancelBoardWrite`.
      //
      // Only for a file known to exist (it has a baseline or was loaded), so
      // its absence is a deletion. A freshly-created board has neither and
      // skips this block, so first writes are unaffected.
      if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
        // Re-stat ONCE before treating the ENOENT as a delete: a sync client /
        // AV can momentarily unlink-then-recreate the file, and treating that
        // blip as a delete would silently drop the debounce window's mutations.
        // If the file reappears, fall through to the drift check below (a
        // recreate carries a new mtime → the user is prompted). Still missing
        // → genuine delete; the watcher's delete pipeline owns it.
        await new Promise((resolve) => setTimeout(resolve, BOARD_ENOENT_RESTAT_DELAY_MS));
        try {
          preWriteStat = await invokeOk('vault:stat', vaultRoot, boardPath);
        } catch (reErr) {
          if (reErr instanceof IpcEnvelopeError && reErr.code === 'ENOENT') {
            // Gone: nothing to write over, unless the user asked for it back.
            if (!recreate) return;
          }
          // Re-stat hit a different error (EACCES / transient share hiccup):
          // fall through with no preWriteStat — the save IPC below surfaces
          // a genuine IO problem through the failure attribution pipeline.
        }
      }
      // Any other stat error (EACCES, a transient share hiccup): fall through
      // — the save IPC below surfaces a genuine IO problem through the failure
      // attribution pipeline.
    }
    if (unverified && preWriteStat === undefined) {
      // Kept for a retry: the file may hold a version Filo never read.
      throwRetainable(boardPath, `Couldn't check ${boardPath} before saving.`);
    }
    const drifted =
      preWriteStat !== undefined &&
      (baseline !== undefined
        ? hasBaselineDrifted(baseline, preWriteStat)
        : !(await diskIsFilosVersion(vaultRoot, boardPath, payload)));
    if (drifted) {
      const handler = boardExternalEditHandler;
      if (handler) {
        // The question is the only notice: the write is retained, not
        // re-fired, until it is answered (see `boardDriftHold`).
        holdBoardDrift(boardPath);
        askAboutDrift(handler, boardPath);
        throw new BoardDriftHeldError(boardPath);
      }
      // No registered handler (boot ordering edge, tests): nothing can ask,
      // so surface the failure and keep the dirty cache; the next write
      // re-checks. Never silently overwrite the external edit.
      const externalEditError = Object.assign(
        new Error(`Board "${boardPath}" was modified externally; write aborted.`),
        { code: 'EXTERNAL_EDIT' },
      );
      notifyWriteError({ kind: 'board', path: boardPath, error: externalEditError });
      throw externalEditError;
    }
  }

  // A board still in an older format on disk: its file is copied to
  // `.filo/recovery/` before this write turns it into the current format (or
  // the write is refused, kept for Retry, when the copy can't be made). Every
  // other write goes on without an extra await.
  if (hasUncopiedOlderFormat(boardPath)) await keepOlderFormatFile(vaultRoot, boardPath);

  // Re-check AFTER the awaits above: the board may have been deleted
  // while they ran, and `board:save` would resurrect it as a ghost
  // board. `deleteBoard` owns the teardown.
  if (isBoardPathDeleting(boardPath)) return;

  // Mark the path BEFORE the IPC fires. The OS watcher event
  // for our own write can reach the renderer before the IPC promise
  // resolves; marking after the await would let `vault:files-changed` see
  // the path as unknown-self-write and route it into the external-edit
  // pipeline. Re-marked on success below to refresh the TTL.
  markRecentSelfWrite(boardPath);
  try {
    if (recreate) await invokeOk('board:save', vaultRoot, boardPath, payload, { recreate: true });
    else await invokeOk('board:save', vaultRoot, boardPath, payload);
    boardsToRecreate.delete(vaultPath(boardPath));
    markRecentSelfWrite(boardPath);
    // Refresh the baseline so subsequent writes compare against the state we
    // just wrote. KEEP the prior baseline on an unusable stat: clearing would
    // disable the next write's drift check. See `refreshBaselineAfterWrite`.
    //
    // Only when this write is still the newest for the path: a superseded write
    // that the OS landed last must not anchor the baseline to its stale bytes,
    // or the next drift check would never warn.
    if (!isLatestWrite || isLatestWrite()) {
      try {
        const postStat = await invokeOk('vault:stat', vaultRoot, boardPath);
        // Stamp only when the post-write size matches the bytes we wrote — a
        // FOREIGN write landing in the save→stat gap would otherwise become
        // Filo's baseline and the next write would clobber it promptless.
        //
        // DELIBERATELY size-only (no content read-back, unlike the markdown
        // gateway / config scheduler): a `.board.json` can be multi-MB and is
        // rewritten every 300 ms during drags. The residual (a same-size
        // foreign write in the ~ms gap) is documented in KNOWN_LIMITATIONS. The
        // watcher's reconcile scan is the backstop: it moves its snapshot past
        // Filo's write only when the file holds the bytes written, so such a
        // write is still reported to the board reconciler.
        if (postStat.size === writtenByteLength(payload)) {
          refreshBaselineAfterWrite(boardPath, postStat.mtimeMs, postStat.size);
        } else {
          refreshBaselineAfterWrite(boardPath, undefined, undefined);
        }
      } catch {
        refreshBaselineAfterWrite(boardPath, undefined, undefined);
      }
    }
  } catch (err) {
    console.error('Failed to save board:', err);
    notifyWriteError({ kind: 'board', path: boardPath, error: err });
    // Re-throw so the scheduler's failure attribution marks this boardPath
    // as failed and keeps the recovery sentinel marked dirty.
    throw err;
  }
}

/** Reports the failure and throws it with a code the scheduler keeps for Retry. */
function throwRetainable(boardPath: string, message: string): never {
  const error = Object.assign(new Error(message), { code: 'EBUSY' });
  notifyWriteError({ kind: 'board', path: boardPath, error });
  throw error;
}

/**
 * For a board no load pinned: true when its file holds nothing Filo would lose
 * by writing `payload` over it, i.e. it still holds what the load read, or it
 * already holds `payload`. Throws a retainable error when the file can't be
 * read to check.
 */
async function diskIsFilosVersion(vaultRoot: string, boardPath: string, payload: string): Promise<boolean> {
  let disk: unknown;
  try {
    const res: unknown = await invokeOk('board:load', vaultRoot, boardPath);
    disk = res !== null && typeof res === 'object' && 'success' in res ? (res as { data?: unknown }).data : res;
  } catch {
    throwRetainable(boardPath, `Couldn't read ${boardPath} to check it before saving.`);
  }
  if (disk == null) return false;
  const loaded = unverifiedLoadedContent(boardPath);
  return (loaded !== undefined && JSON.stringify(disk) === loaded) || JSON.stringify(disk, null, 2) === payload;
}

/**
 * Cancels any pending write for a specific board (e.g., when the board is deleted).
 *
 * Treated as a successful end-of-write for sentinel purposes: the caller has
 * decided the write should not happen (board deleted, board file unlinked), so
 * keeping the path marked dirty would just produce a phantom recovery flag.
 *
 * `boardPath` overrides the schedule-time captured path when the caller has
 * a more authoritative reference (board-delete sites).
 */
export function cancelBoardWrite(boardId: string, boardPath?: string): void {
  boardScheduler.cancel(boardId, boardPath);
}

/**
 * Flushes any pending write for a specific board immediately. Called on
 * tab close so a debounced settings/placement write can't fire after
 * the cache entry has been replaced or under a different active board.
 *
 * Returns `{ ok }` once the write has either completed or been determined
 * to be a no-op. Safe to call when no write is pending — resolves
 * immediately with `ok: true`.
 *
 * `ok` lets callers (tabStore.closeOthers) surface a save
 * failure to the user rather than swallowing it on the close path.
 */
export async function flushBoardWrite(
  boardId: string,
  getWriteArgs: () => BoardWriteArgs | null,
): Promise<{ ok: boolean }> {
  // Pass the caller's getter as an override so the flush observes the
  // CURRENT cache state (which may have been cleared between the
  // original schedule call and this flush — board close mid-debounce,
  // cascade-rename, etc.). Coerce empty vaultRoot / boardPath to null
  // so the primitive routes through its missing-source path and surfaces
  // `ok: false`.
  return boardScheduler.flush(boardId, () => {
    const raw = getWriteArgs();
    if (!raw || !raw.vaultRoot || !raw.boardPath) return null;
    return raw;
  });
}

/**
 * Drains every pending board write timer immediately, awaiting each disk
 * I/O. Returns the last-seen vaultRoot so `flushAll` can carry it through
 * to the defensive sentinel sync at the end, plus the list of board paths
 * whose disk write failed so callers running multi-stage cascades (tag
 * rewrite, in-app folder rename) can surface an aggregated failure toast
 * rather than relying on the silent debounced retry.
 *
 * Delegates to the primitive's `flushAll`, which snapshots
 * pending up-front, awaits in-flight writes via swallow-catched trackers,
 * and aggregates per-key captured failure lists into `failed[]`.
 */
export async function flushAllScheduledBoards(
  _getWriteArgs: (boardId: string) => BoardWriteArgs | null,
): Promise<{ vaultRoot: string | undefined; failed: string[] }> {
  // The cross-key getter argument is ignored — the primitive uses the
  // stored per-key getter from each `scheduleBoardWrite` call (identical
  // shape in production: `() => getBoardWriteArgs(boardId)`).
  const result = await boardScheduler.flushAll();
  return { vaultRoot: result.vaultRoot, failed: result.failed };
}

/**
 * Cancels every queued board write timer without firing them. Called from
 * the vault-swap path so a timer armed against the previous vault can't
 * fire after a new vault opens — its closure would otherwise write to the
 * OLD vaultRoot.
 *
 * Does not adjust the inflight counter because the cancelled timers
 * already counted via their original `beginWrite` at schedule time;
 * `resetWriteTracking` resets the counter as part of the vault-swap
 * sequence.
 */
export function cancelAllPendingBoardWrites(): void {
  boardScheduler.cancelAll();
}

// Vault swap resets the scheduler so a new-vault Ctrl+S won't await an
// old-vault IPC and surface its outcome against the new vault.
registerResetCallback(() => {
  boardScheduler.reset();
  // Deleting-marks and holds must not leak across vaults.
  boardsBeingDeleted.clear();
  heldBoardPaths.clear();
  boardsToRecreate.clear();
});
registerTestResetCallback(() => {
  boardScheduler.reset();
  boardsBeingDeleted.clear();
  heldBoardPaths.clear();
  boardsToRecreate.clear();
});

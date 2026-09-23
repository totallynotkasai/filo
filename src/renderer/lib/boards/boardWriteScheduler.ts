/**
 * boardWriteScheduler — debounced `.board.json` write pipeline.
 *
 * Drives the per-board pending-timer map, the scheduling/flush/cancel
 * surface, and the actual `writeBoardFile` payload-cleanup pass. Every
 * write routes through the shared inflight / sentinel / write-error
 * pipeline (via the `createScheduler` primitive) so failures surface in
 * the same save-state path as config and misc writes.
 *
 * Phase R1 (2026-05-26) — pending + in-flight + failure bookkeeping now
 * live in `createScheduler`. Two board-specific behaviours are preserved
 * by hooking into the primitive:
 *  - **Snapshot at fire time (Phase C/C.5).** The deep clone of the
 *    `cached` board data happens inside `performWrite`, so N keystroke-
 *    rate schedules within a 300 ms window collapse to a single clone.
 *  - **Rename-mid-debounce path bookkeeping (Phase 31 A2.3).** The
 *    `onReschedule` hook drops the old pendingVaultPath and notes the
 *    new one when the same boardId is rescheduled to a different path
 *    (e.g. rename happened between two `scheduleBoardWrite` calls).
 */

import {
  TASK_METADATA_FIELDS_ON_WRITE,
  type V7BoardFileData,
} from './tileDefBuilder';
import { CURRENT_BOARD_FILE_VERSION } from '../../schema/boardFile';
import { BOARD_WRITE_DEBOUNCE_MS, WRITE_TIMEOUT_MS, ENOENT_RESTAT_DELAY_MS, writtenByteLength } from './boardWriteDebounce';
import { getViewportFromCache, setViewport } from './viewportCache';
import {
  notifyWriteError,
  noteAdditionalPendingPath,
  dropPendingPath,
  markRecentSelfWrite,
  registerResetCallback,
  registerTestResetCallback,
} from './writeStateTracking';
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { backupExternalVersion } from '../vault/keepLocalBackup';
// Audit-19 UX-6 — re-exported so boardCache (at its LOC ceiling) reuses an existing import line.
export { backupExternalVersion };
import { createScheduler } from './writeScheduler';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';
import { getBaseline, noteBaseline, hasBaselineDrifted, refreshBaselineAfterWrite } from '../vault/fileBaselineRegistry';

/**
 * Phase R6 — listener slot for the "board file changed externally"
 * notification. Drift detection inside `writeBoardFile` surfaces a toast
 * via this handler before aborting the write. The implementation lives in
 * `stores/vaultExternalChanges` (it needs uiStore); registration happens
 * at module-load via `setBoardExternalEditHandler`.
 *
 * When no handler is registered (test environments, boot before the
 * store layer loads), the writer treats the drift as 'defer' — abort +
 * `notifyWriteError` — so the failure still surfaces through the save
 * indicator and the external edit is never silently overwritten
 * (Audit-17 2.4; the code briefly drifted to a silent 'keep-local').
 * The handler resolves 'reload' / 'keep-local' / 'defer' — see below.
 */
/**
 * 6.4.M4 — `'defer'` was added so the toast's auto-dismiss / manual-close
 * path no longer silently overwrites the external edit. The writer treats
 * `'defer'` like `'reload'` for the abort effect (no write fires), but the
 * handler must NOT have refreshed the in-memory cache — the dirty state
 * persists so the next debounced write re-prompts.
 */
export type BoardExternalEditHandler = (path: string) => Promise<'reload' | 'keep-local' | 'defer'>;
let boardExternalEditHandler: BoardExternalEditHandler | null = null;

/**
 * Audit-17 2.3 — grace delay before the pre-write ENOENT re-stat. Moved to the
 * shared `boardWriteDebounce` leaf in Audit-18 M5 (the config scheduler needs the
 * same delay); re-exported here under the original name so the board scheduler's
 * fake-timer unit test is unchanged. Exported for the test's timer control.
 */
export const BOARD_ENOENT_RESTAT_DELAY_MS = ENOENT_RESTAT_DELAY_MS;

export function setBoardExternalEditHandler(handler: BoardExternalEditHandler | null): void {
  boardExternalEditHandler = handler;
}

/**
 * Audit-18 3.11 — board paths whose `.board.json` is being deleted. `deleteBoard`
 * (boardCache) marks the path here BEFORE the `board:delete` IPC and clears it
 * once any in-flight write has drained. `writeBoardFile` consults it just before
 * `board:save`: a board write that was IN FLIGHT at delete time — most acutely
 * one suspended on the interactive external-edit drift prompt — would otherwise
 * resume AFTER the unlink and RE-CREATE the `.board.json` as a ghost board
 * (cancelBoardWrite only reaches pending/parked timers, never an in-flight write).
 * Bailing before `board:save` is a hard-cancel that doesn't block the delete on
 * the up-to-`writeTimeoutMs` prompt wait. Cleared on vault swap via the scheduler
 * reset below.
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
 * Audit-19 EXT-1 — board paths whose file vanished from disk while the board is
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

/** Audit-19 EXT-1 — true when the board has an unsaved (pending / in-flight / retained) write. */
export function boardHasUnsavedWrite(boardId: string): boolean {
  return boardScheduler.hasWork(boardId);
}

/** Audit-19 EXT-1 — re-fires the board's retained failed write (e.g. after a hold is released). */
export function retryFailedBoardWrite(boardId: string): Promise<{ failed: string[] }> {
  return boardScheduler.retryFailed(boardId);
}

export interface BoardWriteArgs {
  vaultRoot: string;
  boardPath: string;
  cached: V7BoardFileData;
}

/**
 * Per-board scheduler. The primitive owns pending/in-flight/failure
 * tracking; this module supplies the per-write snapshot, the rename-
 * mid-debounce hook, and the missing-source toast copy.
 */
const boardScheduler = createScheduler<BoardWriteArgs>({
  name: 'boardWriteScheduler',
  debounceMs: BOARD_WRITE_DEBOUNCE_MS,
  // Phase C / C.5 — clone at fire time / flushAll capture time, not at
  // schedule time. N keystroke-rate schedules within the debounce window
  // collapse into one serialise/parse; `writeBoardFile`'s in-place
  // mutations (strip content, strip viewport, stamp version) bite the
  // snapshot, not the live proxy. flushAll captures the snapshot
  // synchronously upfront so a mid-flush cache mutation can't leak into
  // a later board's payload (Phase 25 L12).
  //
  // Audit-11 B-INT-L2 — the `JSON.parse(JSON.stringify())` round-trip is the
  // INTENDED normalisation, not an accident: `.board.json` is written via
  // `JSON.stringify`, so the snapshot is coerced to exactly the value space
  // that survives that write — `undefined` fields drop, a `Date` ISO-strings,
  // a `Map`/`Set` would vanish. The board cache only ever holds JSON-safe
  // scalars/arrays/plain-objects (schema-validated on load; task metadata
  // lives in frontmatter, not here), so the round-trip is lossless for real
  // data while guaranteeing the snapshot equals the eventual on-disk bytes.
  // If a future field needs exact structural round-trip (a Date kept as a Date,
  // a Set), switch to `structuredClone` AND teach `writeBoardFile` to serialise
  // it — do not assume this clone preserves non-JSON types.
  snapshotArgs: (args) => ({
    ...args,
    cached: JSON.parse(JSON.stringify(args.cached)) as V7BoardFileData,
  }),
  performWrite: async (args, ctx) => {
    // Audit-14 1.4 — thread the per-fire currency check so a board write whose
    // `board:save` overran `writeTimeoutMs` (and was superseded by a newer write
    // for the same path) skips its post-write drift-baseline stamp on a late
    // landing, instead of anchoring the baseline to its now-stale bytes.
    await writeBoardFile(args.vaultRoot, args.boardPath, args.cached, ctx.isLatestWrite);
  },
  getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: args.boardPath }),
  getFailureId: (args) => args.boardPath,
  onReschedule: (prev, next) => {
    // Phase 31 A2.3 — if the path changed between the previous and current
    // schedule call (rename-mid-debounce), drop the OLD entry from
    // pendingVaultPaths before adding the new one. Without the explicit
    // drop, the rename-mid-debounce path would leak its prior entry into
    // the sentinel forever (endWrite at flush time only touches the new
    // path that getWriteArgs reports).
    if (!next.path) return;
    if (prev.path && prev.path !== next.path) {
      dropPendingPath(prev.vaultRoot ?? next.vaultRoot, prev.path);
    }
    noteAdditionalPendingPath(next.vaultRoot, next.path);
  },
  missingSourceMessage: (key) =>
    `Filo couldn't save the latest changes (boardId: ${key}). Re-open the board and try again.`,
  // Audit-11 WC-1 — `writeBoardFile` awaits an interactive drift prompt
  // (`boardExternalEditHandler`) plus pre-write `vault:stat` + `board:save` IPCs,
  // any of which can wedge (a never-resolving prompt, or a stalled network
  // volume). Bound it so a wedged board write can't hang `flushAll` / quit.
  writeTimeoutMs: WRITE_TIMEOUT_MS,
});

/**
 * Schedules a debounced write for a specific board's .board.json file.
 *
 * Phase C / C.5 — the deep clone is taken at FIRE TIME (inside
 * `performWrite`), not at schedule time. The Nth schedule within a
 * 300 ms debounce window no longer pays an N MB serialise + parse cost;
 * keystrokes / pointermove ticks share the single flush-time snapshot.
 * Path bookkeeping for the sentinel still happens at schedule time so
 * a rename-mid-debounce is detected as it occurs.
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
 * Strips fields that are persisted out-of-band:
 *   - `tileDefs[*].content` — text-tile content lives in `.md`.
 *   - `tileDefs[*]` task metadata — belongs in `.md` YAML frontmatter.
 *   - `mindmap.viewport`    — camera state lives in `.filo/viewports.json`,
 *                             keyed by boardId. A pre-V8 board JSON that
 *                             still carries an inline viewport is silently
 *                             dropped on the next save.
 *
 * NOTE: This function MUTATES `cached` in place — callers must pass an
 * isolated snapshot, never a live store reference. `scheduleBoardWrite`
 * already deep-clones at fire time (Phase C/C.5), so the production
 * pipeline is safe. Phase 31 C2.1 — removed a second redundant clone
 * here to halve the JSON.stringify cost on every save.
 */
export async function writeBoardFile(
  vaultRoot: string,
  boardPath: string,
  cached: V7BoardFileData,
  // Audit-14 1.4 — optional currency check from the scheduler. When this write
  // is no longer the newest fire for `boardPath` (a later write superseded it
  // while this one's IPC overran the timeout), the post-write baseline stamp is
  // SKIPPED so it can't anchor the drift baseline to its stale bytes. Defaults
  // to "latest" for direct (non-scheduler) callers.
  isLatestWrite?: () => boolean,
): Promise<void> {
  // Audit-18 3.11 — the board was deleted while this write was pending/in flight;
  // skip as a clean no-op so we don't re-create the just-unlinked `.board.json`.
  // (Re-checked again right before `board:save` below to cover a write that was
  // suspended on the drift prompt across the delete.)
  if (isBoardPathDeleting(boardPath)) return;
  // Audit-19 EXT-1 — held (missing on disk, re-check pending): fail loudly and
  // let the scheduler retain the write rather than recreate the old path.
  if (isBoardPathHeld(boardPath)) throw new BoardPathHeldError(boardPath);
  const fileData = cached;
  // Stamp the envelope version on every write so files round-trip with a
  // version field even if they were loaded from a legacy (pre-version)
  // shape. Matches `CURRENT_BOARD_FILE_VERSION` in
  // `src/renderer/schema/boardFile.ts`; bump both together when introducing
  // a structural migration.
  fileData.version = CURRENT_BOARD_FILE_VERSION;
  // Strip .content from text tiles and any task-metadata that leaked into the
  // def. Task metadata's source of truth is the backing `.md`'s frontmatter.
  for (const [id, rawDef] of Object.entries(fileData.tileDefs as Record<string, Record<string, unknown>>)) {
    const def = rawDef as Record<string, unknown>;
    let leaked: string[] | null = null;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def)) {
      if (TASK_METADATA_FIELDS_ON_WRITE.has(k)) {
        (leaked ??= []).push(k);
        continue;
      }
      cleaned[k] = v;
    }
    if (leaked) {
      // C12 — demoted to debug. Task metadata leaking into a tile def is
      // expected on every save (the boardCache mirrors frontmatter for
      // reactive reads, then the saver strips it on the way to disk).
      // The warn level was noisy in production logs without being actionable.
      console.debug(`[boardSaver] Stripped task-metadata fields from tile def "${id}" on write:`, leaked);
    }
    if (def.type === 'text') cleaned.content = '';
    (fileData.tileDefs as Record<string, Record<string, unknown>>)[id] = cleaned;
  }
  // Strip any leftover inline mind-map viewport — viewport state now lives
  // exclusively in `.filo/viewports.json` keyed by boardId. Before the
  // strip lands on disk, snapshot the legacy value into the V7 viewports
  // cache so a V6 → V7 migration doesn't silently lose the user's last
  // camera position. We only seed when nothing's there yet (avoid
  // clobbering an already-recorded V7 viewport with a stale legacy one);
  // setViewport stages a debounced write to `.filo/viewports.json` so the
  // restored value persists across the next vault open.
  const board = fileData.board as Record<string, unknown> | undefined;
  if (board && board.type === 'mindmap' && 'viewport' in board) {
    const legacy = (board as { viewport?: unknown }).viewport;
    const boardId = typeof (board as { id?: unknown }).id === 'string'
      ? ((board as { id: string }).id)
      : '';
    if (
      boardId &&
      legacy &&
      typeof legacy === 'object'
    ) {
      const vp = legacy as { x?: unknown; y?: unknown; scale?: unknown };
      if (
        typeof vp.x === 'number' &&
        typeof vp.y === 'number' &&
        typeof vp.scale === 'number' &&
        Number.isFinite(vp.x) &&
        Number.isFinite(vp.y) &&
        Number.isFinite(vp.scale) &&
        // Don't overwrite a freshly-set V7 viewport with a stale legacy one.
        getViewportFromCache(boardId) === null
      ) {
        setViewport(boardId, { x: vp.x, y: vp.y, scale: vp.scale });
      }
    }
    delete (board as { viewport?: unknown }).viewport;
  }

  // Phase R6 — pre-write drift check. If the on-disk mtime no longer
  // matches the baseline captured at load (or after the last successful
  // self-write), an external tool wrote to the .board.json since we last
  // knew about it. Surface a Reload / Keep-local choice; if the user
  // picks Reload we abort the write and let the renderer pick up the
  // disk content on the next refresh. No baseline = no comparison
  // anchor (e.g. a freshly-created board that the loader's stat probe
  // happened to miss), fall through to the unguarded write.
  const baseline = getBaseline(boardPath);
  if (baseline !== undefined) {
    let preWriteStat: { mtimeMs: number; size: number } | undefined;
    try {
      preWriteStat = await invokeOk('vault:stat', vaultRoot, boardPath);
    } catch (err) {
      // Audit 4.5 — ENOENT means the .board.json was deleted on disk (an
      // external tool / sync client removed it) while this debounced write
      // was armed. Falling through to `board:save` would re-create it
      // (ensureDir + atomicWriteFile), resurrecting a file the user/sync
      // intentionally deleted and fighting the sync. Abort as a clean no-op
      // (return, not throw) so the scheduler ends the entry successfully and
      // the recovery sentinel isn't left dirty — the same outcome as
      // `cancelBoardWrite`, which the in-app delete path already triggers.
      // This closes the external-delete-racing-an-armed-write window.
      //
      // Gated on `baseline !== undefined` (this whole block): the file was
      // previously known to exist on disk, so its absence now is a deletion,
      // not a not-yet-created board. A freshly-created board (file already
      // written eagerly by `board:create`, no baseline seeded until its first
      // successful write) has no baseline, skips this block entirely, and is
      // never aborted — so first writes are unaffected.
      if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
        // Audit-17 2.3 — re-stat ONCE before treating the ENOENT as an
        // intentional delete (parity with the config scheduler's Audit-6 L24:
        // its comment claimed this guard "mirrors writeBoardFile", but the
        // re-stat half only ever landed config-side). A sync client / AV can
        // momentarily unlink-then-recreate the .board.json; the bare `return`
        // read that blip as "user deleted it" and resolved the armed write as
        // SUCCESS — silently dropping the debounce window's board mutations
        // (pending path + sentinel cleaned, Ctrl+S reported saved). If the
        // file reappears within the grace delay, fall through to the EXISTING
        // drift check below: a recreate carries a new mtime, so foreign bytes
        // drift → the handler prompts (Reload / Keep-local / defer) — a user
        // decision instead of silent loss. No board `lastWritten` content
        // cache is needed for that. Still missing on the re-stat → genuine
        // delete; keep the current clean-no-op semantics (the watcher's
        // delete pipeline owns it).
        await new Promise((resolve) => setTimeout(resolve, BOARD_ENOENT_RESTAT_DELAY_MS));
        try {
          preWriteStat = await invokeOk('vault:stat', vaultRoot, boardPath);
        } catch (reErr) {
          if (reErr instanceof IpcEnvelopeError && reErr.code === 'ENOENT') {
            return;
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
    if (preWriteStat !== undefined && hasBaselineDrifted(baseline, preWriteStat)) {
      const handler = boardExternalEditHandler;
      // Audit-17 2.4 — no registered handler (boot ordering edge, tests) used
      // to default to 'keep-local', silently overwriting the external edit —
      // contradicting the module docstring's promised notifyWriteError
      // fallback. Default to 'defer' instead: the abort branch below fires
      // notifyWriteError (failure surfaces through the save indicator) and
      // the dirty cache survives, so the next debounced write re-detects the
      // drift and re-prompts once the handler is registered.
      const choice = handler ? await handler(boardPath) : 'defer';
      if (choice === 'reload' || choice === 'defer') {
        // Abort the write. On 'reload', the handler refreshed the
        // renderer's in-memory cache against disk; on 'defer' (6.4.M4)
        // the user dismissed the prompt and neither side was touched.
        // Both cases skip the write and surface failure so the Ctrl+S
        // aggregate honestly reflects "didn't save". The dirty board
        // cache survives on 'defer' so the next debounced write
        // re-detects drift and re-prompts.
        const externalEditError = Object.assign(
          new Error(`Board "${boardPath}" was modified externally; write aborted.`),
          { code: 'EXTERNAL_EDIT' },
        );
        notifyWriteError({ kind: 'board', path: boardPath, error: externalEditError });
        throw externalEditError;
      }
      // 'keep-local' — back up the external version (Audit-19 UX-6), then
      // fall through and overwrite it. A declined un-backed-up overwrite
      // aborts exactly like 'defer'.
      if (!(await backupExternalVersion(vaultRoot, boardPath))) {
        const declined = Object.assign(
          new Error(`Board "${boardPath}" was modified externally; backup failed and overwrite declined.`),
          { code: 'EXTERNAL_EDIT' },
        );
        notifyWriteError({ kind: 'board', path: boardPath, error: declined });
        throw declined;
      }
    }
  }

  // Audit-18 3.11 — re-check AFTER the drift-prompt await above. A write
  // suspended on the interactive external-edit prompt (`boardExternalEditHandler`)
  // can have the board deleted out from under it while it waited; resuming into
  // `board:save` here would resurrect the unlinked file as a ghost board. Bail as
  // a clean no-op — `deleteBoard` owns the teardown.
  if (isBoardPathDeleting(boardPath)) return;

  // Phase A.2a — mark the path BEFORE the IPC fires. The OS watcher event
  // for our own write can reach the renderer before the IPC promise
  // resolves; marking after the await would let `vault:files-changed` see
  // the path as unknown-self-write and route it into the external-edit
  // pipeline. Re-marked on success below to refresh the TTL.
  const payload = JSON.stringify(fileData, null, 2);
  markRecentSelfWrite(boardPath);
  try {
    await invokeOk('board:save', vaultRoot, boardPath, payload);
    markRecentSelfWrite(boardPath);
    // Phase R6 — refresh baseline so subsequent writes compare against
    // the state we just wrote (not the pre-write baseline). Best-effort.
    // Audit-4 DI-14 — KEEP the prior baseline on an unusable stat (reverting
    // 6.4.M2's clear): clearing would disable the next write's drift check and
    // open a silent-overwrite window. See `refreshBaselineAfterWrite`.
    //
    // Audit-14 1.4 — but ONLY when this write is still the newest for the path.
    // A superseded write whose `board:save` overran the scheduler's
    // `writeTimeoutMs` (so a newer write already fired) must not stamp the
    // baseline: if the OS landed this stale write last, stamping here would
    // anchor the baseline to the stale bytes and the next drift check would see
    // "no drift" and never warn. Skipping leaves the baseline stale-vs-disk so
    // the next external/stale state is still detected as drift.
    if (!isLatestWrite || isLatestWrite()) {
      try {
        const postStat = await invokeOk('vault:stat', vaultRoot, boardPath);
        // Audit-17 5.4 — mirror the gateway's Audit-7 L5 written-bytes verify:
        // stamp the baseline only when the post-write stat's size matches the
        // bytes we wrote. The `isLatestWrite` gate above covers only superseded
        // SELF-writes; a FOREIGN write landing in the save→stat gap would
        // otherwise become Filo's own baseline and the next write would
        // match-and-clobber it promptless. On a size mismatch keep the prior
        // baseline (DI-14) so the next write's drift check re-detects + prompts.
        //
        // Audit-18 3.6 — DELIBERATELY size-only here (no content read-back). The
        // markdown gateway (A17-5.3) and the config scheduler (3.6) read the bytes
        // BACK to also catch a SAME-SIZE foreign write in the gap, but a
        // `.board.json` can be multi-MB and is rewritten every 300 ms while a user
        // drags tiles — a full read-back per save would double that IO on the hot
        // path. The residual (a foreign write of the EXACT same byte count landing
        // in the ~ms save→stat gap) is accepted + documented in KNOWN_LIMITATIONS;
        // the watcher's content-hash reconcile remains the backstop for it.
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

/**
 * Cancels any pending write for a specific board (e.g., when the board is deleted).
 *
 * Treated as a successful end-of-write for sentinel purposes: the caller has
 * decided the write should not happen (board deleted, board file unlinked), so
 * keeping the path marked dirty would just produce a phantom recovery flag.
 *
 * `boardPath` overrides the schedule-time captured path when the caller has
 * a more authoritative reference (board-delete sites). Phase 31 A2.2.
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
 * Phase 31 A1.4 — `ok` lets callers (tabStore.closeOthers) surface a save
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
  // `ok: false` (matches legacy `if (!vaultRoot || !boardPath || !args)`).
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
 * rather than relying on the silent debounced retry. Phase 23 M11.
 *
 * Phase R1 — delegates to the primitive's `flushAll`, which snapshots
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

// Phase A.1 — peer schedulers (config / frontmatter / misc / viewport) all
// register a reset callback so vault-swap drains their local in-flight
// and pending state. The board scheduler does the same via the primitive's
// `reset()` so a new-vault Ctrl+S won't await an old-vault IPC and
// surface its outcome against the new vault.
registerResetCallback(() => {
  boardScheduler.reset();
  // Audit-18 3.11 — a deleting-mark must not leak across vaults.
  boardsBeingDeleted.clear();
  heldBoardPaths.clear(); // Audit-19 EXT-1
});
registerTestResetCallback(() => {
  boardScheduler.reset();
  boardsBeingDeleted.clear();
  heldBoardPaths.clear();
});

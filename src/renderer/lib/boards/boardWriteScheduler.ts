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
import { BOARD_WRITE_DEBOUNCE_MS, WRITE_TIMEOUT_MS } from './boardWriteDebounce';
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
import { createScheduler } from './writeScheduler';
import { getBaseline, noteBaseline, hasBaselineDrifted, refreshBaselineAfterWrite } from '../vault/fileBaselineRegistry';

/**
 * Phase R6 — listener slot for the "board file changed externally"
 * notification. Drift detection inside `writeBoardFile` surfaces a toast
 * via this handler before aborting the write. The implementation lives in
 * `stores/vaultExternalChanges` (it needs uiStore); registration happens
 * at module-load via `setBoardExternalEditHandler`.
 *
 * When no handler is registered (test environments, boot before the
 * store layer loads), the writer falls back to `notifyWriteError` so the
 * failure still surfaces through the save indicator. Returning `false`
 * from the handler tells the writer to abort; returning `true` lets the
 * write proceed (the user explicitly chose Keep-local).
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

export function setBoardExternalEditHandler(handler: BoardExternalEditHandler | null): void {
  boardExternalEditHandler = handler;
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
  performWrite: async (args) => {
    await writeBoardFile(args.vaultRoot, args.boardPath, args.cached);
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
): Promise<void> {
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
        return;
      }
      // Any other stat error (EACCES, a transient share hiccup): fall through
      // — the save IPC below surfaces a genuine IO problem through the failure
      // attribution pipeline.
    }
    if (preWriteStat !== undefined && hasBaselineDrifted(baseline, preWriteStat)) {
      const handler = boardExternalEditHandler;
      const choice = handler ? await handler(boardPath) : 'keep-local';
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
      // 'keep-local' — fall through and overwrite the external edit.
    }
  }

  // Phase A.2a — mark the path BEFORE the IPC fires. The OS watcher event
  // for our own write can reach the renderer before the IPC promise
  // resolves; marking after the await would let `vault:files-changed` see
  // the path as unknown-self-write and route it into the external-edit
  // pipeline. Re-marked on success below to refresh the TTL.
  markRecentSelfWrite(boardPath);
  try {
    await invokeOk(
      'board:save',
      vaultRoot,
      boardPath,
      JSON.stringify(fileData, null, 2),
    );
    markRecentSelfWrite(boardPath);
    // Phase R6 — refresh baseline so subsequent writes compare against
    // the state we just wrote (not the pre-write baseline). Best-effort.
    // Audit-4 DI-14 — KEEP the prior baseline on an unusable stat (reverting
    // 6.4.M2's clear): clearing would disable the next write's drift check and
    // open a silent-overwrite window. See `refreshBaselineAfterWrite`.
    try {
      const postStat = await invokeOk('vault:stat', vaultRoot, boardPath);
      refreshBaselineAfterWrite(boardPath, postStat.mtimeMs, postStat.size);
    } catch {
      refreshBaselineAfterWrite(boardPath, undefined, undefined);
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
registerResetCallback(() => boardScheduler.reset());
registerTestResetCallback(() => boardScheduler.reset());

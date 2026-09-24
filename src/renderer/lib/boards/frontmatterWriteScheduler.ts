/**
 * App-wide debounced frontmatter writer.
 *
 * TaskListBoard, KanbanBoard and any undo/redo Command that mutates a
 * `.md` file's frontmatter feed through this scheduler. Hoisting the
 * scheduler out of the per-component closures lets a Command that
 * fires from `historyStore.undo()` schedule its write even when the
 * component that originally scheduled it has unmounted (closing a tab,
 * switching boards). Per-file timers coalesce rapid edits.
 *
 * Write semantics:
 *   - 300ms debounce per relPath.
 *   - At flush time, the FM is pulled from the shared documentStore live
 *     cache so the latest in-memory value wins regardless of which writer
 *     scheduled it.
 *   - `trackComponentWrite` routes IPC failures through the save-error
 *     pipeline (toast + sentinel + saveStateStore).
 *
 * Version token: documentStore tracks a monotonic mutation counter per
 * notePath (`documentStore.getFrontmatterMutationVersion`). Each schedule
 * call captures the counter at schedule time. At flush, the writer
 * checks the recorded `lastFlushedMutationVersion`; if another writer
 * already flushed a version >= the captured one, the flush is a no-op.
 * This stops a stale, fired-but-not-yet-running debounced flush from
 * clobbering a fresher write that landed first.
 *
 * Pending + in-flight + failure bookkeeping live in `createScheduler`. The
 * cross-vault finalizer guard is supplied
 * by the primitive's `trackerIsCurrent` check (skipped automatically
 * when `reset()` clears the in-flight map during vault swap).
 */

import {
  writeMarkdownFile,
  isHydrated,
  readMarkdownForHydrate,
} from '../vault/markdownFileWriter';
import { documentStore } from '../../stores/document.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { createScheduler } from './writeScheduler';
import { WRITE_TIMEOUT_MS } from './boardWriteDebounce';
import {
  markPathFailed,
  registerResetCallback,
  registerTestResetCallback,
} from './writeStateTracking';
import {
  type FrontmatterDelta,
  mergeFrontmatterDelta,
} from '../vault/frontmatterDelta';
import { reportError } from '../utils/errorBus';
import { registerPathRenamable } from '../vault/renamePathKeys';
import { vaultPath, type VaultPath } from '@shared/vaultPath';

/**
 * Per-relPath idle-debounce window for frontmatter writes.
 *
 * Matches `boardSaver.BOARD_WRITE_DEBOUNCE_MS` (300ms) on purpose: a single
 * user action (e.g. toggling a task's `completed` field) typically schedules
 * both a frontmatter write and a board JSON write. Aligning the debounce
 * windows lets the two writes flush together so a board JSON snapshot can't
 * land on disk reflecting a frontmatter state that the FM writer hasn't
 * persisted yet (or vice-versa).
 */
export const FM_DEBOUNCE_MS = 300;

interface FrontmatterWriteArgs {
  relPath: string;
  notePath: string | null;
  scheduledVersion: number;
  vaultRoot: string;
}

/**
 * `note path -> highest mutation version successfully flushed to disk so far`.
 * The version-token guard reads from this map at flush time; concurrent
 * schedules that captured an older mutation version short-circuit instead
 * of overwriting newer content.
 *
 * Keyed by the same case-folded path as the document store's counters, and
 * moved by the same rename (`renameFlushedVersionPath`): a mark left at the
 * old path would suppress the writes of a new note created there, and one
 * missing at the new path would let a stale write through. Cleared on vault
 * swap (see `resetFrontmatterScheduler`).
 */
// allow-module-state: reset via resetFrontmatterScheduler called from boardSaver's pre-swap handler
const lastFlushedVersion = new Map<VaultPath, number>();

/**
 * Moves the flushed-version marks with a renamed note (and every note under a
 * renamed folder). If the new path already has a mark, the higher one wins, as
 * in the document store, so the pair never goes backwards.
 */
function renameFlushedVersionPath(oldRel: string, newRel: string): void {
  const oldKey = vaultPath(oldRel);
  const newKey = vaultPath(newRel);
  if (!oldKey || !newKey || oldKey === newKey) return;
  const oldPrefix = `${oldKey}/`;
  const moves: Array<[VaultPath, VaultPath]> = [];
  for (const key of lastFlushedVersion.keys()) {
    if (key === oldKey) moves.push([key, newKey]);
    else if (key.startsWith(oldPrefix)) moves.push([key, vaultPath(newKey + key.slice(oldKey.length))]);
  }
  for (const [from, to] of moves) {
    const version = lastFlushedVersion.get(from) ?? 0;
    lastFlushedVersion.delete(from);
    lastFlushedVersion.set(to, Math.max(version, lastFlushedVersion.get(to) ?? 0));
  }
}

registerPathRenamable('frontmatterWriteScheduler.lastFlushedVersion', renameFlushedVersionPath);

/**
 * Per-relPath accumulated field delta, keyed by the SAME relPath the scheduler
 * coalesces on. Deltas are folded together (`mergeFrontmatterDelta`) so several
 * debounced edits collapse into one write that applies them ALL to fresh disk.
 * Peeked (not removed) at fire time and dropped only on a successful write, so a
 * failed write leaves the delta queued for the retry / quit-flush. Callers with
 * no delta (e.g. a notes body write) leave this empty and use the cache-FM path.
 */
// allow-module-state: reset via resetFrontmatterScheduler called from boardSaver's pre-swap handler
const pendingDeltas = new Map<string, FrontmatterDelta>();

function accumulateDelta(relPath: string, delta: FrontmatterDelta): void {
  const existing = pendingDeltas.get(relPath);
  pendingDeltas.set(relPath, existing ? mergeFrontmatterDelta(existing, delta) : delta);
}

/**
 * Transfers a pending delta when its backing file is renamed mid-debounce
 * (exact file rename + descendant-of-renamed-folder), mirroring the gateway's
 * `renameFileStatePath`. Registered with `renameAllPathKeys` so the cascade
 * can't leave the delta keyed to the old path (it would never flush, dropping
 * the edit). The old delta applies first if the new path already has one.
 */
function renameDeltaPath(oldRel: string, newRel: string): void {
  if (!oldRel || !newRel || oldRel === newRel) return;
  const exact = pendingDeltas.get(oldRel);
  if (exact !== undefined) {
    pendingDeltas.delete(oldRel);
    const existingNew = pendingDeltas.get(newRel);
    pendingDeltas.set(newRel, existingNew ? mergeFrontmatterDelta(exact, existingNew) : exact);
  }
  const oldChildPrefix = oldRel + '/';
  const newChildPrefix = newRel + '/';
  const transfers: Array<[string, FrontmatterDelta]> = [];
  for (const [key, value] of pendingDeltas) {
    if (key.startsWith(oldChildPrefix)) {
      transfers.push([newChildPrefix + key.slice(oldChildPrefix.length), value]);
      pendingDeltas.delete(key);
    }
  }
  for (const [k, v] of transfers) pendingDeltas.set(k, v);
}

registerPathRenamable('frontmatterWriteScheduler.pendingDeltas', renameDeltaPath);

const frontmatterScheduler = createScheduler<FrontmatterWriteArgs>({
  name: 'frontmatterWriteScheduler',
  debounceMs: FM_DEBOUNCE_MS,
  performWrite: (args) => writeFrontmatter(args),
  getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: args.relPath }),
  getFailureId: (args) => args.relPath,
  // `writeFrontmatter` awaits the SAME `writeMarkdownFile` the
  // gateway does (its interactive drift prompt + `vault:write-existing-file-text`
  // IPC), so a wedged write here would hang `flushAllPendingFrontmatterWrites` →
  // `save()` → quit forever. Bound it like the gateway.
  writeTimeoutMs: WRITE_TIMEOUT_MS,
});

/**
 * Schedules a debounced frontmatter write for `relPath`. The optional
 * `notePath` is forwarded to `writeFrontmatter` so the writer can pull the
 * canonical FM from the documentStore live cache.
 *
 * Every newly armed timer calls `beginWrite` so the
 * recovery sentinel reflects the in-debounce period (not just the disk
 * I/O window). The matching `endWrite` lives inside `writeFrontmatter`'s
 * trackComponentWrite wrapper, which already accounts for success/failure
 * via the same inflight/failed maps the rest of the pipeline uses.
 */
export function scheduleFrontmatterWrite(
  relPath: string,
  notePath: string | null,
  delta?: FrontmatterDelta,
): void {
  // Accumulate the explicit field delta so the eventual write applies it to
  // FRESH disk (untouched keys, incl. external additions, preserved by
  // construction). A caller that passes no delta (body-only notes writes) keeps
  // the cache-FM write path in `writeFrontmatter` below.
  if (delta) accumulateDelta(relPath, delta);
  frontmatterScheduler.schedule(relPath, () => {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return null;
    const scheduledVersion = notePath ? documentStore.getFrontmatterMutationVersion(notePath) : 0;
    return { relPath, notePath, scheduledVersion, vaultRoot };
  });
}

/**
 * Drains every pending write immediately. Used by the global flush
 * (vault close, app quit, Ctrl+S → vaultStore.save) and by component
 * unmount paths.
 *
 * Returns `{ failed }` (paths whose flush rejected) so the Ctrl+S
 * aggregate can refuse to report "Saved" when one slipped.
 */
export async function flushAllPendingFrontmatterWrites(): Promise<{ failed: string[] }> {
  const result = await frontmatterScheduler.flushAll();
  return { failed: result.failed };
}

/**
 * Drains ONLY `relPath`'s pending/in-flight frontmatter write, not the whole
 * vault. The field-command pre-flush (`UpdateTaskFieldCommand` execute / undo)
 * only needs its OWN path drained; flushing globally would make a bulk field op
 * O(N²) in serial write+flush round-trips. Awaits the same pending + parked +
 * in-flight drain as `flushAll`, scoped to one key.
 */
export async function flushFrontmatterWriteForPath(relPath: string): Promise<void> {
  await frontmatterScheduler.flush(relPath);
}

async function writeFrontmatter(args: FrontmatterWriteArgs): Promise<void> {
  const { relPath, vaultRoot } = args;
  let { notePath, scheduledVersion } = args;
  if (!vaultRoot) return;

  // A cache-less (orphan) write can be scheduled for a relPath that ALSO has
  // an open editor: the scheduler coalesces by relPath, so a null schedule
  // overwrites a cache-backed one. With notePath null the version guard below
  // is inert (scheduledVersion 0) and the FM source falls back to the
  // body-stripped, possibly-stale vaultIndex copy — clobbering the editor's
  // live frontmatter. Use the open editor's document so the FM source, version
  // guard, and body all read from the live document cache instead.
  if (!notePath) {
    const openNotePath = documentStore.findByFilename(relPath)?.filename ?? null;
    if (openNotePath) {
      notePath = openNotePath;
      scheduledVersion = documentStore.getFrontmatterMutationVersion(openNotePath);
    }
  }

  // Peek the accumulated field delta for this path (dropped only after a
  // successful write below). Its presence routes the write through the
  // gateway's delta path (apply ONLY these keys to FRESH disk), so the three
  // guards below — the stale-version short-circuit, the cache-FM source, and
  // the `!fm` abort — apply to the cache path only: a delta write reads disk
  // itself, so skipping it for a stale cache version would strand the edit.
  const delta = pendingDeltas.get(relPath);

  // Version-token guard: refuse to overwrite if a newer write has already
  // landed on disk. The shared documentStore FM cache keeps every writer
  // in sync at the in-memory layer, so the "winner" already incorporated
  // our merged patch — re-writing here would just resurrect older body
  // content from `documentStore.body` (which may itself be stale relative
  // to the editor's latest keystrokes).
  //
  // Keyed by note path. A null notePath (e.g. a frontmatter-only sync with no
  // open editor) carries `scheduledVersion === 0`, so the guard is inert.
  //
  // The token also covers BODY mutations (`documentStore.updateContent` bumps
  // the same counter); otherwise a delta-less notes write scheduled after a
  // flushed version would be mistaken for stale and silently skipped as
  // success, losing the note on quit.
  const last = notePath ? (lastFlushedVersion.get(vaultPath(notePath)) ?? 0) : 0;
  if (!delta && scheduledVersion > 0 && scheduledVersion <= last) return;

  // Read-only docs (lossy tiptap round-trip detected at editor load). The flag
  // protects the BODY — the FM block round-trips cleanly even when the body
  // doesn't — so:
  //  - A DELTA write proceeds: the gateway applies only the changed FM keys
  //    to a fresh disk read, and the body is sourced from DISK below (never
  //    `docState.body`, which holds the lossy round-tripped text). A bare
  //    return here would silently drop the field edit as a "success".
  //  - A delta-less (body) write still refuses — writing the lossy
  //    body would corrupt the file — but LOUDLY: toast + markPathFailed (the
  //    sentinel + indicator surface the unsaved edit) + throw (attributes
  //    relPath to flushAll().failed so save() returns false).
  const readOnlyDoc = notePath ? documentStore.isReadOnly(notePath) : false;
  if (readOnlyDoc && !delta) {
    reportError(
      'frontmatter.readOnly',
      null,
      `Couldn't save "${relPath}" — it's open read-only because its Markdown can't round-trip safely. Use "Take ownership" in the editor to enable saves.`,
    );
    markPathFailed(vaultRoot, relPath);
    throw new Error(
      `frontmatterWriteScheduler: refusing body write to read-only doc "${relPath}" — take ownership to enable saves`,
    );
  }

  const fm = notePath
    ? documentStore.getFrontmatter(notePath)
    : vaultIndexStore.getMetadata(relPath)?.frontmatter;
  // Cache path only — a delta write sources its FM from a fresh in-chain
  // disk read in the gateway, so a missing cache FM must NOT abort it. The bare
  // `!fm` abort stays guarded by `!delta`; the no-editor disk-read failure below
  // still markPathFailed + throws (the loud surface the CI gate requires).
  if (!delta && !fm) return;

  // Body resolution must not silently clobber disk truth, and must not silently
  // DROP a field edit when no editor is open. A Kanban card / Task row often has
  // a notePath (FM cache keyed) but no live docState (never opened as a Document
  // tab) — returning early there would resolve as SUCCESS, clear `.filo/.dirty`,
  // and lose the edit on relaunch. So both "no notePath" and "notePath but no live
  // docState" resolve the body the SAME way — a fresh disk read:
  // (a) docState present → use the editor's live body (the only place edits
  //     we'd lose by reading disk could live).
  // (b) otherwise → hydrate fresh from disk for the canonical body; never
  //     trust `vaultIndex.content`, which is body-stripped AND can be hours
  //     stale. A throw (ENOENT/EACCES) surfaces the loss via markPathFailed
  //     instead of resurrecting a deleted file or swallowing the edit.
  let body: string;
  // A read-only doc's live `docState.body` is the LOSSY tiptap
  // round-trip (the very reason the flag exists), so a delta write must never
  // re-emit it; forcing the no-docState branch sources the body from a fresh
  // disk read instead, preserving the on-disk bytes the editor can't.
  const docState = notePath && !readOnlyDoc ? documentStore.getDocument(notePath) : undefined;
  if (docState) {
    body = docState.body;
    // Hydrate-if-needed so the gateway has the BOM + drift baseline.
    if (!isHydrated(relPath)) {
      try {
        await readMarkdownForHydrate(vaultRoot, relPath);
      } catch (err) {
        // A hydrate read failure (EACCES/EBUSY from AV / OneDrive, a share
        // hiccup) must not write anyway against a file we never read (BOM
        // stripped, CRLF flipped, drift gate blind). Fail LOUDLY — same contract
        // as the no-docState branch below: `markPathFailed` surfaces the loss,
        // and the `throw` makes `save()` return false. The edit stays queued
        // for a retry once the file is readable.
        markPathFailed(vaultRoot, relPath);
        throw err;
      }
    }
  } else {
    // Fresh disk read serves three roles in one IPC: hydrate (BOM +
    // drift baseline), pull the canonical body, and ENOENT-fail if
    // the file is gone. A throw here aborts the write so we don't
    // resurrect a deleted file from the index's stale snapshot.
    try {
      const hydrate = await readMarkdownForHydrate(vaultRoot, relPath);
      body = hydrate.body;
    } catch (err) {
      // The backing `.md` is gone (ENOENT) or unreadable, so this write can't
      // land. The board cache still shows the edit, so it must not be dropped
      // silently: `markPathFailed` surfaces the loss in the save indicator +
      // `.filo/.dirty` sentinel, and the `throw` makes `save()` return false.
      // We still refuse to resurrect the deleted file.
      markPathFailed(vaultRoot, relPath);
      throw err;
    }
  }

  try {
    await writeMarkdownFile({
      vaultRoot,
      relPath,
      // Delta path: the gateway ignores this and reads fresh disk; `fm ?? {}`
      // is only the fallback (delta undefined). Cache path: the cache FM.
      frontmatter: fm ?? {},
      body,
      callerId: `frontmatter-scheduler:${relPath}`,
      notePath,
      frontmatterDelta: delta,
      // The version this write's content corresponds to (fire time, when the
      // body/FM were read), so the gateway's flushed-version bump can't mark a
      // mid-IPC mutation as flushed.
      mutationVersionAtCapture: notePath ? scheduledVersion : undefined,
      // Fire-time body-source decision: `body` came from the live docState
      // exactly when one resolved (a read-only doc reads as NOT live). The
      // gateway must not re-derive this at write time — a doc unload during the
      // per-path chain wait would discard the live body.
      bodyIsLive: docState !== undefined,
    });
    // The delta landed on disk; drop it from the accumulator, UNLESS a
    // newer edit folded in since we peeked (ref-identity: a fresh schedule
    // replaced the entry with a new merged object). On a write FAILURE the catch
    // below rethrows WITHOUT clearing, so the retry / quit-flush re-applies the
    // user's change instead of silently losing it. Leaving a superseded entry is
    // also safe — re-applying delta keys to disk that already holds them is
    // idempotent — but clearing the consumed one bounds the map's growth.
    if (delta && pendingDeltas.get(relPath) === delta) pendingDeltas.delete(relPath);
    // Record the highest version this writer flushed so concurrent stale
    // flushes know not to clobber. The gateway also bumps this map on
    // success (via the threaded `mutationVersionAtCapture`); both bump to
    // the same value so this is belt-and-braces. Only notePath-backed writes have
    // a version to track.
    //
    // Record the FIRE-time `scheduledVersion`, NOT the post-IPC current
    // version: a mutation landing during the write await would otherwise be
    // marked flushed, and its follow-up write would skip — never reaching disk.
    if (notePath) {
      lastFlushedVersion.set(vaultPath(notePath), Math.max(last, scheduledVersion));
    }
  } catch (err) {
    console.error('[frontmatterWriteScheduler] Failed to write frontmatter:', err);
    // Distinguish "file deleted externally" from other
    // failures. ENOENT-shaped errors mean the backing file is gone, which
    // the trackComponentWrite + errorBus pipeline already surfaces, but a
    // dedicated toast helps the user understand WHY the frontmatter write
    // failed (vs. a permission issue).
    const errAny = err as { code?: string; channel?: string };
    if (errAny?.code === 'ENOENT') {
      // Best-effort UI signal — the renderer already routed a toast via
      // notifyWriteError above. The component layer (TextTile / Doc /
      // Properties / TaskList) is responsible for deciding whether to
      // recreate the file or prompt the user.
      console.warn(`[frontmatterWriteScheduler] Backing file gone: ${relPath}`);
    }
    // Rethrow so the primitive's failure attribution lands `relPath` in
    // the flushAll result.
    throw err;
  }
}

/**
 * Returns the highest mutation-version that has been successfully flushed
 * to disk for `notePath`. Body writers (TextTile) consult this so a stale
 * in-memory frontmatter cache can't quietly clobber a fresher version that
 * landed on disk via a cross-board frontmatter flush in the interval
 * between the body writer's last fm-read and its IPC write.
 *
 * Returns `0` for docs that have never flushed (i.e. the cache is the
 * only source of truth, so no re-read is needed).
 *
 * Keyed by the note's path, in the same version space as
 * `documentStore.getFrontmatterMutationVersion(notePath)`.
 */
export function getLastFlushedFrontmatterVersion(notePath: string): number {
  return lastFlushedVersion.get(vaultPath(notePath)) ?? 0;
}

/**
 * Bumps the recorded "highest mutation-version flushed to disk for notePath"
 * to `version` (only if higher than what's recorded). Exposed for the
 * markdown-file-writer gateway so writes routed through it (TextTile body
 * writes, DocumentEditor saves, PropertiesPopup edits, orphan-fm sites) all
 * keep the version map authoritative without each call site reaching into
 * the scheduler's internals.
 *
 * No-op when `version <= 0` or `version <= current`.
 *
 * Callers without a note path (cache-less writes) have no version to track
 * and simply don't call this.
 */
export function noteFrontmatterFlushedVersion(notePath: string, version: number): void {
  if (!notePath || version <= 0) return;
  const key = vaultPath(notePath);
  const current = lastFlushedVersion.get(key) ?? 0;
  if (version <= current) return;
  lastFlushedVersion.set(key, version);
}

/**
 * Drops a path's accumulated field delta AND cancels its still-armed scheduler
 * timer.
 *
 * `pendingDeltas` is keyed independently of the scheduler's timer, so
 * cancelling the timer alone would leave the delta queued and a later flush /
 * schedule would re-apply the DISCARDED edit — reverting the external edit the
 * user chose to keep via "Reload". The scheduler's `cancel` still emits a
 * balanced `endWrite(success=true)` so the recovery sentinel doesn't strand a
 * phantom dirty entry for `relPath`.
 */
export function dropPendingDelta(relPath: string): void {
  pendingDeltas.delete(relPath);
  frontmatterScheduler.cancel(relPath);
}

/**
 * Cancels a single path's pending frontmatter write without firing it, and
 * drops any accumulated field delta so it can't be resurrected by a later
 * flush. The primitive's `cancel` emits a balanced `endWrite(success=true)` so
 * the recovery sentinel doesn't strand a phantom dirty entry for `relPath`.
 *
 * The external-change reconciler calls this from the
 * "Reload" branch of its pending-write conflict prompt: once the user opts
 * to take the disk version, the still-armed local frontmatter write must be
 * cancelled or it would fire moments later and clobber the just-reloaded
 * external frontmatter.
 */
export function cancelFrontmatterWrite(relPath: string): void {
  dropPendingDelta(relPath);
}

/**
 * Drops every pending timer and clears the per-note version map.
 *
 * Clearing `lastFlushedVersion` on vault swap bounds the map's growth and
 * drops any path that could be reused across vaults.
 *
 * Registered as both a production reset (vault swap) and a test reset.
 */
export function resetFrontmatterScheduler(): void {
  frontmatterScheduler.reset();
  lastFlushedVersion.clear();
  // Drop any accumulated deltas so an outgoing vault's pending field
  // edit can't apply to a same-named file in the incoming vault.
  pendingDeltas.clear();
}

// Self-register cleanup so vault swap and test reset don't leak between vaults.
registerResetCallback(resetFrontmatterScheduler);
registerTestResetCallback(resetFrontmatterScheduler);

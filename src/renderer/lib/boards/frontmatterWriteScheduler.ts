/**
 * App-wide debounced frontmatter writer.
 *
 * TaskListBoard, KanbanBoard and any undo/redo Command that mutates a
 * `.md` file's frontmatter feed through this scheduler. Hoisting the
 * scheduler out of the per-component closures lets a Command that
 * fires from `historyStore.undo()` schedule its write even when the
 * component that originally scheduled it has unmounted (closing a tab,
 * switching boards). Per-file timers coalesce rapid edits the same way
 * the previous per-component scheduler did.
 *
 * Write semantics mirror the original component-local implementation:
 *   - 300ms debounce per relPath.
 *   - At flush time, the FM is pulled from the shared documentStore live
 *     cache so the latest in-memory value wins regardless of which writer
 *     scheduled it.
 *   - `trackComponentWrite` routes IPC failures through the save-error
 *     pipeline (toast + sentinel + saveStateStore).
 *
 * Version token: documentStore tracks a monotonic mutation counter per
 * docId (`documentStore.getFrontmatterMutationVersion`). Each schedule
 * call captures the counter at schedule time. At flush, the writer
 * checks the recorded `lastFlushedMutationVersion`; if another writer
 * already flushed a version >= the captured one, the flush is a no-op.
 * This stops a stale, fired-but-not-yet-running debounced flush from
 * clobbering a fresher write that landed first (the DocumentEditor
 * race called out in the audit's C3 finding).
 *
 * Phase R1 (2026-05-26) — pending + in-flight + failure bookkeeping now
 * live in `createScheduler`. The cross-vault finalizer guard is supplied
 * by the primitive's `trackerIsCurrent` check (skipped automatically
 * when `reset()` clears the in-flight map during vault swap).
 */

import {
  writeMarkdownFile,
  markHydrated,
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
import { registerPathRenamable } from '../vault/renamePathKeys';

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
  docId: string | null;
  scheduledVersion: number;
  vaultRoot: string;
}

/**
 * `docId -> highest mutation version successfully flushed to disk so far`.
 * The version-token guard reads from this map at flush time; concurrent
 * schedules that captured an older mutation version short-circuit instead
 * of overwriting newer content.
 *
 * M1 (2026-05-28) — keyed by `docId` (stable identity), NOT `relPath`. The
 * mutation versions themselves come from `documentStore.getFrontmatter-
 * MutationVersion(docId)`, which is a per-docId counter; comparing a docId's
 * scheduled version against a relPath-keyed last-flushed only stays coherent
 * while the docId↔relPath mapping is 1:1. During a rename two docs can
 * transiently alias one relPath — the relPath-keyed guard then let docA's
 * higher version suppress docB's lower-versioned (but newer-for-docB) write,
 * silently dropping the edit. Keying by docId gives each document its own
 * version space so neither can suppress the other.
 *
 * Sprint 35.4 — still cleared on vault swap (see `resetFrontmatterScheduler`).
 * docId keying already prevents the original cross-vault same-`relPath`
 * suppression, but the reset also bounds the map's growth and drops any
 * docIds that could be reused across vaults.
 */
// allow-module-state: reset via resetFrontmatterScheduler called from boardSaver's pre-swap handler
const lastFlushedVersion = new Map<string, number>();

/**
 * WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 — per-relPath accumulated field
 * delta, keyed by the SAME relPath the scheduler coalesces on. Each field edit's
 * delta is folded in (`mergeFrontmatterDelta`) so several debounced edits to one
 * file collapse into a single write that applies them ALL to fresh disk. Peeked
 * (not removed) at fire time and dropped only on a successful write, so a failed
 * write leaves the delta queued for the retry / quit-flush — never silently
 * dropping the user's change. Legacy callers (`scheduleFrontmatterWrite` with no
 * delta — e.g. a notes body write) leave this empty and keep the cache-FM path.
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
  // Audit-11 WC-1 — `writeFrontmatter` awaits the SAME `writeMarkdownFile` the
  // gateway does (its interactive drift prompt + `vault:write-existing-file-text`
  // IPC), so a wedged write here would hang `flushAllPendingFrontmatterWrites` →
  // `save()` → quit forever. Bound it like the gateway.
  writeTimeoutMs: WRITE_TIMEOUT_MS,
});

/**
 * Schedules a debounced frontmatter write for `relPath`. The optional
 * `docId` is forwarded to `writeFrontmatter` so the writer can pull the
 * canonical FM from the documentStore live cache.
 *
 * Phase 31 A1.3 — every newly armed timer calls `beginWrite` so the
 * recovery sentinel reflects the in-debounce period (not just the disk
 * I/O window). The matching `endWrite` lives inside `writeFrontmatter`'s
 * trackComponentWrite wrapper, which already accounts for success/failure
 * via the same inflight/failed maps the rest of the pipeline uses.
 */
export function scheduleFrontmatterWrite(
  relPath: string,
  docId: string | null,
  delta?: FrontmatterDelta,
): void {
  // Phase 4 — accumulate the explicit field delta so the eventual write applies
  // it to FRESH disk (untouched keys, incl. external additions, preserved by
  // construction). Several rapid edits to one file coalesce by relPath here AND
  // in the scheduler, so their deltas fold together into one write. A caller
  // that passes no delta (legacy / body-only notes writes) keeps the cache-FM
  // write path in `writeFrontmatter` below.
  if (delta) accumulateDelta(relPath, delta);
  frontmatterScheduler.schedule(relPath, () => {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return null;
    const scheduledVersion = docId ? documentStore.getFrontmatterMutationVersion(docId) : 0;
    return { relPath, docId, scheduledVersion, vaultRoot };
  });
}

/**
 * Drains every pending write immediately. Used by the global flush
 * (vault close, app quit, Ctrl+S → vaultStore.save) and by component
 * unmount paths.
 *
 * Returns `{ failed }` (paths whose flush rejected) so the Ctrl+S
 * aggregate can refuse to report "Saved" when one slipped.
 *
 * Phase R1 — delegates to the primitive's `flushAll`, which snapshots
 * pending up-front, awaits in-flight writes, and attributes
 * captured-failure lists via the entry-side `capturedFailures` field.
 */
export async function flushAllPendingFrontmatterWrites(): Promise<{ failed: string[] }> {
  const result = await frontmatterScheduler.flushAll();
  return { failed: result.failed };
}

async function writeFrontmatter(args: FrontmatterWriteArgs): Promise<void> {
  const { relPath, vaultRoot } = args;
  let { docId, scheduledVersion } = args;
  if (!vaultRoot) return;

  // 6.4.L2 — a docId-null (orphan) write can be scheduled for a relPath that
  // ALSO has an open editor: the scheduler coalesces by relPath, so a null
  // schedule overwrites a docId-backed one. With docId null the version guard
  // below is inert (scheduledVersion 0) and the FM source falls back to the
  // body-stripped, possibly-stale vaultIndex copy — clobbering the editor's
  // live frontmatter. Adopt the open editor's docId so the FM source, version
  // guard, and body all read from the live document cache instead.
  if (!docId) {
    const openDocId = documentStore.findByFilename(relPath)?.docId ?? null;
    if (openDocId) {
      docId = openDocId;
      scheduledVersion = documentStore.getFrontmatterMutationVersion(openDocId);
    }
  }

  // Phase 27 / A4 — refuse to write read-only docs. The lossy round-trip
  // detection at load time set the flag because tiptap-markdown couldn't
  // preserve the body's syntax — a debounced write here would strip what
  // it couldn't parse and silently corrupt the user's file. The accumulated
  // delta (if any) is deliberately LEFT in place so a later takeOwnership +
  // re-schedule still applies the user's field change.
  if (docId && documentStore.isReadOnly(docId)) return;

  // Phase 4 — peek the accumulated field delta for this path (dropped only after
  // a successful write below). Its presence routes the write through the
  // gateway's delta path (apply ONLY these keys to FRESH disk), so the three
  // legacy guards below — the stale-version short-circuit, the cache-FM source,
  // and the `!fm` abort — are all LEGACY-cache-path-only: a delta write is
  // authoritative (it reads disk itself), so skipping it for a stale cache
  // version would strand the user's edit unwritten, and it needs no cache FM.
  const delta = pendingDeltas.get(relPath);

  // Version-token guard: refuse to overwrite if a newer write has already
  // landed on disk. The shared documentStore FM cache keeps every writer
  // in sync at the in-memory layer, so the "winner" already incorporated
  // our merged patch — re-writing here would just resurrect older body
  // content from `documentStore.body` (which may itself be stale relative
  // to the editor's latest keystrokes).
  //
  // M1 — keyed by docId. A null docId (e.g. a frontmatter-only sync with no
  // open editor) carries `scheduledVersion === 0`, so the guard below is
  // inert and the write always proceeds — there is no docId to track.
  const last = docId ? (lastFlushedVersion.get(docId) ?? 0) : 0;
  if (!delta && scheduledVersion > 0 && scheduledVersion <= last) return;

  const fm = docId
    ? documentStore.getFrontmatter(docId)
    : vaultIndexStore.getMetadata(relPath)?.frontmatter;
  // Legacy cache path only — a delta write sources its FM from a fresh in-chain
  // disk read in the gateway, so a missing cache FM must NOT abort it. The bare
  // `!fm` abort stays guarded by `!delta`; the no-editor disk-read failure below
  // still markPathFailed + throws (the loud surface the CI gate requires).
  if (!delta && !fm) return;

  // 6.2.H5 / Audit-8 B1 — body resolution must not silently clobber disk
  // truth, and must not silently DROP a field edit when no editor is open.
  //
  // Pre-6.2.H5: `body = docState?.body ?? vaultIndex.content ?? ''`. If
  // docState was undefined at fire time the chain fell through to the index's
  // possibly-hours-stale `content` — or `''` when the index had no entry —
  // and the write committed those bytes back to disk.
  //
  // 6.2.H5 over-corrected with `if (!docState) return` for a docId-backed
  // write. That silently dropped the COMMON case (Audit-8 B1): a Kanban card /
  // Task row whose backing doc has a docId — so the FM cache is keyed and the
  // field patch was merged into it — but was never opened as a Document tab,
  // so `openDocuments` holds no docState. The bare return resolved performWrite
  // as SUCCESS → endWrite(true) → markClean cleared `.filo/.dirty`, and the
  // `.md` was never written, so a toggled `completed` / set `priority` / picked
  // `dueDate` reverted on the next launch with no error and no recovery
  // sentinel.
  //
  // Both "no docId" (orphan FM write) and "docId but no live docState" now
  // resolve the body the SAME way — a fresh disk read:
  // (a) docState present → use the editor's live body (the only place edits
  //     we'd lose by reading disk could live).
  // (b) otherwise → hydrate fresh from disk for the canonical body; never
  //     trust `vaultIndex.content`, which is body-stripped AND can be hours
  //     stale. A throw (ENOENT/EACCES) surfaces the loss via markPathFailed
  //     instead of resurrecting a deleted file or swallowing the edit.
  let body: string;
  const docState = docId ? documentStore.getDocument(docId) : undefined;
  if (docState) {
    body = docState.body;
    // Hydrate-if-needed so the gateway has the BOM + drift baseline.
    if (!isHydrated(relPath)) {
      try {
        await readMarkdownForHydrate(vaultRoot, relPath);
      } catch {
        markHydrated(relPath, false);
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
      // Audit-4 DI-13 / Audit5 2.3 (#7) / Audit-8 B1 — the backing `.md` is
      // gone (ENOENT, deleted out-of-band) or unreadable, so this frontmatter
      // write (an orphan card OR an un-opened Kanban/Task field edit) can't
      // land. The board cache still shows the edit, so dropping it here would
      // lose it silently. `markPathFailed` surfaces the loss in the save
      // indicator + `.filo/.dirty` sentinel; the `throw` propagates it so the
      // scheduler attributes `relPath` to `flushAll().failed` → `save()`
      // returns false. Pre-2.3 a bare `return` resolved performWrite as
      // SUCCESS, so the scheduler's settle `endWrite(true)` then wiped the
      // failed mark AND Ctrl+S toasted a false "Saved" while the edit never
      // reached disk. We still refuse to resurrect the deleted file — we just
      // stop swallowing the drop.
      markPathFailed(vaultRoot, relPath);
      throw err;
    }
  }

  try {
    await writeMarkdownFile({
      vaultRoot,
      relPath,
      // Delta path: the gateway ignores this and reads fresh disk; `fm ?? {}`
      // is only the legacy fallback (delta undefined). Legacy path: the cache FM.
      frontmatter: fm ?? {},
      body,
      callerId: `frontmatter-scheduler:${relPath}`,
      docId,
      frontmatterDelta: delta,
    });
    // Phase 4 — the delta landed on disk; drop it from the accumulator, UNLESS a
    // newer edit folded in since we peeked (ref-identity: a fresh schedule
    // replaced the entry with a new merged object). On a write FAILURE the catch
    // below rethrows WITHOUT clearing, so the retry / quit-flush re-applies the
    // user's change instead of silently losing it. Leaving a superseded entry is
    // also safe — re-applying delta keys to disk that already holds them is
    // idempotent — but clearing the consumed one bounds the map's growth.
    if (delta && pendingDeltas.get(relPath) === delta) pendingDeltas.delete(relPath);
    // Record the highest version this writer flushed so concurrent stale
    // flushes know not to clobber. The gateway also bumps its own
    // copy of this map on success; both bump to the same value so this is
    // belt-and-braces, not redundant. Only docId-backed writes have a
    // meaningful version to track (M1 — the map is keyed by docId).
    if (docId) {
      const currentVersion = documentStore.getFrontmatterMutationVersion(docId);
      lastFlushedVersion.set(docId, Math.max(last, currentVersion));
    }
  } catch (err) {
    console.error('[frontmatterWriteScheduler] Failed to write frontmatter:', err);
    // Phase 31 A4.2 — distinguish "file deleted externally" from other
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
 * to disk for `docId`. Body writers (TextTile) consult this so a stale
 * in-memory frontmatter cache can't quietly clobber a fresher version that
 * landed on disk via a cross-board frontmatter flush in the interval
 * between the body writer's last fm-read and its IPC write.
 *
 * Returns `0` for docs that have never flushed (i.e. the cache is the
 * only source of truth, so no re-read is needed).
 *
 * M1 — keyed by docId (not relPath) to stay in the same version space as
 * `documentStore.getFrontmatterMutationVersion(docId)`.
 */
export function getLastFlushedFrontmatterVersion(docId: string): number {
  return lastFlushedVersion.get(docId) ?? 0;
}

/**
 * Bumps the recorded "highest mutation-version flushed to disk for docId"
 * to `version` (only if higher than what's recorded). Exposed for the
 * markdown-file-writer gateway so writes routed through it (TextTile body
 * writes, DocumentEditor saves, PropertiesPopup edits, orphan-fm sites) all
 * keep the version map authoritative without each call site reaching into
 * the scheduler's internals.
 *
 * No-op when `version <= 0` or `version <= current`.
 *
 * M1 — keyed by docId (not relPath); callers without a docId have no
 * version to track and simply don't call this.
 */
export function noteFrontmatterFlushedVersion(docId: string, version: number): void {
  if (!docId || version <= 0) return;
  const current = lastFlushedVersion.get(docId) ?? 0;
  if (version <= current) return;
  lastFlushedVersion.set(docId, version);
}

/**
 * Audit-11 EER-1 — drops a path's accumulated field delta AND cancels its
 * still-armed scheduler timer.
 *
 * The Phase-4 delta accumulator (`pendingDeltas`) is keyed independently of the
 * scheduler's own pending timer, so cancelling the timer alone leaves the delta
 * queued: a later `flushAllPendingFrontmatterWrites()` (the open-editor reload
 * fires one) or a fresh `scheduleFrontmatterWrite` for the same path would
 * re-apply the DISCARDED field edit to fresh disk — silently reverting the
 * external edit the user just chose to keep via "Reload". Dropping the delta
 * here makes a discard a true discard. The scheduler's `cancel` still emits a
 * balanced `endWrite(success=true)` so the recovery sentinel doesn't strand a
 * phantom dirty entry for `relPath`.
 */
export function dropPendingDelta(relPath: string): void {
  pendingDeltas.delete(relPath);
  frontmatterScheduler.cancel(relPath);
}

/**
 * Cancels a single path's pending frontmatter write without firing it, and
 * (Audit-11 EER-1) drops any accumulated field delta so it can't be resurrected
 * by a later flush. The primitive's `cancel` emits a balanced
 * `endWrite(success=true)` so the recovery sentinel doesn't strand a phantom
 * dirty entry for `relPath`.
 *
 * F4 (2026-05-28) — the external-change reconciler calls this from the
 * "Reload" branch of its pending-write conflict prompt: once the user opts
 * to take the disk version, the still-armed local frontmatter write must be
 * cancelled or it would fire moments later and clobber the just-reloaded
 * external frontmatter.
 */
export function cancelFrontmatterWrite(relPath: string): void {
  dropPendingDelta(relPath);
}

/**
 * Drops every pending timer and clears the per-docId version map.
 *
 * Sprint 35.4 / M1 — clearing `lastFlushedVersion` on vault swap bounds the
 * map's growth and drops any docId that could be reused across vaults. (The
 * original cross-vault same-`relPath` suppression this guarded against is
 * already prevented by the M1 switch to docId keying, but the reset remains
 * correct hygiene.)
 *
 * Registered as both a production reset (vault swap) and a test reset.
 */
export function resetFrontmatterScheduler(): void {
  frontmatterScheduler.reset();
  lastFlushedVersion.clear();
  // Phase 4 — drop any accumulated deltas so an outgoing vault's pending field
  // edit can't apply to a same-named file in the incoming vault.
  pendingDeltas.clear();
}

// Self-register cleanup so vault swap and test reset don't leak between vaults.
registerResetCallback(resetFrontmatterScheduler);
registerTestResetCallback(resetFrontmatterScheduler);

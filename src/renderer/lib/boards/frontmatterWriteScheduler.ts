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
import {
  markPathFailed,
  registerResetCallback,
  registerTestResetCallback,
} from './writeStateTracking';

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

const frontmatterScheduler = createScheduler<FrontmatterWriteArgs>({
  name: 'frontmatterWriteScheduler',
  debounceMs: FM_DEBOUNCE_MS,
  performWrite: (args) => writeFrontmatter(args),
  getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: args.relPath }),
  getFailureId: (args) => args.relPath,
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
export function scheduleFrontmatterWrite(relPath: string, docId: string | null): void {
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
  // it couldn't parse and silently corrupt the user's file.
  if (docId && documentStore.isReadOnly(docId)) return;

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
  if (scheduledVersion > 0 && scheduledVersion <= last) return;

  const fm = docId
    ? documentStore.getFrontmatter(docId)
    : vaultIndexStore.getMetadata(relPath)?.frontmatter;
  if (!fm) return;

  // 6.2.H5 — body resolution must not silently clobber disk truth.
  //
  // Pre-fix: `body = docState?.body ?? vaultIndex.content ?? ''`. If
  // docState is undefined at fire time, the chain fell through to the
  // index's possibly-hours-stale `content` — or `''` when the index
  // had no entry — and the write committed those bytes back to disk.
  //
  // (a) docId set + docState undefined → editor unmounted between
  //     schedule and fire. The user has no live edits we'd be
  //     preserving by writing; aborting keeps the (possibly externally
  //     edited) on-disk bytes intact.
  // (b) docId null → orphan FM write (Kanban card edit with no open
  //     editor). Hydrate fresh from disk and use that body; never
  //     trust `vaultIndex.content`, which is body-stripped AND can be
  //     hours stale relative to disk.
  let body: string;
  if (docId) {
    const docState = documentStore.getDocument(docId);
    if (!docState) return;
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
      // Audit-4 DI-13 / Audit5 2.3 (#7) — the backing `.md` is gone (ENOENT,
      // deleted out-of-band) or unreadable, so this orphan frontmatter write (a
      // Kanban / Task field edit with no open editor) can't land. The board
      // cache still shows the edit, so dropping it here would lose it silently.
      // `markPathFailed` surfaces the loss in the save indicator + `.filo/.dirty`
      // sentinel; the `throw` propagates it so the scheduler attributes `relPath`
      // to `flushAll().failed` → `save()` returns false. Pre-2.3 a bare `return`
      // resolved performWrite as SUCCESS, so the scheduler's settle `endWrite(true)`
      // then wiped the failed mark AND Ctrl+S toasted a false "Saved" while the
      // edit never reached disk. We still refuse to resurrect the deleted file —
      // we just stop swallowing the drop.
      markPathFailed(vaultRoot, relPath);
      throw err;
    }
  }

  try {
    await writeMarkdownFile({
      vaultRoot,
      relPath,
      frontmatter: fm,
      body,
      callerId: `frontmatter-scheduler:${relPath}`,
      docId,
    });
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
 * Cancels a single path's pending frontmatter write without firing it. The
 * primitive's `cancel` emits a balanced `endWrite(success=true)` so the
 * recovery sentinel doesn't strand a phantom dirty entry for `relPath`.
 *
 * F4 (2026-05-28) — the external-change reconciler calls this from the
 * "Reload" branch of its pending-write conflict prompt: once the user opts
 * to take the disk version, the still-armed local frontmatter write must be
 * cancelled or it would fire moments later and clobber the just-reloaded
 * external frontmatter.
 */
export function cancelFrontmatterWrite(relPath: string): void {
  frontmatterScheduler.cancel(relPath);
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
}

// Self-register cleanup so vault swap and test reset don't leak between vaults.
registerResetCallback(resetFrontmatterScheduler);
registerTestResetCallback(resetFrontmatterScheduler);

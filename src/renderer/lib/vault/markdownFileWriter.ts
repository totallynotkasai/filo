/**
 * markdownFileWriter — canonical write path for `.md` files.
 *
 * Five write sites previously reconstructed the markdown write operation
 * independently — TextTile, DocumentEditor, PropertiesPopup,
 * frontmatterWriteScheduler, and the orphan-fm commands. Each one re-implemented
 * `assembleMarkdownFile` without threading `parsed.hadBom`, decided locally
 * whether to gate on hydrate state, picked its own IPC channel, owned its own
 * debounce timer with its own cancel semantics, and updated
 * `frontmatterWriteScheduler.lastFlushedVersion` or not.
 *
 * This gateway is the single source of truth:
 *  - `parseMarkdownFile` reads `hadBom` from disk; the caller's hydrate flow
 *    reports it via `markHydrated(relPath, hadBom)`.
 *  - All writes funnel through `writeMarkdownFile`, which threads
 *    `{ bom: hadBom }` into `assembleMarkdownFile` (so Notepad-saved files
 *    preserve their BOM), calls `vault:write-existing-file-text` inside
 *    `trackComponentWrite`, and bumps the frontmatter scheduler's
 *    last-flushed-version map so cross-writer race guards stay accurate.
 *  - `scheduleMarkdownWrite` gives callers the 300ms idle coalesce for
 *    keystroke-driven writes; `flushMarkdownWrite(callerId)` drains a single
 *    caller's pending write on demand.
 *  - `markHydrated` / `isHydrated` enforce the hydrate-then-write invariant —
 *    a write before the editor's hydrate completes would otherwise assemble
 *    against an empty FM and stamp the empty FM on top of the YAML on disk.
 *  - `cancelAllMarkdownWrites` runs at `pre-swap` so timers armed against the
 *    outgoing vault don't fire after the new vault opens.
 *  - `registerForceWriter` lets editor-backed callers participate in
 *    Keep-local — `forceWriteForDocument` iterates registered writers for the
 *    affected docId and invokes their fresh-args callback so the live editor
 *    body lands on disk even when no debounce is armed.
 */

import { assembleMarkdownFile, parseMarkdownFile } from '../editor/markdownSync';
import { trackComponentWrite } from '../boards/boardSaver';
import { createScheduler } from '../boards/writeScheduler';
import { registerPendingProbe } from '../boards/writeStateTracking';
import { vaultPath } from '@shared/vaultPath';
import {
  getLastFlushedFrontmatterVersion,
  noteFrontmatterFlushedVersion,
} from '../boards/frontmatterWriteScheduler';
import { invokeOk } from '../utils/invokeOk';
import { documentStore } from '../../stores/document.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { parseMarkdown } from './vaultIndex';
import { onVaultSwap, vaultSwapResettable } from '../../core/vaultLifecycle';
import { getBaseline, noteBaseline, resetAllBaselines, hasBaselineDrifted, refreshOrClearBaseline } from './fileBaselineRegistry';
import { registerPathRenamable } from './renamePathKeys';

/**
 * Default 300ms idle debounce. Mirrors `FM_DEBOUNCE_MS` and the historical
 * TextTile / DocumentEditor / PropertiesPopup window so coalescing behaviour
 * is identical post-migration.
 */
export const MARKDOWN_WRITE_DEBOUNCE_MS = 300;

/**
 * Phase R6 — listener slot for the Reload / Keep-local prompt the writer
 * surfaces when a pre-write stat detects an external edit landed inside
 * the debounce window. The implementation lives in `stores/vaultExternalChanges`
 * (it depends on uiStore + documentStore + boardStore which `lib/` doesn't
 * import directly), and is registered at module-load on the store side via
 * `setExternalEditPromptHandler`.
 *
 * Returning `null` from the handler — or having no handler registered —
 * is treated as "Keep local"; the write proceeds. This matches the legacy
 * behaviour where the writer had no drift detection at all.
 */
type ExternalEditPromptHandler = (path: string) => Promise<'reload' | 'keep-local'>;
let externalEditPromptHandler: ExternalEditPromptHandler | null = null;

export function setExternalEditPromptHandler(handler: ExternalEditPromptHandler | null): void {
  externalEditPromptHandler = handler;
}

export interface WriteArgs {
  /** Vault root the write targets. Validated against `vaultStore.path` indirectly via the IPC handler. */
  vaultRoot: string;
  /** Vault-relative path of the `.md` file. */
  relPath: string;
  /** Frontmatter to serialise. */
  frontmatter: Record<string, unknown>;
  /** Body to serialise. */
  body: string;
  /** Stable per-component identifier; scopes the debounce timer and dedupes flushes. */
  callerId: string;
  /**
   * Optional document id. When provided, the gateway bumps the frontmatter
   * scheduler's `lastFlushedVersion` to `documentStore.getFrontmatterMutationVersion(docId)`
   * after a successful write so cross-writer race guards stay accurate.
   */
  docId?: string | null;
}

interface FileState { hadBom: boolean; }
/**
 * Per-file state populated by `markHydrated()`. Without an entry here,
 * `writeMarkdownFile` throws — the caller hasn't run its hydrate routine,
 * which would mean any write here stamps an empty frontmatter on top of
 * whatever YAML the file currently has on disk.
 */
const fileState = new Map<string, FileState>();

/**
 * Phase R1 (2026-05-26) — pending + in-flight bookkeeping now lives in
 * the shared `createScheduler` primitive.
 *
 * Audit2 2.3 — `sentinelMode: 'pending-path'` (was `manageSentinel: false`).
 * `writeMarkdownFile` already wraps its IPC in `trackComponentWrite`, which
 * begin/endWrites the INFLIGHT counter around the disk I/O, so the primitive
 * must NOT also bump inflight (it would double-count). But the previous
 * `manageSentinel: false` left the 300 ms DEBOUNCE window completely
 * untracked: a crash mid-typing lost up to ~300 ms of text with no
 * `.filo/.dirty` sentinel, and the save indicator read a premature "idle".
 * 'pending-path' mode tracks just the pending PATH for the armed window
 * (noteAdditionalPendingPath at schedule, dropPendingPath + syncSentinelIfIdle
 * at fire-handoff / cancel / reschedule / reset) — covering crash recovery and
 * the indicator without touching inflight.
 *
 * `getSentinelInfo` returns the relPath so the schedule-time pending path AND
 * flushAll's tracked `vaultRoot` (for the cross-scheduler `syncSentinelIfIdle`)
 * both carry through. FailureId is the callerId for parity with the legacy
 * `FlushAllResult.failed: [{ ownerId, error }]` shape.
 */
const writerScheduler = createScheduler<WriteArgs>({
  name: 'markdownFileWriter',
  debounceMs: 300, // Default; per-call delay override supported.
  performWrite: (args) => writeMarkdownFile(args),
  getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: args.relPath }),
  getFailureId: (args) => args.callerId,
  sentinelMode: 'pending-path',
});

// Phase 4 / E3 — because this scheduler opts out of sentinel management
// (`manageSentinel: false`), its armed-but-not-yet-fired writes don't enter
// `pendingVaultPaths` until they fire. Register a probe so the single
// `isPathPending` authority still reports them — keeping the external-change
// reconcilers' dirty-check honest for a debounced editor-body write that
// hasn't flushed yet. In-flight writes (mid-`trackComponentWrite`) already
// show up in the ledger, so the probe only covers the pending-timer window.
registerPendingProbe((path) => {
  const target = vaultPath(path);
  return writerScheduler.hasPending((args) => vaultPath(args.relPath) === target);
});

/**
 * callerId → fresh-args callback. Carry-over from the old
 * `markdownWriteRegistry.forceWriteForDocument` API: editor-backed writers
 * (TextTile, DocumentEditor) register a callback that returns the LATEST
 * args (live editor body + current frontmatter) so Keep-local can flush
 * exactly what the user sees in the editor, not a stale schedule snapshot.
 *
 * Non-editor callers (PropertiesPopup, orphan-fm sites) don't need to
 * register here — they always call `writeMarkdownFile` / `scheduleMarkdownWrite`
 * with fresh args inline.
 *
 * 6.3.P4 — the sibling `lastSeenArgs` Map (a shim-migration leftover that
 * was populated by every successful write but read by no production
 * consumer) is deleted. `forceWriteForDocument` always reads the live
 * editor body via `entry.build()` and never falls back to the cached
 * snapshot, so caching it here was dead storage that grew unboundedly
 * over a session.
 */
interface ForceWriter {
  docId: string | null;
  build: () => WriteArgs | null;
}
const forceWriters = new Map<string, ForceWriter>();

/**
 * 6.2.H10 — in-flight write tracker keyed by `callerId`. Populated for the
 * lifetime of each `writeMarkdownFile` call so concurrent paths can
 * `await` any pending IPC for the same caller before re-arming a write.
 *
 * Pre-fix race: `scheduleMarkdownWrite` armed a timer; the timer fired
 * and `writeMarkdownFile` entered the IPC await; before that resolved a
 * `forceWriteForDocument` ran, called `cancelMarkdownWrite` (no-op — the
 * timer had already fired), and started a second `writeMarkdownFile`.
 * Two writes raced; the OS serialised them in arbitrary order, the loser
 * silently clobbered the winner's bytes.
 *
 * The wrapper inside `writeMarkdownFile` sets/clears the map entry; the
 * `awaitInFlightWriteForCaller` helper exposes it to the force/cancel
 * paths.
 */
// allow-module-state: drained synchronously by cancelAllMarkdownWrites at vault swap
const inFlightWrites = new Map<string, Promise<void>>();

// ── Hydrate gate ──

/**
 * Marks `relPath` as hydrated for the writer pipeline and records its BOM
 * status so subsequent writes can re-emit the leading `EF BB BF` byte
 * sequence (preserving Notepad-saved files round-trip).
 *
 * Phase R6 / F1 — `mtimeMs` + `size` (optional) stamp the file's baseline
 * so the pre-write drift check inside `writeMarkdownFile` can detect
 * external edits landing between hydrate and the next debounced write.
 * Both are needed for a complete baseline; passing one without the other
 * seeds nothing (see `noteBaseline`).
 *
 * As of F1 (2026-05-28) the read-driven hydrate sites thread it through
 * `vault:read-file-text`'s returned `mtimeMs`: the TextTile /
 * DocumentEditor disk-read paths (the editor debounced writes they back
 * have no other drift guard), plus the read-then-write command/scheduler
 * paths that also lack their own guard — the frontmatter scheduler, the
 * kanban orphan-frontmatter patch, and UpdatePropertiesCommand.
 *
 * `boardCache.syncTileMarkdown` deliberately does NOT thread it: that path
 * runs its own pre-read / pre-write stat guard, so seeding a baseline here
 * would risk a redundant Reload prompt on the same external edit.
 *
 * Callers without an mtime (in-memory hydrate, fresh-file creation) leave
 * the baseline empty — the writer's drift check no-ops, falling back to the
 * legacy "no comparison anchor" behaviour until the first successful write's
 * post-write stat seeds it.
 *
 * Idempotent — re-calling overwrites the previous flag. Editor remounts
 * across vault swaps will re-hydrate from disk and re-mark.
 */
export function markHydrated(
  relPath: string,
  hadBom: boolean,
  mtimeMs?: number,
  size?: number,
): void {
  if (!relPath) return;
  fileState.set(relPath, { hadBom });
  if (mtimeMs !== undefined) noteBaseline(relPath, mtimeMs, size);
}

/**
 * Drops the hydration state for `relPath`. Call from the editor's
 * `onDestroy` and from the rename/delete propagation paths so a later
 * write to a same-named file in a different lifetime can't re-use a stale
 * BOM flag.
 */
export function clearHydrated(relPath: string): void {
  if (!relPath) return;
  fileState.delete(relPath);
}

export function isHydrated(relPath: string): boolean {
  return fileState.has(relPath);
}

/**
 * Phase 6.1.R4 — transfer the hydrate state from `oldRel` to `newRel`
 * so a post-rename body write doesn't trip "refusing to write — not
 * hydrated" against the new path. Also covers descendants for folder
 * renames. Registered with `renameAllPathKeys` below — the audit's
 * canonical missed example: every prior rename cascade forgot this map,
 * and every keystroke after rename would throw on the gateway's hydrate
 * gate until the user happened to re-mount the editor.
 */
export function renameFileStatePath(oldRel: string, newRel: string): void {
  if (!oldRel || !newRel || oldRel === newRel) return;
  const exact = fileState.get(oldRel);
  if (exact !== undefined) {
    fileState.delete(oldRel);
    fileState.set(newRel, exact);
  }
  const oldChildPrefix = oldRel + '/';
  const newChildPrefix = newRel + '/';
  const transfers: Array<[string, FileState]> = [];
  for (const [key, value] of fileState) {
    if (key.startsWith(oldChildPrefix)) {
      transfers.push([newChildPrefix + key.slice(oldChildPrefix.length), value]);
      fileState.delete(key);
    }
  }
  for (const [k, v] of transfers) fileState.set(k, v);
}

registerPathRenamable('markdownFileWriter.fileState', renameFileStatePath);

/**
 * Test-only — drops every hydration entry. Production code uses
 * `clearHydrated` (per-path) or `cancelAllMarkdownWrites` (full reset
 * via the vault-swap hook).
 */
export function __clearFileStateForTests(): void {
  fileState.clear();
}

// ── Disk-read hydrate gateway ──

/**
 * Result of {@link readMarkdownForHydrate}. Carries the raw `content` plus
 * the parsed `frontmatter` / `body` / `hadBom` so callers don't re-parse,
 * and the `mtimeMs` that was already folded into the drift baseline.
 */
export interface HydrateReadResult {
  /** Raw file content exactly as read from disk (BOM byte included if present). */
  content: string;
  /** Whether the file led with a UTF-8 BOM (preserved on write). */
  hadBom: boolean;
  /** Disk mtime captured by the read; `undefined` if the handler omitted it. */
  mtimeMs: number | undefined;
  /** Disk byte size captured by the read; `undefined` if the handler omitted it. */
  size: number | undefined;
  /** Parsed YAML frontmatter (empty object when none). */
  frontmatter: Record<string, unknown>;
  /**
   * Audit2 / 1.2 — verbatim frontmatter source bytes (empty when none). Seed
   * it into `documentStore.setFrontmatter` so a later body-only save can emit
   * the block untouched instead of re-dumping the parsed object.
   */
  rawFrontmatter: string;
  /** Markdown body with frontmatter stripped. */
  body: string;
}

/**
 * Phase 4 / E1 — the single sanctioned way to read a `.md` file *for the
 * purpose of hydrating* an editor or cache. Recurrence-proofs F1.
 *
 * F1 was: the drift baseline (`fileBaselineRegistry`) is only seeded when a
 * hydrate threads the read's `mtimeMs` into `markHydrated`. Several read
 * sites forgot to, so the pre-write drift check no-oped and an external
 * edit landing between hydrate and the next debounced write was silently
 * overwritten. Fixing each call site individually re-opens the gap the
 * moment a new hydrate site is added.
 *
 * This gateway does the read + parse + `markHydrated(relPath, hadBom,
 * mtimeMs)` in one place, so the content and the baseline always come from
 * the SAME `vault:read-file-text` call (no read/stat TOCTOU gap) and a
 * hydrate can never land without its baseline. `scripts/check-markdown-read-gateway.mjs`
 * forbids any file from pairing a direct `vault:read-file-text` invoke with
 * a `markHydrated` call, so a future disk-read hydrate site must route here.
 *
 * Throws on read failure (the `invokeOk` envelope contract). Callers that
 * need a graceful fallback — mount-with-empty-content (DocumentEditor),
 * fall-back-to-embedded-content (TextTile), or proceed-and-let-the-write-
 * ENOENT (frontmatter scheduler / orphan-fm commands) — wrap this in a
 * try/catch and run their own in-memory `markHydrated(relPath, false)`
 * fallback, exactly as before. Those in-memory (no-disk-read) hydrates stay
 * legal because they pass no `mtimeMs` and seed no baseline.
 */
export async function readMarkdownForHydrate(
  vaultRoot: string,
  relPath: string,
): Promise<HydrateReadResult> {
  const result = await invokeOk('vault:read-file-text', vaultRoot, relPath);
  const parsed = parseMarkdownFile(result.content);
  markHydrated(relPath, parsed.hadBom, result.mtimeMs, result.size);
  return {
    content: result.content,
    hadBom: parsed.hadBom,
    mtimeMs: result.mtimeMs,
    size: result.size,
    frontmatter: parsed.frontmatter,
    rawFrontmatter: parsed.rawFrontmatter,
    body: parsed.body,
  };
}

// ── Single write entry point ──

/**
 * Writes a `.md` file via the canonical pipeline:
 *  1. Assemble frontmatter + body with `{ bom: hadBom }` so the BOM
 *     round-trips faithfully.
 *  2. Track the write through `trackComponentWrite` so the sentinel,
 *     in-flight counter, and write-error toasts all participate.
 *  3. Bump `frontmatterWriteScheduler.lastFlushedVersion` to the docId's
 *     current mutation version so concurrent body writers know not to
 *     overwrite with a stale frontmatter snapshot.
 *
 * Throws on:
 *  - Unhydrated relPath (no `markHydrated` call yet for this file).
 *  - IPC failure (ENOENT / EACCES / etc.) — the caller decides whether to
 *    mark its component as backing-file-missing, surface its own toast, etc.
 */
export async function writeMarkdownFile(args: WriteArgs): Promise<void> {
  // 6.2.H10 — track this fire's promise so a concurrent
  // `forceWriteForDocument` or `cancelMarkdownWritesForDocument`
  // can await it before re-arming a new write or returning. Without
  // this, the timer's late fire (already past the cancel point) raced
  // a force-write at the IPC layer — two writes ordered by the OS,
  // last one wins, the loser's bytes silently lost.
  const promise = writeMarkdownFileImpl(args);
  inFlightWrites.set(args.callerId, promise);
  try {
    await promise;
  } finally {
    if (inFlightWrites.get(args.callerId) === promise) {
      inFlightWrites.delete(args.callerId);
    }
  }
}

async function writeMarkdownFileImpl(args: WriteArgs): Promise<void> {
  const { vaultRoot, relPath, body, callerId, docId } = args;
  if (!vaultRoot || !relPath) {
    throw new Error('markdownFileWriter: vaultRoot and relPath are required');
  }
  const state = fileState.get(relPath);
  if (!state) {
    throw new Error(
      `markdownFileWriter: refusing to write "${relPath}" — file is not hydrated. ` +
      `Call markHydrated(relPath, hadBom) after parseMarkdownFile before writing.`,
    );
  }

  // Phase R6 — pre-write drift check. If the file's mtime on disk
  // differs from the baseline captured at hydrate-time (or after the
  // most recent self-write), an external editor wrote to the file
  // since we last knew about it. Surface the Reload / Keep-local
  // prompt so the user explicitly chooses whether to clobber the
  // external bytes — never silently overwrite. No baseline → no
  // comparison anchor, fall through to the legacy unguarded write
  // path (e.g. first write to a freshly-seeded file).
  const baseline = getBaseline(relPath);
  if (baseline !== undefined) {
    let preWriteStat: { mtimeMs: number; size: number } | undefined;
    try {
      preWriteStat = await invokeOk('vault:stat', vaultRoot, relPath);
    } catch {
      // Stat failed (ENOENT, EACCES, NO_ACTIVE_VAULT). Fall through —
      // the IPC below will surface the same shape via trackComponentWrite.
    }
    if (preWriteStat !== undefined && hasBaselineDrifted(baseline, preWriteStat)) {
      const handler = externalEditPromptHandler;
      const choice = handler ? await handler(relPath) : 'keep-local';
      if (choice === 'reload') {
        // The Reload handler refreshed vault index + editor content
        // from disk. Drop this scheduled write — the user has
        // explicitly chosen to discard their pending bytes. The
        // baseline was already refreshed by the Reload path
        // (applyReloadFromDisk → markHydrated mtime threading), so no
        // further bookkeeping needed here.
        return;
      }
      // 'keep-local' — proceed with the write below. The user has
      // explicitly chosen to overwrite the external edit.
    }
  }

  // Phase 18 H13 — stale-cache re-read protection. The caller captured the
  // frontmatter at schedule time, but a cross-board frontmatter writer
  // (PropertiesPopup, TaskListBoard, etc.) could have flushed a newer FM to
  // disk in the meantime. The frontmatter scheduler's last-flushed-version
  // map records the highest mutation version that successfully landed on
  // disk; if that's higher than the documentStore's current cache version
  // for this docId, the caller's args are stale — re-read disk, back-merge
  // into the cache, and use the disk FM. One extra IPC per stale-detected
  // write; the happy path stays a pure write.
  // Audit2 2.5 — frontmatter is owned by the live documentStore cache, not the
  // caller's schedule-time snapshot in `args.frontmatter`. A body write debounces
  // for 300 ms; if an FM mutation lands in the cache during that window — an
  // external frontmatter-only edit reconciled in, a PropertiesPopup / TaskList
  // edit, or a cross-board flush — emitting the frozen snapshot would silently
  // clobber it. Read the cache live at fire time (its presence is authoritative;
  // both editor callers source `args.frontmatter` from it anyway), falling back
  // to the caller's args only when the cache has no entry for this doc.
  let fm = (docId ? documentStore.getFrontmatter(docId) : undefined) ?? args.frontmatter;
  if (docId) {
    // M1 — version map is keyed by docId so this comparison stays in the
    // same version space as `getFrontmatterMutationVersion(docId)`.
    const lastFlushed = getLastFlushedFrontmatterVersion(docId);
    const cacheVersion = documentStore.getFrontmatterMutationVersion(docId);
    if (lastFlushed > 0 && lastFlushed > cacheVersion) {
      try {
        const readResult = await invokeOk('vault:read-file-text', vaultRoot, relPath);
        const parsed = parseMarkdownFile(readResult.content);
        // 1.2 — re-seed the verbatim bytes too so this (body-only) write can
        // still emit the freshly-read frontmatter untouched.
        documentStore.setFrontmatter(docId, parsed.frontmatter, parsed.rawFrontmatter);
        fm = parsed.frontmatter;
      } catch (err) {
        console.warn('[markdownFileWriter] Stale-cache re-read failed; using caller args:', err);
      }
    }
  }

  // Audit2 / 1.2 — when this write is backed by an open document whose
  // frontmatter is still byte-identical to disk (no mutation since hydrate),
  // emit those bytes verbatim. `getRawFrontmatter` returns undefined once a
  // mutation invalidated them, in which case we re-dump the object as before.
  const rawFrontmatter = docId ? documentStore.getRawFrontmatter(docId) : undefined;
  // Audit2 4.8 — the disk-baseline source (survives mutations) lets a dirty
  // write patch the original frontmatter bytes source-preservingly instead of
  // re-dumping the whole object.
  const originalFrontmatter = docId
    ? documentStore.getOriginalFrontmatterSource(docId)
    : undefined;
  const fileText = assembleMarkdownFile(fm, body, {
    bom: state.hadBom,
    rawFrontmatter,
    frontmatterDirty: rawFrontmatter === undefined,
    originalFrontmatter,
  });
  await trackComponentWrite(vaultRoot, relPath, async () => {
    await invokeOk('vault:write-existing-file-text', vaultRoot, relPath, fileText);
  });
  // Phase R6 — refresh the baseline to the post-write mtime so a
  // late watcher echo (or the next debounced write) compares against
  // the state we just wrote, not the pre-write state. Best-effort:
  // a stat failure here just leaves the baseline at the pre-write
  // value, which would surface a spurious drift toast on the NEXT
  // write — and the user's "Keep-local" answer still lets them
  // proceed.
  // 6.4.M2 — clear the prior baseline on stat failure / unusable stat
  // (AV scanner, SMB latency, VFS quirks). Leaving the PRE-write baseline
  // pinned to the path would surface a spurious "modified externally"
  // toast the next time the reconcile loop runs against the post-write
  // disk bytes. The "no baseline" path is benign: writers proceed without
  // a drift check until the next hydrate / successful write seeds again.
  try {
    const postStat = await invokeOk('vault:stat', vaultRoot, relPath);
    refreshOrClearBaseline(relPath, postStat.mtimeMs, postStat.size);
  } catch {
    refreshOrClearBaseline(relPath, undefined, undefined);
  }
  // Sprint C / C-A5-2 — refresh the vault index from the just-written bytes
  // so a late watcher echo past the renderer-side suppression TTL
  // (1.5 s idle / 5 s bulk) classifies as 'ignore' / 'noop-change' instead
  // of comparing the post-write disk content against the stale pre-write
  // baseline (which would surface a spurious "modified externally" toast
  // for the user's own write).
  //
  // We synthesise the FileMetadata locally rather than calling
  // `applyChanges([relPath])` because trackComponentWrite already threw on
  // IPC failure — the only way we reach this line is if the bytes landed
  // on disk. `parseMarkdown(relPath, fileText)` produces the same
  // FileMetadata the watcher's re-read path would produce, without the
  // extra IPC round-trip. Best-effort: a parse failure here doesn't fail
  // the write (the next watcher event will just re-classify normally).
  try {
    const refreshed = parseMarkdown(relPath, fileText);
    vaultIndexStore.restoreMetadata(relPath, refreshed);
  } catch (err) {
    console.warn('[markdownFileWriter] post-write index refresh failed (best-effort):', err);
  }
  if (docId) {
    const version = documentStore.getFrontmatterMutationVersion(docId);
    noteFrontmatterFlushedVersion(docId, version);
  }
}

// ── Debounce wrapper ──

/**
 * Schedules a debounced markdown write under `callerId`. Subsequent calls
 * for the same `callerId` reset the timer and replace the args — only the
 * most recent args win, matching the per-component debounce semantics the
 * old TextTile / DocumentEditor / PropertiesPopup writers enforced locally.
 *
 * Failures inside the deferred write are silenced here — `trackComponentWrite`
 * already routes them through the save-error pipeline (toast + sentinel +
 * saveStateStore). Callers that need to await failure attribution can
 * call `flushMarkdownWrite(callerId)` directly.
 */
export function scheduleMarkdownWrite(args: WriteArgs, delay: number = MARKDOWN_WRITE_DEBOUNCE_MS): void {
  // Args getter returns the same stable args reference — the primitive
  // calls it at schedule (probe) and fire (write) time. Re-arming the
  // same callerId overwrites the prior args, matching the legacy
  // "latest args win" behaviour.
  writerScheduler.schedule(args.callerId, () => args, delay);
}

/**
 * Drains `callerId`'s pending write immediately. Re-entrant — a concurrent
 * call against the same caller awaits the in-flight write rather than
 * racing it. Re-throws any IPC failure so an awaiting Ctrl+S / vault-swap
 * path can refuse to report "saved" when the write actually rejected.
 *
 * No-op when no schedule is armed and no write is in flight.
 */
export async function flushMarkdownWrite(callerId: string): Promise<void> {
  // The primitive's `flush(key)` drains the pending timer, awaits any
  // in-flight write, and surfaces the per-write outcome via `ok`. We
  // intentionally drop the boolean here — every error path inside
  // `writeMarkdownFile` already routes through `trackComponentWrite` /
  // `notifyWriteError`, so awaiting callers only need the "the write
  // landed (or failed visibly)" signal that `await flush` provides.
  await writerScheduler.flush(callerId);
}

/**
 * Cancels `callerId`'s pending timer without flushing it. Used by the
 * editor's onDestroy when the component is unmounting and a write would
 * land against a now-stale relPath (rename mid-debounce, vault swap, etc.).
 */
export function cancelMarkdownWrite(callerId: string): void {
  writerScheduler.cancel(callerId);
}

// ── Global hooks ──

/**
 * Audit2 5.9 — test-only flusher registry. Production code MUST NOT use this
 * API; the CI gate `scripts/check-no-prod-markdown-test-flushers.mjs` enforces
 * it. Tests use this to inject arbitrary flush callbacks that get drained
 * alongside the gateway's real pending writes — replacing the deleted
 * `markdownWriteRegistry` shim's `registerMarkdownFlusher` fixture surface
 * without leaving dead-in-production code on the save/flush hot path.
 *
 * Tests import these directly as `__testRegisterFlusher` /
 * `__testUnregisterFlusher`; the alias pattern
 * `import { __testRegisterFlusher as registerMarkdownFlusher }` preserves the
 * inline assertion vocabulary the legacy fixtures used.
 */
type TestFlusher = () => Promise<void>;
interface TestFlusherEntry {
  flush: TestFlusher;
  forceWrite?: TestFlusher;
  getDocId?: () => string | null | undefined;
}
const testFlushers = new Map<string, TestFlusherEntry>();
// Phase 6.1.R2 — register the test-flusher registry for vault-swap reset.
// Production never populates the map (no production code calls
// `__testRegisterFlusher`), but a test that fires `fireVaultSwap` would
// otherwise carry the prior test's flushers into the new vault's first
// drain. The `__resetMarkdownFileWriterForTests` reset still clears the
// map for the per-test cleanup path; this registration covers the
// swap-without-test-reset edge.
vaultSwapResettable('markdownFileWriter.testFlushers', () => {
  testFlushers.clear();
});

export interface __TestFlusherOptions {
  forceWrite?: TestFlusher;
  getDocId?: () => string | null | undefined;
}

export function __testRegisterFlusher(
  ownerId: string,
  flush: TestFlusher,
  options: __TestFlusherOptions = {},
): void {
  testFlushers.set(ownerId, {
    flush,
    forceWrite: options.forceWrite,
    getDocId: options.getDocId,
  });
}

export function __testUnregisterFlusher(ownerId: string): void {
  testFlushers.delete(ownerId);
}

async function drainTestFlushers(): Promise<Array<{ ownerId: string; error: unknown }>> {
  if (testFlushers.size === 0) return [];
  const snapshot = Array.from(testFlushers.entries());
  const settled = await Promise.allSettled(snapshot.map(([, entry]) => entry.flush()));
  const failed: Array<{ ownerId: string; error: unknown }> = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'rejected') {
      failed.push({ ownerId: snapshot[i][0], error: result.reason });
    }
  }
  return failed;
}

/**
 * Drains every pending markdown write across all callers.
 *
 * Returns `{ ok, failed }` where `failed` lists the callerIds whose write
 * rejected. The Ctrl+S aggregate (`vaultStore.save()`) folds `failed` into
 * its overall boolean so a single bad write surfaces honestly to the user
 * instead of flashing "saved" while a `.md` was actually dropped.
 *
 * Note: this drains gateway-owned pending writes only. The frontmatter
 * scheduler at `lib/boards/frontmatterWriteScheduler.ts` has its own
 * sibling debounce map keyed by relPath; callers that need both drained
 * call `flushAllPendingFrontmatterWrites` alongside this function.
 *
 * Audit2 5.9 — also drains any test-only flushers registered via
 * `__testRegisterFlusher`. In production the test-flusher map is empty
 * (the CI gate forbids prod registrations), so this is a zero-cost
 * pass-through; in tests the registered flushers participate in the
 * same `failed[]` aggregation as real writes.
 */
export async function flushAllMarkdownWrites(): Promise<{ ok: boolean; failed: string[] }> {
  const [schedulerResult, testFailures] = await Promise.all([
    writerScheduler.flushAll(),
    drainTestFlushers(),
  ]);
  const failed = [...schedulerResult.failed, ...testFailures.map((f) => f.ownerId)];
  return { ok: failed.length === 0, failed };
}

/**
 * Backwards-compatibility alias for the old `markdownWriteRegistry` API.
 * Consumers that don't care about the failure list (just need a fire-and-
 * forget drain) can use this; consumers that want per-failure attribution
 * call `flushAllMarkdownWrites` directly.
 *
 * Returns the registry's old `{ ok, failed }` shape (ok=count of successful
 * drains, failed=array of `{ ownerId, error }`) so call sites that depend
 * on the registry's return shape (e.g. the `mdResult.failed.length` checks
 * in vaultStore.save, tabsStore.close, vaultFolderOps.delete, fileTags
 * tag-rewrite-everywhere) keep working without modification.
 */
export interface FlushAllResult {
  ok: number;
  failed: Array<{ ownerId: string; error: unknown }>;
}

export async function flushAllMarkdownWriters(): Promise<FlushAllResult> {
  // Mirror flushAllMarkdownWrites internally so the test-flusher errors carry
  // their *original* rejection (not a generic wrapper), which the
  // markdownWriteRegistryFlush test contract relies on for `result.failed[i].error`
  // identity. Production callers only inspect `failed.length`, so the richer
  // error preservation is a free upgrade for them.
  const [schedulerResult, testFailures] = await Promise.all([
    writerScheduler.flushAll(),
    drainTestFlushers(),
  ]);
  const failed: FlushAllResult['failed'] = [
    ...schedulerResult.failed.map((ownerId) => ({
      ownerId,
      error: new Error(`Flush rejected for ${ownerId}`),
    })),
    ...testFailures,
  ];
  // 6.3.P4 — `ok` now sums production writes drained successfully
  // (schedulerResult.ok, returned by the writeScheduler primitive) AND
  // successful test flushers. Pre-fix this was only the test-flusher
  // count, which is 0 in production — masking actual production write
  // counts. Production callers still check `failed.length === 0`;
  // tests rely on `ok` matching the count of registered+drained flushers.
  const testOk = testFlushers.size - testFailures.length;
  return {
    ok: Math.max(0, schedulerResult.ok + testOk),
    failed,
  };
}

/**
 * Cancels every pending markdown timer without firing them. Routed
 * through the vault-swap `pre-swap` hook so timers armed against the
 * outgoing vault don't fire after the new vault opens (their closures
 * still reference the old vaultRoot through `WriteArgs`).
 *
 * Phase R1 — the scheduler primitive owns pending + in-flight + failure
 * bookkeeping; `reset()` drops every internal map. The remaining
 * gateway-local maps (hydrate state, force-writers, last-seen args) are
 * cleared here for the per-test reset path.
 *
 * Phase R6 — baseline registry resets on vault swap via its own
 * `resetAllBaselines` registered in `vaultLifecycle`. We deliberately
 * DON'T drop it here, because `cancelAllMarkdownWrites` is also called
 * from per-test cleanup paths where the test may still need the
 * baseline for assertions; tests use `__resetBaselinesForTests` for an
 * explicit wipe.
 */
export function cancelAllMarkdownWrites(): void {
  writerScheduler.reset();
  fileState.clear();
  forceWriters.clear();
  // 6.2.H10 — drop in-flight promise refs. The promises themselves
  // will still settle (we can't unsettle a pending IPC), but with no
  // map entry any cancel/force await becomes a no-op for the new
  // vault — late settlement of an outgoing-vault write does not block
  // incoming-vault setup.
  inFlightWrites.clear();
}

// ── Keep-local force-write API ──

/**
 * Registers a fresh-args callback for `callerId`. The gateway calls `build()`
 * from `forceWriteForDocument(docId)` to obtain the live editor body + the
 * latest frontmatter, then writes via the canonical pipeline.
 *
 * Components register in onMount and unregister in onDestroy. The docId
 * may be null (e.g. a properties popup before its TextTile has hydrated);
 * `forceWriteForDocument` matches on the docId at call time, so a writer
 * that adopts a sibling's docId mid-life will be reachable as soon as the
 * adoption completes.
 */
export function registerForceWriter(
  callerId: string,
  docId: string | null,
  build: () => WriteArgs | null,
): void {
  forceWriters.set(callerId, { docId, build });
}

export function unregisterForceWriter(callerId: string): void {
  forceWriters.delete(callerId);
}

/**
 * Audit 2.1 — cancels every armed (debounced, not-yet-fired) markdown write
 * belonging to an open editor on `docId`. Used by vault-wide rewrites
 * (Replace All) that authoritatively rewrite a file on disk and then sync the
 * open editor: a write still armed against the doc carries the editor's
 * pre-rewrite body and would re-clobber the rewrite ~300ms later. Matches by
 * docId via the force-writer registry (the same identity `forceWriteForDocument`
 * uses), so only editor-backed writers (TextTile / DocumentEditor) are
 * affected — exactly the "open editor" case.
 */
export function cancelMarkdownWritesForDocument(docId: string): void {
  if (!docId) return;
  for (const [callerId, entry] of forceWriters.entries()) {
    if (entry.docId === docId) cancelMarkdownWrite(callerId);
  }
}

/**
 * 6.2.H10 — async sibling of `cancelMarkdownWritesForDocument`. Cancels the
 * armed timers (the synchronous part) AND awaits any in-flight write IPC
 * for matching callers. Use when the caller needs the guarantee that no
 * writer is still pumping bytes against `docId` before it proceeds
 * (vault swap, tab close, recovery sentinels). Returns once every in-
 * flight write for the matched callers has settled.
 *
 * The sync version remains for callers that just want to disarm timers
 * (the most common case — `applyReloadFromDisk` synchronously replaces
 * state on the next line, and the in-flight write's clobber is bounded
 * by the next debounce's correction).
 */
export async function cancelAndAwaitMarkdownWritesForDocument(
  docId: string,
): Promise<void> {
  if (!docId) return;
  const targets: string[] = [];
  for (const [callerId, entry] of forceWriters.entries()) {
    if (entry.docId === docId) {
      cancelMarkdownWrite(callerId);
      targets.push(callerId);
    }
  }
  await Promise.all(
    targets.map((id) => {
      const p = inFlightWrites.get(id);
      return p ? p.catch(() => undefined) : Promise.resolve();
    }),
  );
}

/**
 * Forces every writer matching `docId` to commit its current in-memory body
 * to disk. Returns the same shape as the old `markdownWriteRegistry.forceWriteForDocument`
 * so existing consumers (the Keep-local handler in `vaultExternalChanges`)
 * keep their failure-aggregation pipeline intact.
 *
 * Matching by docId (rather than draining everything) preserves intent:
 * the user only opted in for THIS document, so other open editors with
 * their own debounced writes aren't forced past their flush guard.
 */
export interface ForceWriteResult {
  ok: number;
  failed: Array<{ ownerId: string; error: unknown }>;
}

export async function forceWriteForDocument(docId: string): Promise<ForceWriteResult> {
  if (!docId) return { ok: 0, failed: [] };
  // Audit2 5.9 — drain test-registered flushers (no-op in production) so the
  // shim's force-write contract — "match by getDocId, call forceWrite if
  // present else flush" — survives the migration.
  const testMatches: Array<[string, TestFlusher]> = [];
  for (const [ownerId, entry] of testFlushers.entries()) {
    if (entry.getDocId?.() === docId) {
      testMatches.push([ownerId, entry.forceWrite ?? entry.flush]);
    }
  }
  const targets: Array<[string, () => WriteArgs | null]> = [];
  for (const [callerId, entry] of forceWriters.entries()) {
    if (entry.docId === docId) targets.push([callerId, entry.build]);
  }
  if (targets.length === 0 && testMatches.length === 0) {
    return { ok: 0, failed: [] };
  }

  const [productionSettled, testSettled] = await Promise.all([
    Promise.allSettled(
      targets.map(async ([, build]) => {
        const args = build();
        if (!args) return;
        // Cancel any armed schedule for this caller so the immediate write
        // isn't duplicated by the timer's deferred write a few hundred ms later.
        cancelMarkdownWrite(args.callerId);
        // 6.2.H10 — if a timer's late fire is still in the IPC await chain
        // for this caller, wait for it to settle before starting the new
        // write. Without this guard the two writes raced and the OS
        // arbitrated the order, leaving the loser's bytes on disk under
        // the winner. `.catch` swallows the prior write's failure because
        // we're about to issue a fresh one — the prior failure has its
        // own attribution via trackComponentWrite.
        const prior = inFlightWrites.get(args.callerId);
        if (prior) await prior.catch(() => undefined);
        await writeMarkdownFile(args);
      }),
    ),
    Promise.allSettled(testMatches.map(([, fn]) => fn())),
  ]);

  const failed: ForceWriteResult['failed'] = [];
  let ok = 0;
  for (let i = 0; i < productionSettled.length; i++) {
    const result = productionSettled[i];
    const [ownerId] = targets[i];
    if (result.status === 'fulfilled') ok++;
    else failed.push({ ownerId, error: result.reason });
  }
  for (let i = 0; i < testSettled.length; i++) {
    const result = testSettled[i];
    const [ownerId] = testMatches[i];
    if (result.status === 'fulfilled') ok++;
    else failed.push({ ownerId, error: result.reason });
  }
  return { ok, failed };
}

// ── Vault-swap registration ──
//
// Registered at module load. The pre-swap phase fires before the new vault
// hydrates; this drops every pending timer + cached args so a fire armed
// against the outgoing vault can't land after the new vault opens (the
// closure would otherwise write to the old vaultRoot, corrupting the
// outgoing vault's files OR throwing because the IPC handler's vault gate
// now rejects the old path).
//
// Phase R6 — also drop the file-baseline registry. A same-named file in
// the new vault would otherwise inherit the outgoing vault's mtime
// baseline, suppressing a legitimate drift check (mtime differs ⇒
// "external edit detected") on its first write.
onVaultSwap('pre-swap', 'markdownFileWriter', () => {
  cancelAllMarkdownWrites();
  resetAllBaselines();
});

/**
 * Test-only — full reset of every map in the gateway. Use between unit
 * tests so a registration from a prior test doesn't leak into the next
 * test's dispatch.
 *
 * Audit2 5.9 — also clears the test-only flusher registry. Prior to the
 * shim migration the per-test cleanup wiped both maps via
 * `__resetMarkdownFlushersForTests`; merging the reset here keeps the
 * one-call cleanup contract intact for callers of either name.
 */
export function __resetMarkdownFileWriterForTests(): void {
  cancelAllMarkdownWrites();
  testFlushers.clear();
}

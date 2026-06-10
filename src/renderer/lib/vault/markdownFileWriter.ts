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
import {
  type FrontmatterDelta,
  applyFrontmatterDelta,
  isEmptyFrontmatterDelta,
} from './frontmatterDelta';
import { trackComponentWrite } from '../boards/boardSaver';
import { createScheduler } from '../boards/writeScheduler';
import { WRITE_TIMEOUT_MS } from '../boards/boardWriteDebounce';
import { registerPendingProbe, markPathFailed } from '../boards/writeStateTracking';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import {
  getLastFlushedFrontmatterVersion,
  noteFrontmatterFlushedVersion,
} from '../boards/frontmatterWriteScheduler';
import { invokeOk } from '../utils/invokeOk';
import { reportError } from '../utils/errorBus';
import { documentStore } from '../../stores/document.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { parseMarkdown } from './vaultIndex';
import { onVaultSwap, vaultSwapResettable } from '../../core/vaultLifecycle';
import { getBaseline, noteBaseline, resetAllBaselines, hasBaselineDrifted, refreshBaselineAfterWrite } from './fileBaselineRegistry';
import { registerPathRenamable } from './renamePathKeys';
import { captureVaultIdentity, isStillSameVault } from './vaultIdentity';
import { getExternalEditPromptHandler } from './externalEditPrompt';
import { freshReadLooksTornMidFrontmatter } from './tornFrontmatterRead';

/**
 * Default 300ms idle debounce. Mirrors `FM_DEBOUNCE_MS` and the historical
 * TextTile / DocumentEditor / PropertiesPopup window so coalescing behaviour
 * is identical post-migration.
 */
export const MARKDOWN_WRITE_DEBOUNCE_MS = 300;

/**
 * Audit5 R3 — upper bound on a single markdown write, wired into the scheduler's
 * `writeTimeoutMs`. Re-exported from the dependency-free `boardWriteDebounce`
 * leaf (`WRITE_TIMEOUT_MS`) so the sibling schedulers can share the same bound
 * without the module-eval cycle through this file; see that constant's docstring
 * for the rationale. Kept under this name for back-compat with existing
 * references (the gate, file-size notes, tests).
 */
export const MARKDOWN_WRITE_TIMEOUT_MS = WRITE_TIMEOUT_MS;

/**
 * UTF-8 byte length of a string. The disk write encodes `fileText` as UTF-8,
 * so this equals the on-disk byte size of a clean self-write — used by the
 * Audit-7 L5 post-write baseline TOCTOU guard to tell our own bytes from a
 * foreign edit that landed in the write→stat gap.
 */
const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function utf8ByteLength(text: string): number {
  return utf8Encoder ? utf8Encoder.encode(text).length : text.length;
}

// Phase R6 — the Reload / Keep-local prompt-handler slot lives in the leaf
// `externalEditPrompt.ts` (Audit-16 split); re-exported for existing imports.
export { setExternalEditPromptHandler } from './externalEditPrompt';

export interface WriteArgs {
  /** Vault root the write targets. Validated against `vaultStore.path` indirectly via the IPC handler. */
  vaultRoot: string;
  /** Vault-relative path of the `.md` file. */
  relPath: string;
  /** Frontmatter to serialise. Optional: a `frontmatterDelta` caller omits it — the gateway sources FM from a fresh in-chain disk read (FILO-UR-1). */
  frontmatter?: Record<string, unknown>;
  /** Body to serialise. */
  body: string;
  /** Stable per-component identifier; scopes the debounce timer and dedupes flushes. */
  callerId: string;
  /**
   * Optional document id. When provided, the gateway bumps the frontmatter
   * scheduler's `lastFlushedVersion` after a successful write (to
   * `mutationVersionAtCapture` below, NOT the live post-IPC version).
   */
  docId?: string | null;
  /**
   * Audit-16 4.3 — the docId's mutation version captured by the CALLER when it
   * read the body/FM this write carries. The gateway records THIS value as
   * flushed on success, never the live post-IPC version — a mutation landing
   * mid-IPC would otherwise be marked flushed while the pre-mutation bytes
   * landed, and its follow-up scheduled write would skip as "stale" (never
   * reaching disk). Omitted → captured at `writeMarkdownFile` entry, exact for
   * callers that build args synchronously at fire time; the FM scheduler
   * threads its own capture (it awaits a hydrate before the gateway).
   */
  mutationVersionAtCapture?: number;
  /**
   * Audit-9 L5 — on-disk frontmatter SOURCE (raw bytes between the fences) for a
   * docId-less caller (orphan-card patch). With a docId the gateway reads it from the
   * document store; a docId-less write without it full-dumps (losing comments / key
   * order / quoting), so threading it lets `patchFrontmatterSourceCst` source-preserve.
   */
  originalFrontmatter?: string;
  /**
   * WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 — the delta-based write
   * source. When present, the gateway IGNORES `frontmatter` / the documentStore
   * cache as the FM source: it reads CURRENT disk in-chain, applies ONLY these
   * `set`/`unset` keys, and assembles against that same fresh read. So every key
   * the user did not touch — including an external addition the cache never saw —
   * is sourced from disk and preserved by construction (the root-cause fix for
   * the recurring untouched-key-drop class). Field-edit (Kanban/Task) and
   * Properties writes thread this; body-only editor saves do not (they keep the
   * open-editor-reconciled cache path).
   */
  frontmatterDelta?: FrontmatterDelta;
}

interface FileState {
  hadBom: boolean;
  /**
   * A8-M1 — the file's real line ending, sniffed once from the full raw file
   * content at hydrate time. Threaded into `assembleMarkdownFile({ eol })` so a
   * CRLF file with a single-line frontmatter keeps CRLF on a metadata edit
   * (detection from the FM source alone can't tell — a one-line FM has no
   * internal `\r\n`). `undefined` for in-memory hydrates with no disk read.
   */
  eol?: '\r\n' | '\n';
}
/**
 * Per-file state populated by `markHydrated()`. Without an entry here,
 * `writeMarkdownFile` throws — the caller hasn't run its hydrate routine,
 * which would mean any write here stamps an empty frontmatter on top of
 * whatever YAML the file currently has on disk.
 *
 * AUDIT13 Phase 7 L13 — DECISION: per-session growth is accepted (not
 * refcount-evicted on editor unmount). Entries are tiny ({hadBom, eol?}) and
 * cleared wholesale on every vault swap (cancelAllMarkdownWrites). Evicting on
 * last unmount was rejected: a wrong refcount in this gateway would drop live
 * hydrate state → a "not hydrated" throw or a BOM/eol regression on the next
 * write, for a few-KB upside. clearHydrated() already covers rename/delete.
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
  // Audit5 R3 — bound the await so a wedged write can't hang flushAll/save().
  writeTimeoutMs: MARKDOWN_WRITE_TIMEOUT_MS,
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
  return writerScheduler.hasPendingTimer((args) => vaultPath(args.relPath) === target);
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

/**
 * Audit-4 DI-09 — per-resolved-path write chain. `inFlightWrites` is keyed by
 * `callerId`, so two editors on one `.md` (TextTile + DocumentEditor) had
 * independent entries and could hit `vault:write-existing-file-text`
 * concurrently (OS-arbitrated order → loser's bytes silently clobbered). This
 * map serialises writes to a given normalized path; see `writeMarkdownFile`.
 */
// allow-module-state: drained synchronously by cancelAllMarkdownWrites at vault swap
const writeChainByPath = new Map<VaultPath, Promise<void>>();

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
  eol?: '\r\n' | '\n',
): void {
  if (!relPath) return;
  // A8-M1 — record the file's real eol when the caller sniffed it from the raw
  // disk content (only `readMarkdownForHydrate` does today). In-memory hydrates
  // pass none ⇒ the write path falls back to body/FM-source detection (LF for a
  // genuinely new file).
  fileState.set(relPath, { hadBom, eol });
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
  // A8-M1 — sniff the file's real eol from the FULL raw content (not the
  // fence-stripped FM block, which loses the signal for a single-line FM) and
  // thread it through so a later metadata edit re-applies CRLF to the FM block.
  const eol: '\r\n' | '\n' = result.content.includes('\r\n') ? '\r\n' : '\n';
  markHydrated(relPath, parsed.hadBom, result.mtimeMs, result.size, eol);
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
 *  3. Bump `frontmatterWriteScheduler.lastFlushedVersion` to the version
 *     captured when the write's content was read (Audit-16 4.3 — never the
 *     post-IPC live version) so concurrent writers don't overwrite stale.
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
  //
  // Audit-4 DI-09 — the per-resolved-path chaining lives in
  // `runSerializedMarkdownWrite` so the single-tag fast path can join the SAME
  // chain (Audit5 R2). `inFlightWrites` (keyed by callerId, for cancel/force
  // await) is layered on top here.
  //
  // Audit-16 4.3 — capture the mutation version BEFORE the chain wait (unless
  // the caller threaded an earlier capture): a mutation landing after this
  // point is newer than `args`, so the flushed-version bump must not cover it.
  const mutationVersionAtCapture =
    args.mutationVersionAtCapture ??
    (args.docId ? documentStore.getFrontmatterMutationVersion(args.docId) : 0);
  const promise = runSerializedMarkdownWrite(args.relPath, () =>
    writeMarkdownFileImpl({ ...args, mutationVersionAtCapture }),
  );
  inFlightWrites.set(args.callerId, promise);
  try {
    await promise;
  } finally {
    if (inFlightWrites.get(args.callerId) === promise) {
      inFlightWrites.delete(args.callerId);
    }
  }
}

/**
 * Audit-4 DI-09 / Audit5 R2 — runs `op` (a `.md` write) serialised behind any
 * in-flight write to the SAME resolved path, even one issued by a different
 * caller. Two views of one `.md` file (TextTile + DocumentEditor), or the
 * single-tag fast path racing an editor body write, would otherwise both hit
 * `vault:write-existing-file-text` concurrently — the OS arbitrates the order
 * and the loser's bytes are silently clobbered.
 *
 * The prior chained promise is awaited for ORDERING only; its rejection is
 * swallowed (it carries its own failure attribution via `trackComponentWrite`).
 * `op` should perform its OWN read inside the callback when it does a
 * read-modify-write, so it observes the bytes the prior chained write landed.
 * Exposed so non-gateway `.md` writers (the tag fast path) can enrol without
 * re-implementing the chain.
 */
export async function runSerializedMarkdownWrite(
  relPath: string,
  op: () => Promise<void>,
): Promise<void> {
  const pathKey = vaultPath(relPath);
  const prior = writeChainByPath.get(pathKey);
  const promise = (async () => {
    if (prior) await prior.catch(() => undefined);
    await op();
  })();
  writeChainByPath.set(pathKey, promise);
  try {
    await promise;
  } finally {
    if (writeChainByPath.get(pathKey) === promise) {
      writeChainByPath.delete(pathKey);
    }
  }
}

/**
 * 6.4.M17 — swap-safe final write for component teardown (TextTile.onDestroy).
 *
 * A destroyed tile flushes its live editor's last edit, but a vault swap may
 * have already reset the gateway (`cancelAllMarkdownWrites` clears the per-file
 * hydrate state). Calling `writeMarkdownFile` directly in that window throws
 * "not hydrated" — a stray write attempt + error report during teardown that
 * BYPASSES the swap reset the cancel was meant to enforce. This entry point
 * respects the reset: when the file is no longer hydrated the gateway has been
 * torn down (and the swap's own flush already persisted the scheduled bytes),
 * so the final write is skipped instead of throwing.
 */
export async function flushFinalWriteOnDestroy(args: WriteArgs): Promise<void> {
  if (!isHydrated(args.relPath)) return;
  await writeMarkdownFile(args);
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

  // A9-L8 — snapshot the vault identity BEFORE the (possibly long) drift prompt
  // and the write await below, so the post-write renderer-state bookkeeping can
  // detect a vault swap that landed in either window and skip mutating the NEW
  // vault's index / drift baseline / FM-version for `relPath`.
  const writeIdentity = captureVaultIdentity();

  // Phase R6 — pre-write drift check. If the file's mtime on disk
  // differs from the baseline captured at hydrate-time (or after the
  // most recent self-write), an external editor wrote to the file
  // since we last knew about it. Surface the Reload / Keep-local
  // prompt so the user explicitly chooses whether to clobber the
  // external bytes — never silently overwrite. No baseline → no
  // comparison anchor, fall through to the legacy unguarded write
  // path (e.g. first write to a freshly-seeded file).
  const baseline = getBaseline(relPath);
  // 5.2 (Audit-16) — the last disk stat the drift decision TRUSTED (the
  // pre-write stat, or the post-prompt re-stat the user approved). The delta
  // branch re-stats after its in-chain read and verifies against this anchor,
  // so an external write landing in the stat→read gap — invisible to the drift
  // check, and a torn/stale read of it would be written back verbatim as the
  // delta body — aborts loudly instead. Undefined ⇒ no anchor, verify skipped.
  let preWriteVerifyStat: { mtimeMs: number; size: number } | undefined;
  if (baseline !== undefined) {
    let preWriteStat: { mtimeMs: number; size: number } | undefined;
    try {
      preWriteStat = await invokeOk('vault:stat', vaultRoot, relPath);
    } catch {
      // Stat failed (ENOENT, EACCES, NO_ACTIVE_VAULT). Fall through —
      // the IPC below will surface the same shape via trackComponentWrite.
    }
    preWriteVerifyStat = preWriteStat;
    if (preWriteStat !== undefined && hasBaselineDrifted(baseline, preWriteStat)) {
      // 6.4.M13 — the Reload / Keep-local prompt is async, so the file can
      // drift AGAIN while the modal is open. After each 'keep-local',
      // re-stat: if the bytes the user agreed to overwrite changed since they
      // were shown the prompt, re-prompt so an external edit the user never
      // saw is never silently clobbered. Bounded to avoid a livelock against a
      // rapid external writer; on exhaustion, abort (the next debounced write
      // re-detects the drift and prompts again with the latest state).
      const handler = getExternalEditPromptHandler();
      const MAX_DRIFT_REPROMPTS = 3;
      let approved = false;
      let shownStat = preWriteStat;
      for (let attempt = 0; attempt < MAX_DRIFT_REPROMPTS; attempt++) {
        const choice = handler ? await handler(relPath) : 'keep-local';
        if (choice === 'reload') {
          // The Reload handler refreshed the vault index + editor content
          // from disk and re-stamped the drift baseline (applyReloadFromDisk
          // → noteBaseline, threaded from the read). Drop this scheduled
          // write — the user explicitly chose to discard their pending bytes.
          return;
        }
        if (choice === 'defer') {
          // 6.4.M4 — dismissed without choosing (auto-dismiss or manual
          // close). Neither side was touched; abort so the external edit on
          // disk survives, and let the dirty in-memory state persist so the
          // next debounced write re-prompts. No baseline refresh.
          //
          // Audit-6 M1 — a bare `return` here resolved performWrite as SUCCESS,
          // so the scheduler's `safeEndWrite(true)` dropped the path from
          // pending and `syncSentinelIfIdle` markClean'd `.filo/.dirty` (the
          // path was never in failedVaultPaths). The editor stayed dirty but
          // disk was unchanged → quit lost the edit with a CLEAN sentinel (no
          // recovery prompt). Mirror frontmatterWriteScheduler DI-13:
          // markPathFailed keeps the sentinel dirty + the indicator showing
          // error, and the throw attributes the path to flushAll().failed so
          // save() returns false instead of flashing "Saved".
          markPathFailed(vaultRoot, relPath);
          throw new Error(
            `markdownFileWriter: write to "${relPath}" deferred — external edit on disk unresolved; not overwritten`,
          );
        }
        // 'keep-local' — the user chose to overwrite. Confirm nothing drifted
        // while the modal was open before committing the clobber.
        let recheckStat: { mtimeMs: number; size: number } | undefined;
        try {
          recheckStat = await invokeOk('vault:stat', vaultRoot, relPath);
        } catch {
          // Re-stat failed — can't confirm a second drift. Proceed with the
          // overwrite as the pre-M13 code did; the write IPC below surfaces
          // any genuine IO error through the failure-attribution pipeline.
          recheckStat = undefined;
        }
        if (
          recheckStat === undefined ||
          (recheckStat.mtimeMs === shownStat.mtimeMs && recheckStat.size === shownStat.size)
        ) {
          approved = true;
          // 5.2 — the approval re-anchors the verify stat: the user agreed to
          // overwrite the bytes recheckStat observed. A failed re-stat keeps
          // the legacy proceed-without-confirmation decision — no anchor.
          preWriteVerifyStat = recheckStat;
          break;
        }
        // The file drifted again during the prompt — loop to re-prompt against
        // the freshly-observed state rather than overwrite bytes never shown.
        shownStat = recheckStat;
      }
      if (!approved) {
        // Re-prompt budget exhausted against a churning external writer. Abort
        // rather than clobber an unseen edit; the next debounced write
        // re-detects the drift and prompts again.
        //
        // Audit-6 M1 — same silent-loss-with-clean-sentinel hazard as the
        // 'defer' branch above: a bare `return` reported success and let the
        // sentinel be markClean'd while the dirty edit never reached disk.
        // markPathFailed + throw keeps `.filo/.dirty` alive and surfaces the
        // failure to save()'s aggregate boolean.
        markPathFailed(vaultRoot, relPath);
        throw new Error(
          `markdownFileWriter: write to "${relPath}" aborted — external edit kept churning across drift re-prompts; not overwritten`,
        );
      }
    }
  }

  // Audit-11 N1 — toast when an assemble below REFUSES a frontmatter edit over
  // unparseable on-disk YAML (the block is kept verbatim, the edit dropped), so
  // it doesn't vanish as a silent success. Stable `kind` → errorBus coalesces.
  const onFrontmatterRefused = (): void => {
    reportError(
      'frontmatter.unparseable',
      null,
      `Couldn't update metadata for "${relPath}" — its YAML frontmatter is malformed, so the change wasn't saved. Fix the frontmatter in that file to re-enable metadata edits.`,
    );
  };
  let fileText: string;
  const delta = args.frontmatterDelta;
  if (delta) {
    // Phase 4 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — delta-on-fresh-disk
    // write source. We are inside `runSerializedMarkdownWrite`, so this read
    // observes the bytes any prior chained write to THIS path already landed.
    // Apply ONLY the delta keys to the fresh disk frontmatter and assemble
    // against the SAME fresh source: `nextFm` and `originalFrontmatter` derive
    // from one read, so the CST engine rewrites only the changed keys and emits
    // every untouched key — including an external addition the in-memory cache
    // never saw — byte-for-byte from disk. This is the root-cause fix: the
    // cache can no longer be the write source, so a stale / over-cleaned / empty
    // cache can't silently drop a key.
    let parsedFresh: ReturnType<typeof parseMarkdownFile>;
    let freshContent: string;
    try {
      const fresh = await invokeOk('vault:read-file-text', vaultRoot, relPath);
      freshContent = fresh.content;
      parsedFresh = parseMarkdownFile(freshContent);
    } catch (err) {
      // The backing `.md` is gone/unreadable between the caller's hydrate read
      // and this in-chain read (ENOENT, EACCES). Surface the loss (sentinel +
      // indicator) and propagate so `flushAll().failed` attributes `relPath` —
      // never resurrect a deleted file from a stale in-memory snapshot. Mirrors
      // the frontmatter scheduler's DI-13 no-editor read-failure handling.
      markPathFailed(vaultRoot, relPath);
      throw err;
    }
    // 3.3 (Audit-14) — guard a TRUNCATED/partial in-chain read from silently
    // dropping the on-disk frontmatter: assembling the delta against a read
    // whose closing fence is missing would emit ONLY the delta keys + the
    // truncated body. Prior-indexed FM block + fresh read parsed none + raw
    // still opens with `---` → read anomaly, markPathFailed + throw (next
    // debounce retries). Heuristic scope documented on the helper.
    if (!parsedFresh.hasFrontmatter && freshReadLooksTornMidFrontmatter(relPath, freshContent)) {
      markPathFailed(vaultRoot, relPath);
      throw new Error(
        `markdownFileWriter: refusing delta write to "${relPath}" — fresh read opens with a ` +
        `frontmatter fence but has no closing fence (likely a partial read of an in-progress ` +
        `external write); not overwriting so the on-disk frontmatter is not dropped`,
      );
    }
    // 5.2 (Audit-16) — the 3.3 guard catches only the torn-MID-FRONTMATTER
    // shape; a torn/stale BODY in the fresh read parses cleanly and would be
    // written back verbatim as `deltaBody` for the common no-live-editor case
    // (the pre-write drift stat ran BEFORE this read, so a write landing in the
    // stat→read gap is invisible to it, and the post-write baseline then adopts
    // our bytes — suppressing later detection). Re-stat and verify the file is
    // still exactly the one the drift decision trusted; on mismatch abort
    // loudly (the next debounced write re-detects the drift and prompts).
    if (preWriteVerifyStat !== undefined) {
      let postReadStat: { mtimeMs: number; size: number } | undefined;
      try {
        postReadStat = await invokeOk('vault:stat', vaultRoot, relPath);
      } catch {
        // Can't re-stat (transient IO) while the read itself succeeded —
        // proceed as the pre-verify code did rather than wedge on a stat hiccup.
      }
      if (
        postReadStat !== undefined &&
        (postReadStat.mtimeMs !== preWriteVerifyStat.mtimeMs ||
          postReadStat.size !== preWriteVerifyStat.size)
      ) {
        markPathFailed(vaultRoot, relPath);
        throw new Error(
          `markdownFileWriter: refusing delta write to "${relPath}" — the file changed on disk ` +
          `between the pre-write drift check and the in-chain read (the read may be torn or ` +
          `stale); not overwriting an edit the drift prompt never showed`,
        );
      }
    }
    const nextFm = applyFrontmatterDelta(parsedFresh.frontmatter, delta);
    // 3.2 (Audit-14) — derive the EOL from the SAME fresh in-chain read that
    // sources the FM + BOM, not the hydrate-time `state.eol` snapshot. If an
    // external editor converted LF↔CRLF since hydrate, the stale snapshot would
    // emit mixed EOLs (the FM bytes are fresh but `detectFrontmatterEol` honours
    // the stale `options.eol`). Sniff CRLF/LF from the fresh content; fall back
    // to `state.eol` only for an empty file (no EOL signal at all).
    const freshEol: '\r\n' | '\n' | undefined =
      freshContent.length === 0 ? state.eol : freshContent.includes('\r\n') ? '\r\n' : '\n';
    // Audit-11 N2 / Audit-15 P1.4 — pick the body source. The delta path carries
    // only FIELD/FM edits (none touch the body), so the body is just "re-emit the
    // rest of the file". With a LIVE editor open for this docId, the caller's
    // `body` is its un-debounced live text and MUST win (swapping in
    // `parsedFresh.body` would drop unsaved keystrokes) — the N2 invariant. With
    // NO live editor (orphan / Kanban card / Mind-Map tile never opened as a doc
    // tab), the caller's `body` is a watcher-index SNAPSHOT an unreliable
    // `fs.watch` may have left stale (it missed an external body edit). A missed
    // watcher event also left the drift baseline un-updated, so the pre-write stat
    // can't catch it and the snapshot body would silently revert the external
    // edit — so source the fresh in-chain disk `parsedFresh.body` instead. The
    // `getDocument(docId)` presence check mirrors PropertiesPopup's own
    // `docState?.body ??` source decision, so the two agree on which case applies.
    const hasLiveEditorBody = docId ? documentStore.getDocument(docId) !== undefined : false;
    const deltaBody = hasLiveEditorBody ? body : parsedFresh.body;
    fileText = assembleMarkdownFile(nextFm, deltaBody, {
      // Audit-11 N3 — BOM flag from THIS in-chain read (not the pre-write
      // `state.hadBom` snapshot), so a BOM an external editor added/stripped
      // since hydrate is honoured rather than re-imposing the stale mark.
      bom: parsedFresh.hadBom,
      // Both the clean-passthrough source AND the source-preserving baseline are
      // the fresh in-chain read. An empty delta (e.g. a body-only write routed
      // with a no-op delta) then emits the disk FM verbatim; a non-empty delta
      // patches only the changed keys against the same fresh source.
      rawFrontmatter: parsedFresh.rawFrontmatter,
      frontmatterDirty: !isEmptyFrontmatterDelta(delta),
      originalFrontmatter: parsedFresh.rawFrontmatter,
      // 3.2 (Audit-14) — fresh-read EOL, not the stale hydrate snapshot.
      eol: freshEol,
      onFrontmatterRefused,
    });
  } else {
    // ── Cache-FM path (body-only editor saves + legacy callers) ──
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
    let fm = (docId ? documentStore.getFrontmatter(docId) : undefined) ?? args.frontmatter ?? {};
    // Audit-10 H2 — never assemble a body-only write against an EMPTY /
    // never-seeded FM cache: that strips an on-disk YAML block. The TextTile
    // "adopt sibling doc" branch deliberately flips hydrated=true WITHOUT seeding
    // FM (re-parsing the body-only sibling body would yield {} and clobber the
    // real cache a sibling already seeded), so a docId can reach here with no
    // cache entry while the file on disk still carries frontmatter — and `fm`
    // collapses to `{}`, deleting it. `hasFrontmatter` distinguishes never-seeded
    // (re-read disk) from a deliberate `{}` seed (a genuinely-empty FM — trust
    // it). We are inside runSerializedMarkdownWrite, so this read observes any
    // prior chained write; seeding the cache then routes the assemble below
    // through the verbatim `rawFrontmatter` path, preserving the block
    // byte-for-byte (and fixing the cache for later saves + the live display).
    const cacheHasFm = docId ? documentStore.hasFrontmatter(docId) : false;
    const argsFmEmpty = !args.frontmatter || Object.keys(args.frontmatter).length === 0;
    if (docId && !cacheHasFm && argsFmEmpty) {
      let readResult: { content: string } | undefined;
      try {
        readResult = await invokeOk('vault:read-file-text', vaultRoot, relPath);
      } catch {
        // ENOENT / EACCES — a genuinely new (or vanished) file. Keep fm = {}; the
        // body-only assemble then emits no FM (correct for a new file) and the
        // `vault:write-existing-file-text` IPC below surfaces a real missing-file
        // failure through trackComponentWrite rather than this read swallowing it.
      }
      if (readResult !== undefined) {
        const parsed = parseMarkdownFile(readResult.content);
        // 5.3 (Audit-16) — same torn-read guard as the delta branch: a partial
        // read (opening fence, no closing fence) parses as "no frontmatter", and
        // pre-guard the assemble would strip the on-disk YAML block AND the bogus
        // `{}` seed was CACHED — poisoning every later save for this docId, not
        // just this one. Thrown OUTSIDE the try so the ENOENT swallow above
        // can't eat it; markPathFailed keeps the sentinel dirty and attributes
        // the path to flushAll().failed (next debounce retries clean).
        if (!parsed.hasFrontmatter && freshReadLooksTornMidFrontmatter(relPath, readResult.content)) {
          markPathFailed(vaultRoot, relPath);
          throw new Error(
            `markdownFileWriter: refusing body-only write to "${relPath}" — the cache-seed read ` +
            `opens with a frontmatter fence but has no closing fence (likely a partial read of ` +
            `an in-progress external write); not seeding {} or stripping the on-disk frontmatter`,
          );
        }
        documentStore.setFrontmatter(docId, parsed.frontmatter, parsed.rawFrontmatter);
        fm = parsed.frontmatter;
      }
    }
    if (docId) {
      // M1 — version map is keyed by docId so this comparison stays in the
      // same version space as `getFrontmatterMutationVersion(docId)`.
      //
      // Audit-4 DI-17 — this `lastFlushed > cacheVersion` re-read is believed
      // UNREACHABLE under M1's docId keying: `lastFlushed` is only ever bumped
      // (here and in `frontmatterWriteScheduler`) to a PAST value of the
      // monotonically-increasing per-docId mutation counter, so it can never
      // exceed the current `cacheVersion`. It is retained, NOT deleted, as cheap
      // defense-in-depth — a unit test can't construct the inputs to exercise it,
      // and a stale-cache re-read guard isn't worth pulling out of a data-
      // integrity write path for marginal cleanup. If a future change ever lets
      // `lastFlushed` outrun `cacheVersion` (e.g. docId reuse with a reset
      // counter), this re-read is the safety net that re-syncs from disk.
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
    // re-dumping the whole object. Audit-9 L5 — a docId-less orphan patch threads
    // the disk source via `args.originalFrontmatter`; the cache source wins with a docId.
    const originalFrontmatter = docId
      ? documentStore.getOriginalFrontmatterSource(docId)
      : args.originalFrontmatter;
    fileText = assembleMarkdownFile(fm, body, {
      bom: state.hadBom,
      rawFrontmatter,
      frontmatterDirty: rawFrontmatter === undefined,
      originalFrontmatter,
      // A8-M1 — the file's real eol, sniffed at hydrate time. Wins over FM-source
      // detection so a single-line-FM CRLF file keeps CRLF on a metadata edit even
      // when the body is LF (editor) and the FM source has no internal `\r\n`.
      eol: state.eol,
      // Audit-11 N1 — same unparseable-YAML toast for the cache-FM (Properties /
      // dirty-FM) path.
      onFrontmatterRefused,
    });
  }
  // Audit-7 L5 — capture the exact byte length we're about to write so the
  // post-write baseline stamp below can reject a stat that observed a FOREIGN
  // edit instead of our bytes (see the TOCTOU guard at the post-write stat).
  const writtenByteLength = utf8ByteLength(fileText);
  await trackComponentWrite(vaultRoot, relPath, async () => {
    await invokeOk('vault:write-existing-file-text', vaultRoot, relPath, fileText);
  });
  // A9-L8 — the IPC above committed against whatever vault was active when it
  // ran (main's `assertActiveVault`). If a vault swap landed during the drift
  // prompt or the write await, the post-write renderer-state bookkeeping below
  // (drift baseline, vault index, FM flushed-version, markClean) must NOT run
  // against the NEW vault: stamping the outgoing vault's metadata/baseline for
  // `relPath` could suppress a legitimate drift check or inject stale metadata
  // for a same-named file in the new vault. Skip it on a swap — the new vault
  // self-heals from its own hydrate/watcher, and the baseline registry was
  // already wiped wholesale by the swap (re-stamping it here would resurrect a
  // cross-vault entry). (markClean is already a no-op post-swap since the doc
  // was cleared; the guard makes the whole tail coherent.)
  if (!isStillSameVault(writeIdentity)) return;
  // Phase R6 — refresh the baseline to the post-write mtime so a
  // late watcher echo (or the next debounced write) compares against
  // the state we just wrote, not the pre-write state.
  // Audit-4 DI-14 — on an unusable post-write stat KEEP the prior baseline
  // (reverting 6.4.M2's clear). A stat failure then surfaces at worst a
  // spurious drift prompt on the NEXT write — which the user dismisses with
  // Keep-local — instead of disabling the drift check and opening a silent-
  // overwrite window. See `refreshBaselineAfterWrite` for the full trade-off.
  try {
    const postStat = await invokeOk('vault:stat', vaultRoot, relPath);
    // Audit-7 L5 — TOCTOU guard. An external edit can land between the write
    // IPC resolving and THIS stat resolving, so `postStat` may reflect FOREIGN
    // (mtime,size). Only stamp the baseline when the stat's size matches the
    // bytes we just wrote; a mismatch means the stat observed someone else's
    // write, so KEEP the prior baseline (DI-14) and let the next write's drift
    // check re-detect + prompt rather than silently adopting the foreign size
    // (which would make the next write match-and-clobber the external edit).
    if (postStat.size === writtenByteLength) {
      refreshBaselineAfterWrite(relPath, postStat.mtimeMs, postStat.size);
    } else {
      refreshBaselineAfterWrite(relPath, undefined, undefined);
    }
  } catch {
    refreshBaselineAfterWrite(relPath, undefined, undefined);
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
    // Audit-16 4.3 — record the CAPTURED version (what the assembled body/FM
    // correspond to), never the live post-IPC counter, which would mark a
    // mid-IPC mutation as flushed and let its follow-up write skip as stale.
    noteFrontmatterFlushedVersion(docId, args.mutationVersionAtCapture ?? 0);
  }

  // Audit-7 M1 — a successful write clears THIS writer's dirty entry so a
  // normally-saved editor goes clean. Without it the writerId lingered in
  // `documentStore.dirtyWriters` forever (only reload / unload / vault-swap
  // removed it), pinning `isDirty` true → a spurious "modified externally"
  // prompt for a now-saved file and a frozen sibling reload `$effect`. Covers
  // TextTile + DocumentEditor in one place. Guarded on `hasPending`: if the user
  // typed again mid-write a newer timer is armed for this caller, so leave it
  // dirty (that write clears it) rather than flash a transient clean window an
  // external-edit reconciler could misread into a silent reload of the unsaved
  // keystrokes. Cheap + side-effect-free — `scheduleMarkdownWrite` stores a
  // stable `() => args` getter, so `hasPendingTimer` only reads the already-built args.
  if (docId && !writerScheduler.hasPendingTimer((pendingArgs) => pendingArgs.callerId === callerId)) {
    documentStore.markClean(docId, callerId);
  }
  // Audit-11 WC-2 — deliberately NOT also gated on a pending FM write for this
  // path: the save indicator reads the write LEDGER (the FM scheduler is
  // `sentinelMode:'full'`, so its pending writes already count there), and the
  // sole `isDirty`-field reader (`conflictResolver`) is downstream-guarded by
  // F4 `isPathPending` (which sees the FM write). Gating here would instead
  // STRAND this body callerId (the FM write clears only its own callerId) —
  // re-opening the Audit-7 M1 "pinned dirty" hole. Correct as-is.
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
    const entry = snapshot[i];
    if (result && entry && result.status === 'rejected') {
      failed.push({ ownerId: entry[0], error: result.reason });
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
  // Audit-4 DI-09 — drop the per-path write chains too so the new vault's
  // first write to a same-named path doesn't chain behind an outgoing-vault
  // write that's still settling.
  writeChainByPath.clear();
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
    const target = targets[i];
    if (!result || !target) continue;
    const [ownerId] = target;
    if (result.status === 'fulfilled') ok++;
    else failed.push({ ownerId, error: result.reason });
  }
  for (let i = 0; i < testSettled.length; i++) {
    const result = testSettled[i];
    const match = testMatches[i];
    if (!result || !match) continue;
    const [ownerId] = match;
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

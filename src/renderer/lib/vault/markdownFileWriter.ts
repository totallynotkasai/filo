/**
 * markdownFileWriter — canonical write path for `.md` files. Every writer
 * (TextTile, DocumentEditor, PropertiesPopup, frontmatterWriteScheduler, the
 * orphan-fm commands) routes through here:
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
import { getLastFlushedFrontmatterVersion } from '../boards/frontmatterWriteScheduler';
import { invokeOk } from '../utils/invokeOk';
import { noteReadEncoding } from './nonUtf8Paths.svelte';
import { reportError } from '../utils/errorBus';
import { documentStore } from '../../stores/document.svelte';
import { onVaultSwap, vaultSwapResettable } from '../../core/vaultLifecycle';
import { getBaseline, noteBaseline, resetAllBaselines, hasBaselineDrifted } from './fileBaselineRegistry';
import { confirmPostWriteBaseline, finishWriteBookkeeping, MARKDOWN_READBACK_BYTE_THRESHOLD } from './markdownPostWrite';
import { registerPathRenamable } from './renamePathKeys';
import { captureVaultIdentity, isStillSameVault } from './vaultIdentity';
import { freshReadLooksTornMidFrontmatter } from './tornFrontmatterRead';
import { runPreWriteDriftGate } from './preWriteDriftGate';

/** Default 300ms idle debounce (matches `FM_DEBOUNCE_MS`). */
export const MARKDOWN_WRITE_DEBOUNCE_MS = 300;

/**
 * Upper bound on a single markdown write, wired into the scheduler's
 * `writeTimeoutMs`. Defined in the dependency-free `boardWriteDebounce` leaf so
 * sibling schedulers share it without an import cycle through this file.
 */
export const MARKDOWN_WRITE_TIMEOUT_MS = WRITE_TIMEOUT_MS;

/**
 * UTF-8 byte length of a string. The disk write encodes `fileText` as UTF-8,
 * so this equals the on-disk byte size of a clean self-write — used by the
 * post-write baseline guard to tell our own bytes from a foreign edit that
 * landed in the write→stat gap.
 */
const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function utf8ByteLength(text: string): number {
  return utf8Encoder ? utf8Encoder.encode(text).length : text.length;
}

export { MARKDOWN_READBACK_BYTE_THRESHOLD };

// The Reload / Keep-local prompt-handler slot lives in the leaf
// `externalEditPrompt.ts`; re-exported for existing imports.
export { setExternalEditPromptHandler } from './externalEditPrompt';

export interface WriteArgs {
  /** Vault root the write targets. Validated against `vaultStore.path` indirectly via the IPC handler. */
  vaultRoot: string;
  /** Vault-relative path of the `.md` file. */
  relPath: string;
  /** Frontmatter to serialise. Optional: a `frontmatterDelta` caller omits it — the gateway sources FM from a fresh in-chain disk read. */
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
   * The docId's mutation version captured by the CALLER when it read the
   * body/FM this write carries. Recorded as flushed on success instead of the
   * live post-IPC version — otherwise a mutation landing mid-IPC is marked
   * flushed and its follow-up write skips as "stale". Omitted → captured at
   * `writeMarkdownFile` entry.
   */
  mutationVersionAtCapture?: number;
  /**
   * On-disk frontmatter SOURCE (raw bytes between the fences) for a docId-less
   * caller (orphan-card patch). With a docId the gateway reads it from the
   * document store; without it a docId-less write full-dumps (losing comments /
   * key order / quoting).
   */
  originalFrontmatter?: string;
  /**
   * Delta-based write source. When present, the gateway ignores `frontmatter`
   * and the documentStore cache: it reads current disk in-chain, applies only
   * these `set`/`unset` keys, and assembles against that same read — so every
   * untouched key (including an external addition the cache never saw) is
   * preserved by construction. Field-edit and Properties writes use this;
   * body-only editor saves do not.
   */
  frontmatterDelta?: FrontmatterDelta;
  /**
   * Whether `body` came from a live editor when the args were built. A live body
   * wins over the in-chain disk read (it holds un-debounced keystrokes); a snapshot
   * body loses to it (may be stale). Captured at fire time because the doc can
   * load/unload during the write. Omitted → derived from `docId`.
   */
  bodyIsLive?: boolean;
}

interface FileState {
  hadBom: boolean;
  /**
   * The file's real line ending, sniffed once from the full raw file
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
 * DECISION: per-session growth is accepted (no refcount eviction on editor
 * unmount). Entries are tiny and cleared on every vault swap; a wrong refcount
 * would drop live hydrate state (a "not hydrated" throw or BOM/eol regression).
 * clearHydrated() covers rename/delete.
 */
const fileState = new Map<string, FileState>();

/**
 * `sentinelMode: 'pending-path'`: `writeMarkdownFile` already wraps its IPC in
 * `trackComponentWrite` (which bumps the INFLIGHT counter), so the scheduler
 * must not also bump inflight. It tracks only the pending PATH during the
 * debounce window, so a crash mid-typing still leaves a `.filo/.dirty`
 * sentinel and the save indicator doesn't read a premature "idle".
 *
 * FailureId is the callerId, matching `FlushAllResult.failed: [{ ownerId, error }]`.
 */
const writerScheduler = createScheduler<WriteArgs>({
  name: 'markdownFileWriter',
  debounceMs: 300, // Default; per-call delay override supported.
  performWrite: (args) => writeMarkdownFile(args),
  getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: args.relPath }),
  getFailureId: (args) => args.callerId,
  sentinelMode: 'pending-path',
  // Bound the await so a wedged write can't hang flushAll/save().
  writeTimeoutMs: MARKDOWN_WRITE_TIMEOUT_MS,
});

// Probe so `isPathPending` also reports this scheduler's armed-but-not-fired
// writes, keeping the external-change reconcilers' dirty-check honest for a
// debounced editor-body write. In-flight writes already show up in the ledger.
registerPendingProbe((path) => {
  const target = vaultPath(path);
  // Also consult PARKED fires (in neither `pending` nor `inFlight` while
  // draining); belt-and-suspenders, since the pending-path ledger already
  // keeps `isPathPending` true across the park.
  return (
    writerScheduler.hasPendingTimer((args) => vaultPath(args.relPath) === target) ||
    writerScheduler.hasParked((info) => info.path !== undefined && vaultPath(info.path) === target)
  );
});

/** A newer write for `callerId` is armed (timer) or parked (fired, draining). */
function hasNewerWriteForCaller(callerId: string): boolean {
  return (
    writerScheduler.hasPendingTimer((a) => a.callerId === callerId) ||
    writerScheduler.hasParked((info) => info.key === callerId)
  );
}

/**
 * True when `callerId` still has unsaved work in the gateway:
 * an armed debounce, a parked fire, or a write in flight. TextTile's onDestroy
 * uses it (with the writer's dirty flag) to write ONLY when there is something
 * to save, instead of on every unmount (culling, LOD, board/tab switch).
 */
export function hasPendingMarkdownWriteFor(callerId: string): boolean {
  return hasNewerWriteForCaller(callerId) || inFlightWrites.has(callerId);
}

/**
 * callerId → fresh-args callback. Editor-backed writers (TextTile,
 * DocumentEditor) register a callback that returns the LATEST args (live
 * editor body + current frontmatter) so Keep-local flushes exactly what the
 * user sees, not a stale schedule snapshot.
 *
 * Non-editor callers (PropertiesPopup, orphan-fm sites) don't need to
 * register here — they always call `writeMarkdownFile` / `scheduleMarkdownWrite`
 * with fresh args inline.
 */
interface ForceWriter {
  docId: string | null;
  build: () => WriteArgs | null;
}
const forceWriters = new Map<string, ForceWriter>();

/**
 * In-flight write tracker keyed by `callerId`, populated for the lifetime of
 * each `writeMarkdownFile` call. A force-write can arrive after the debounce
 * timer already fired (so cancelling it is a no-op); it must await this entry
 * first, or the two writes race and the OS-ordered loser clobbers the winner.
 */
// allow-module-state: drained synchronously by cancelAllMarkdownWrites at vault swap
const inFlightWrites = new Map<string, Promise<void>>();

/**
 * Per-resolved-path write chain. `inFlightWrites` is keyed by `callerId`, so
 * two editors on one `.md` (TextTile + DocumentEditor) could otherwise write
 * concurrently and the OS-ordered loser's bytes would be clobbered. This map
 * serialises writes to a given normalized path; see `writeMarkdownFile`.
 */
// allow-module-state: drained synchronously by cancelAllMarkdownWrites at vault swap
const writeChainByPath = new Map<VaultPath, Promise<void>>();

/**
 * Last write failure per callerId; `flushMarkdownWrite` hands
 * it (e.g. ENOENT) to the flushing component, since `fireWrite` never rejects.
 * Cleared at write START (a stale error must not be misattributed to a later
 * timeout whose IPC is still in flight) and on vault swap.
 */
// allow-module-state: drained synchronously by cancelAllMarkdownWrites at vault swap
const lastWriteFailureByCaller = new Map<string, unknown>();

// ── Hydrate gate ──

/**
 * Marks `relPath` as hydrated for the writer pipeline and records its BOM
 * status so subsequent writes can re-emit the leading `EF BB BF` byte
 * sequence (preserving Notepad-saved files round-trip).
 *
 * `mtimeMs` + `size` (optional) stamp the file's baseline so the pre-write
 * drift check inside `writeMarkdownFile` can detect external edits landing
 * between hydrate and the next debounced write. Both are needed; passing one
 * without the other seeds nothing (see `noteBaseline`).
 *
 * `boardCache.syncTileMarkdown` deliberately does NOT thread it: that path
 * runs its own pre-read / pre-write stat guard, so seeding a baseline here
 * would risk a redundant Reload prompt on the same external edit.
 *
 * Callers without an mtime (in-memory hydrate, fresh-file creation) leave
 * the baseline empty — the drift check no-ops until the first successful
 * write's post-write stat seeds it.
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
  /** The exact bytes just read (small notes only); see FileBaseline.text. */
  diskText?: string,
): void {
  if (!relPath) return;
  // Record the file's real eol when the caller sniffed it from the raw
  // disk content (only `readMarkdownForHydrate` does today). In-memory hydrates
  // pass none ⇒ the write path falls back to body/FM-source detection (LF for a
  // genuinely new file).
  fileState.set(relPath, { hadBom, eol });
  if (mtimeMs !== undefined) noteBaseline(relPath, mtimeMs, size, diskText);
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
 * Transfer the hydrate state from `oldRel` to `newRel` (and descendants, for
 * folder renames) so a post-rename body write doesn't throw "not hydrated"
 * against the new path. Registered with `renameAllPathKeys` below.
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
   * Verbatim frontmatter source bytes (empty when none). Seed
   * it into `documentStore.setFrontmatter` so a later body-only save can emit
   * the block untouched instead of re-dumping the parsed object.
   */
  rawFrontmatter: string;
  /** Markdown body with frontmatter stripped. */
  body: string;
}

/**
 * The single sanctioned way to read a `.md` file *for the purpose of
 * hydrating* an editor or cache.
 *
 * The drift baseline is only seeded when a hydrate threads the read's
 * `mtimeMs` into `markHydrated`; a site that forgets leaves the pre-write
 * drift check a no-op, so an external edit gets silently overwritten.
 * This gateway does the read + parse + `markHydrated(relPath, hadBom,
 * mtimeMs)` in one place, so the content and the baseline always come from
 * the SAME `vault:read-file-text` call (no read/stat TOCTOU gap) and a
 * hydrate can never land without its baseline. `scripts/gates:markdown-read-gateway`
 * forbids any file from pairing a direct `vault:read-file-text` invoke with
 * a `markHydrated` call, so a future disk-read hydrate site must route here.
 *
 * Throws on read failure (the `invokeOk` envelope contract). Callers that
 * need a graceful fallback — mount-with-empty-content (DocumentEditor),
 * fall-back-to-embedded-content (TextTile), or proceed-and-let-the-write-
 * ENOENT (frontmatter scheduler / orphan-fm commands) — wrap this in a
 * try/catch and run their own in-memory `markHydrated(relPath, false)`
 * fallback. Those in-memory (no-disk-read) hydrates stay legal because they
 * pass no `mtimeMs` and seed no baseline.
 */
export async function readMarkdownForHydrate(
  vaultRoot: string,
  relPath: string,
): Promise<HydrateReadResult> {
  const result = await invokeOk('vault:read-file-text', vaultRoot, relPath);
  const parsed = parseMarkdownFile(result.content);
  noteReadEncoding(relPath, result.encoding); // a non-UTF-8 note opens non-editable
  // Sniff the real eol from the FULL raw content (a single-line FM's
  // fence-stripped block loses the signal) so a metadata edit re-applies CRLF.
  const eol: '\r\n' | '\n' = result.content.includes('\r\n') ? '\r\n' : '\n';
  // Keep small notes' read bytes as the confirmed baseline text (unchanged re-emit skips).
  const keepText = utf8ByteLength(result.content) < MARKDOWN_READBACK_BYTE_THRESHOLD ? result.content : undefined;
  markHydrated(relPath, parsed.hadBom, result.mtimeMs, result.size, eol, keepText);
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
 *     captured when the write's content was read (never the post-IPC live
 *     version) so concurrent writers don't overwrite stale.
 *
 * Throws on:
 *  - Unhydrated relPath (no `markHydrated` call yet for this file).
 *  - IPC failure (ENOENT / EACCES / etc.) — the caller decides whether to
 *    mark its component as backing-file-missing, surface its own toast, etc.
 */
export async function writeMarkdownFile(args: WriteArgs): Promise<void> {
  // Track this fire's promise so a concurrent `forceWriteForDocument` or
  // `cancelMarkdownWritesForDocument` can await it before re-arming a write.
  // The per-path chaining lives in `runSerializedMarkdownWrite` so the
  // single-tag fast path can join the same chain.
  //
  // Capture the mutation version BEFORE the chain wait (unless
  // the caller threaded an earlier capture): a mutation landing after this
  // point is newer than `args`, so the flushed-version bump must not cover it.
  const mutationVersionAtCapture =
    args.mutationVersionAtCapture ??
    (args.docId ? documentStore.getFrontmatterMutationVersion(args.docId) : 0);
  const promise = runSerializedMarkdownWrite(args.relPath, () =>
    writeMarkdownFileImpl({ ...args, mutationVersionAtCapture }),
  );
  inFlightWrites.set(args.callerId, promise);
  // Record this caller's outcome for `flushMarkdownWrite`.
  lastWriteFailureByCaller.delete(args.callerId);
  try {
    await promise;
  } catch (err) {
    lastWriteFailureByCaller.set(args.callerId, err);
    throw err;
  } finally {
    if (inFlightWrites.get(args.callerId) === promise) {
      inFlightWrites.delete(args.callerId);
    }
  }
}

/**
 * Runs `op` (a `.md` write) serialised behind any
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
 * Swap-safe final write for component teardown (TextTile.onDestroy).
 *
 * A vault swap may have already reset the gateway (clearing hydrate state), so
 * a direct `writeMarkdownFile` would throw "not hydrated" and bypass the swap
 * reset. When the file is no longer hydrated the swap's own flush already
 * persisted the scheduled bytes, so the final write is skipped.
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

  // Snapshot the vault identity BEFORE the (possibly long) drift prompt and the
  // write await, so the post-write bookkeeping can skip mutating the NEW
  // vault's index / drift baseline / FM-version if a swap landed meanwhile.
  const writeIdentity = captureVaultIdentity();

  // Pre-write drift gate (Reload / Keep-local prompt + bounded re-prompt loop).
  // 'drop' = the user chose Reload (editor + baseline already refreshed) —
  // discard this write; 'defer' / budget-exhaustion throw inside the gate.
  // `verifyStat` anchors the delta branch's post-read verification below.
  // The no-baseline short-circuit stays at THIS call site: awaiting the async
  // gate adds a microtask that delays the write IPC's handler attachment, so an
  // already-rejected IPC promise could surface as an unhandled rejection.
  const driftGate =
    getBaseline(relPath) === undefined
      ? { action: 'proceed' as const, verifyStat: undefined }
      : await runPreWriteDriftGate(vaultRoot, relPath);
  if (driftGate.action === 'drop') return;
  const preWriteVerifyStat = driftGate.verifyStat;

  // Toast when an assemble below REFUSES a frontmatter edit over
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
    // Delta-on-fresh-disk write source. We are inside
    // `runSerializedMarkdownWrite`, so this read observes any prior chained
    // write to this path. `nextFm` and `originalFrontmatter` derive from this
    // one read, so the CST engine rewrites only the delta keys and emits every
    // untouched key (including external additions the cache never saw)
    // byte-for-byte from disk — a stale cache can't drop a key.
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
      // never resurrect a deleted file from a stale in-memory snapshot.
      markPathFailed(vaultRoot, relPath);
      throw err;
    }
    // Guard a TRUNCATED/partial in-chain read from silently dropping the
    // on-disk frontmatter: assembling the delta against a read whose closing
    // fence is missing would emit ONLY the delta keys + the truncated body.
    // markPathFailed + throw; the next debounce retries.
    if (!parsedFresh.hasFrontmatter && freshReadLooksTornMidFrontmatter(relPath, freshContent)) {
      markPathFailed(vaultRoot, relPath);
      throw new Error(
        `markdownFileWriter: refusing delta write to "${relPath}" — fresh read opens with a ` +
        `frontmatter fence but has no closing fence (likely a partial read of an in-progress ` +
        `external write); not overwriting so the on-disk frontmatter is not dropped`,
      );
    }
    // The guard above catches only a torn frontmatter; a torn/stale BODY parses
    // cleanly and would be written back verbatim as `deltaBody` (no live
    // editor). The drift stat ran BEFORE this read, so a write landing in the
    // stat→read gap is invisible to it. Re-stat and verify the file is still
    // the one the drift decision trusted; on mismatch abort loudly (the next
    // debounced write re-detects the drift and prompts).
    if (preWriteVerifyStat !== undefined) {
      let postReadStat: { mtimeMs: number; size: number } | undefined;
      try {
        postReadStat = await invokeOk('vault:stat', vaultRoot, relPath);
      } catch {
        // Can't re-stat (transient IO) while the read itself succeeded —
        // proceed rather than wedge on a stat hiccup.
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
    // Derive the EOL from the SAME fresh read that sources the FM + BOM, not the
    // hydrate-time `state.eol` snapshot — an external LF↔CRLF conversion since
    // hydrate would otherwise emit mixed EOLs. Fall back to `state.eol` only for
    // an empty file (no EOL signal).
    const freshEol: '\r\n' | '\n' | undefined =
      freshContent.length === 0 ? state.eol : freshContent.includes('\r\n') ? '\r\n' : '\n';
    // Pick the body source. The delta carries only FM edits, so the body is
    // "re-emit the rest of the file". With a LIVE editor, the caller's `body`
    // holds un-debounced keystrokes and MUST win. Without one, the caller's
    // `body` is a watcher-index snapshot that a missed `fs.watch` event may have
    // left stale (and the drift baseline with it), so use the fresh disk body
    // instead of silently reverting an external edit. The decision is the
    // caller's, made at fire time (`args.bodyIsLive`); the `getDocument(docId)`
    // derivation is only a fallback for a direct caller that omits it.
    const hasLiveEditorBody =
      args.bodyIsLive ?? (docId ? documentStore.getDocument(docId) !== undefined : false);
    const deltaBody = hasLiveEditorBody ? body : parsedFresh.body;
    fileText = assembleMarkdownFile(nextFm, deltaBody, {
      // BOM flag from THIS in-chain read (not the pre-write
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
      eol: freshEol,
      onFrontmatterRefused,
    });
  } else {
    // ── Cache-FM path (body-only editor saves + legacy callers) ──
    // Frontmatter is owned by the live documentStore cache, not the caller's
    // schedule-time snapshot in `args.frontmatter`: an FM mutation landing during
    // the 300 ms debounce (external FM edit, Properties / TaskList edit) would
    // otherwise be clobbered by the frozen snapshot. Fall back to the caller's
    // args only when the cache has no entry for this doc.
    let fm = (docId ? documentStore.getFrontmatter(docId) : undefined) ?? args.frontmatter ?? {};
    // Never assemble a body-only write against a never-seeded FM cache: that
    // strips the on-disk YAML block. (TextTile's "adopt sibling doc" branch flips
    // hydrated=true without seeding FM.) `hasFrontmatter` distinguishes
    // never-seeded (re-read disk) from a deliberate `{}` seed (trust it). Seeding
    // the cache then routes the assemble through the verbatim `rawFrontmatter`
    // path, preserving the block byte-for-byte.
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
        // Same torn-read guard as the delta branch: a partial read parses as
        // "no frontmatter", which would strip the on-disk YAML block AND cache a
        // bogus `{}` seed that poisons every later save for this docId. Thrown
        // OUTSIDE the try so the ENOENT swallow above can't eat it.
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
      // Stale-cache re-read: if a newer FM version was flushed to disk than the
      // cache holds, re-read disk. Believed unreachable (`lastFlushed` is only
      // bumped to a PAST value of the monotonic per-docId counter) but kept as
      // cheap defense-in-depth, e.g. against docId reuse with a reset counter.
      const lastFlushed = getLastFlushedFrontmatterVersion(docId);
      const cacheVersion = documentStore.getFrontmatterMutationVersion(docId);
      if (lastFlushed > 0 && lastFlushed > cacheVersion) {
        try {
          const readResult = await invokeOk('vault:read-file-text', vaultRoot, relPath);
          const parsed = parseMarkdownFile(readResult.content);
          // Re-seed the verbatim bytes too so this (body-only) write can
          // still emit the freshly-read frontmatter untouched.
          documentStore.setFrontmatter(docId, parsed.frontmatter, parsed.rawFrontmatter);
          fm = parsed.frontmatter;
        } catch (err) {
          console.warn('[markdownFileWriter] Stale-cache re-read failed; using caller args:', err);
        }
      }
    }

    // When the open document's frontmatter is still byte-identical to disk (no
    // mutation since hydrate), emit those bytes verbatim. `getRawFrontmatter`
    // returns undefined once a mutation invalidated them.
    const rawFrontmatter = docId ? documentStore.getRawFrontmatter(docId) : undefined;
    // The disk-baseline source (survives mutations) lets a dirty write patch the
    // original frontmatter bytes source-preservingly. A docId-less orphan patch
    // threads it via `args.originalFrontmatter`; the cache source wins with a docId.
    const originalFrontmatter = docId
      ? documentStore.getOriginalFrontmatterSource(docId)
      : args.originalFrontmatter;
    fileText = assembleMarkdownFile(fm, body, {
      bom: state.hadBom,
      rawFrontmatter,
      frontmatterDirty: rawFrontmatter === undefined,
      originalFrontmatter,
      // The file's real eol, sniffed at hydrate time. Wins over FM-source
      // detection so a single-line-FM CRLF file keeps CRLF on a metadata edit even
      // when the body is LF (editor) and the FM source has no internal `\r\n`.
      eol: state.eol,
      onFrontmatterRefused,
    });
  }
  // Capture the exact byte length we're about to write so the post-write
  // baseline stamp can reject a stat that observed a FOREIGN edit instead of
  // our bytes.
  const writtenByteLength = utf8ByteLength(fileText);
  const bookkeeping = {
    relPath,
    fileText,
    docId,
    callerId,
    mutationVersionAtCapture: args.mutationVersionAtCapture,
    hasNewerWriteFor: hasNewerWriteForCaller,
  };
  // Identical-bytes skip, anchored to the drift BASELINE: only
  // when the gate proceeded on a NON-drifted stat and the assembled bytes equal
  // the last bytes CONFIRMED on disk (hydrate read / matched read-back). A
  // Keep-local choice (stat ≠ baseline) always writes; an external reload
  // re-stamps text-less, so it can never skip. No IPC → no baseline/index
  // change; a failed mark stays sticky until a real write lands (safe side).
  const base = getBaseline(relPath);
  if (
    base?.text !== undefined &&
    preWriteVerifyStat &&
    !hasBaselineDrifted(base, preWriteVerifyStat) &&
    fileText === base.text
  ) {
    if (isStillSameVault(writeIdentity)) finishWriteBookkeeping(bookkeeping);
    return;
  }
  await trackComponentWrite(vaultRoot, relPath, async () => {
    await invokeOk('vault:write-existing-file-text', vaultRoot, relPath, fileText);
  });
  // If a vault swap landed during the drift prompt or the write await, skip the
  // post-write bookkeeping (drift baseline, vault index, FM flushed-version,
  // markClean): stamping the outgoing vault's state for `relPath` could suppress
  // a legitimate drift check or inject stale metadata for a same-named file in
  // the new vault, and would resurrect a cross-vault baseline entry.
  if (!isStillSameVault(writeIdentity)) return;
  await confirmPostWriteBaseline(vaultRoot, relPath, fileText, writtenByteLength);
  finishWriteBookkeeping(bookkeeping);
}

// ── Debounce wrapper ──

/**
 * Schedules a debounced markdown write under `callerId`. Subsequent calls
 * for the same `callerId` reset the timer and replace the args — only the
 * most recent args win.
 *
 * Failures inside the deferred write are silenced here — `trackComponentWrite`
 * already routes them through the save-error pipeline (toast + sentinel +
 * saveStateStore); callers that need the outcome use `flushMarkdownWrite`.
 */
export function scheduleMarkdownWrite(args: WriteArgs, delay: number = MARKDOWN_WRITE_DEBOUNCE_MS): void {
  // Args getter returns the same stable args reference — the primitive
  // calls it at schedule (probe) and fire (write) time. Re-arming the
  // same callerId overwrites the prior args.
  writerScheduler.schedule(args.callerId, () => args, delay);
}

/** Outcome of a `flushMarkdownWrite` drain. */
export interface FlushMarkdownResult {
  /** True when every drained write landed (or nothing was pending). */
  ok: boolean;
  /** On failure, the caller's last write error (undefined on a timeout race). */
  error?: unknown;
}

/**
 * Drains `callerId`'s pending write immediately; re-entrant (a concurrent
 * call awaits the in-flight write); no-op (ok: true) when nothing is armed.
 *
 * `fireWrite` never rejects, so this cannot throw on a failed write; it
 * returns `{ ok, error }` so callers branch honestly. User-facing attribution
 * rides `trackComponentWrite` / `markPathFailed`.
 */
export async function flushMarkdownWrite(callerId: string): Promise<FlushMarkdownResult> {
  const { ok } = await writerScheduler.flush(callerId);
  if (ok) return { ok: true };
  return { ok: false, error: lastWriteFailureByCaller.get(callerId) };
}

/**
 * Cancels `callerId`'s pending timer without flushing it. Used by the
 * editor's onDestroy when the component is unmounting and a write would
 * land against a now-stale relPath (rename mid-debounce, vault swap, etc.).
 * `pendingOnly`: see the scheduler `cancel` doc in writeSchedulerTypes.
 */
export function cancelMarkdownWrite(callerId: string, pendingOnly = false): void {
  writerScheduler.cancel(callerId, undefined, pendingOnly);
}

// ── Global hooks ──

/**
 * Test-only flusher registry. Production code MUST NOT use this API; the CI
 * gate `scripts/gates:no-prod-md-test-flushers` enforces it. Tests
 * inject flush callbacks that get drained alongside the gateway's real
 * pending writes.
 */
type TestFlusher = () => Promise<void>;
interface TestFlusherEntry {
  flush: TestFlusher;
  forceWrite?: TestFlusher;
  getDocId?: () => string | null | undefined;
}
const testFlushers = new Map<string, TestFlusherEntry>();
// Reset on vault swap too, so a test that fires `fireVaultSwap` without the
// per-test reset doesn't carry prior flushers into the new vault's drain.
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
 * Also drains test-only flushers registered via `__testRegisterFlusher`
 * (empty in production).
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
 * Variant of `flushAllMarkdownWrites` returning `{ ok, failed }` where
 * ok = count of successful drains and failed = array of `{ ownerId, error }`
 * (used by the `failed.length` checks in vaultStore.save, tabsStore.close,
 * vaultFolderOps.delete, fileTags).
 */
export interface FlushAllResult {
  ok: number;
  failed: Array<{ ownerId: string; error: unknown }>;
}

export async function flushAllMarkdownWriters(): Promise<FlushAllResult> {
  // Test-flusher errors carry their *original* rejection (tests rely on
  // `result.failed[i].error` identity).
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
  // `ok` sums production writes drained successfully AND successful test flushers.
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
 * The drift-baseline registry is deliberately NOT dropped here (it resets via
 * the vault-swap hook below): this is also called from per-test cleanup where
 * the test may still need the baseline for assertions.
 */
export function cancelAllMarkdownWrites(): void {
  writerScheduler.reset();
  fileState.clear();
  forceWriters.clear();
  // Drop in-flight promise refs so a late-settling outgoing-vault write
  // doesn't block incoming-vault cancel/force awaits.
  inFlightWrites.clear();
  // Drop the per-path chains so the new vault's first write to a same-named
  // path doesn't chain behind an outgoing-vault write that's still settling.
  writeChainByPath.clear();
  // An outgoing vault's flush error must not leak into the new vault.
  lastWriteFailureByCaller.clear();
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
 * Cancels every armed (debounced, not-yet-fired) markdown write
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
 * Async sibling of `cancelMarkdownWritesForDocument`. Cancels the
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
 * to disk (the Keep-local handler in `vaultExternalChanges`).
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
  // Test-registered flushers (none in production): match by getDocId, call
  // forceWrite if present else flush.
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
        // If a timer's late fire is still in flight for this caller, wait for
        // it first — otherwise the OS orders the two writes and the loser's
        // bytes can land last. `.catch` swallows the prior failure (it has its
        // own attribution via trackComponentWrite).
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
// Also drop the file-baseline registry. A same-named file in
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
 * test's dispatch. Also clears the test-only flusher registry.
 */
export function __resetMarkdownFileWriterForTests(): void {
  cancelAllMarkdownWrites();
  testFlushers.clear();
}

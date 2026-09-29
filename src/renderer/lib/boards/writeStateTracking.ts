/**
 * writeStateTracking — single source of truth for save-pipeline counters.
 *
 * Owns the in-flight counter, the pending / failed path sets, the
 * write-error and write-state listener slots, the recent-self-write
 * registry, and the `beginWrite` / `endWrite` lifecycle that every writer
 * routes through.
 *
 * The schedulers (`createScheduler`: board, config, misc) and the note
 * writer call `beginWrite` / `endWrite` to keep the counter authoritative,
 * and register their own cleanup hooks via `registerResetCallback` /
 * `registerTestResetCallback` so the reset entry points sweep every module's
 * local state. `unsavedWork()` is the one answer to "could leaving now lose
 * work?": these sets plus the sources registered with
 * `registerUnsavedSource` (note bodies, editors not yet serialised, raw
 * views).
 */

import { markDirty, markClean } from '../vault/dirtyFlagRecovery';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';
import { rebasePath, registerPathRenamable } from '../vault/renamePathKeys';
import { clearComponentRetries, releaseComponentWrite, retainComponentWrite } from './componentWriteRetry';
import { isRetainableWriteError } from './writeSchedulerFailures';

// ── Recent self-write registry ──
//
// The main-process file watcher suppresses its own write echoes for ~500-2000ms
// via `FileWatcher.suppress`. On slow disks, large batches (tag-rename of 200
// files), or simply a heavily loaded system, the OS-level change event can
// arrive AFTER the main-side window has expired. Without a renderer-side
// safety net, the late event flows into the external-change reconcilers and
// either (a) re-reads the file the renderer just wrote (no-op but wasteful)
// or (b) classifies the disk content as an external edit and surfaces a
// spurious "Reload / Keep local" toast.
//
// Every write path that funnels through `trackComponentWrite` or the board /
// config schedulers registers its target path here with a TTL. The
// `vault:files-changed` listener consults this registry before dispatching
// external-change reconciliation; recently-self-written paths are dropped.
//
// The TTL extends adaptively: while inflight writes are non-zero, every
// `markRecentSelfWrite` call uses the bulk window (5000ms) so a long
// rewrite loop keeps every path's entry alive past the final OS event.

const RECENT_SELF_WRITE_TTL_MS = 1500;
const RECENT_SELF_WRITE_TTL_BULK_MS = 5000;

/**
 * Every key is routed through `vaultPath()` so the lookup is unconditionally
 * case-insensitive, and the registry, the watcher's suppression map, and the
 * tag-storage normaliser all agree on key identity regardless of platform.
 */

/** Vault-relative path -> expiry timestamp (ms since epoch). */
// allow-module-state: reset via resetWriteTracking called from boardSaver's pre-swap handler
const recentSelfWrites = new Map<VaultPath, number>();

/**
 * Marks `path` as recently self-written so the renderer's external-change
 * listener can drop the next OS-level event for it. Idempotent — calling
 * multiple times in the suppression window extends the expiry forward.
 *
 * Uses the longer bulk TTL whenever any write is currently in flight, on
 * the assumption that a single write in a bulk loop has many siblings still
 * being scheduled. A burst of OS events that arrives at the tail end of the
 * loop is then still inside the window.
 */
export function markRecentSelfWrite(path: string): void {
  if (!path) return;
  // Case-fold + slash-normalise via `vaultPath()` so an OS-emitted
  // watcher event differing only in case (`notes.md` vs the renderer's
  // `Notes.md`) still matches the registry entry.
  const normalised = vaultPath(path);
  if (!normalised) return;
  const ttl = inflightWriteCount > 0
    ? RECENT_SELF_WRITE_TTL_BULK_MS
    : RECENT_SELF_WRITE_TTL_MS;
  const next = Date.now() + ttl;
  const current = recentSelfWrites.get(normalised) ?? 0;
  recentSelfWrites.set(normalised, Math.max(current, next));
}

/**
 * Returns true if `path` is in the recent-self-writes registry and has not
 * expired. Lazily prunes the entry on miss so the map doesn't grow unbounded.
 */
export function isRecentSelfWrite(path: string): boolean {
  if (!path) return false;
  // Symmetric `vaultPath()` so the late OS watcher event's
  // path matches the key the writer registered.
  const normalised = vaultPath(path);
  const expiry = recentSelfWrites.get(normalised);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    recentSelfWrites.delete(normalised);
    return false;
  }
  return true;
}

/**
 * Test-only — clears the recent-self-write registry. Production code should
 * never need to call this; entries time out on their own.
 */
export function __clearRecentSelfWritesForTests(): void {
  recentSelfWrites.clear();
}

/**
 * Drops `path` from the recent-self-write registry immediately, rather than
 * waiting for the TTL. Called from `trackComponentWrite`'s catch branch: the
 * write never reached disk, so the next watcher event for it must NOT be
 * suppressed — otherwise an external edit within the TTL would be classified
 * as a self-write and silently dropped.
 *
 * Uses the same case-fold normalisation as the mark/check helpers so the
 * deletion targets the actual key. Idempotent — a missing entry is a no-op.
 */
export function dropRecentSelfWrite(path: string): void {
  if (!path) return;
  const normalised = vaultPath(path);
  if (!normalised) return;
  recentSelfWrites.delete(normalised);
}

// ── In-flight tracking state ──

/**
 * Counts scheduled-but-not-yet-flushed writes AND in-flight disk writes.
 * Used to drive the on-disk dirty sentinel: 0→1 = mark dirty, 1→0 = mark clean.
 */
let inflightWriteCount = 0;

/**
 * Vault-relative paths currently queued for write. Persisted into the sentinel
 * so a recovery handler can surface exactly which files were in-flight when
 * the process was killed.
 *
 * Ordering invariant: iteration order matches insertion order (JS Set
 * specification). The overflow-trim policy in `trimSetIfOverflowing` relies
 * on this — when the set exceeds MAX_TRACKED_PATHS we delete the *oldest*
 * entries first because they're the least likely to still represent a
 * legitimate pending write. Don't swap the implementation for an unordered
 * collection (or sort the entries before trim) — the FIFO drop policy is
 * the whole point of using insertion-order iteration.
 */
// allow-module-state: reset via resetWriteTracking called from boardSaver's pre-swap handler
const pendingVaultPaths = new Set<VaultPath>();

/**
 * Paths whose write failed and have not since been retried successfully.
 * These keep the sentinel dirty even after `inflightWriteCount` drains so
 * a crash recovery flag survives a string of failed writes.
 *
 * Unlike `pendingVaultPaths` it is never trimmed: every entry is a change
 * that isn't on disk, and forgetting one would report it saved.
 */
// allow-module-state: reset via resetWriteTracking called from boardSaver's pre-swap handler
const failedVaultPaths = new Set<VaultPath>();

/**
 * Paths whose write failed where nothing is left queued to retry, and whose
 * owner has already told the user (a tag sweep, Replace All: their own toast
 * says what failed). Listed in the save popover, but they don't make save()
 * fail or ask at close: there is no unsaved change behind them to lose.
 * A later successful write to the path clears it.
 */
// allow-module-state: reset via resetWriteTracking called from boardSaver's pre-swap handler
const reportedFailures = new Set<VaultPath>();

// Every mark follows a rename (in-app or by another program), so a failure
// or a queued write is never left behind on a path that no longer exists.
registerPathRenamable('writeStateTracking', (oldRel, newRel) => {
  let moved = false;
  for (const set of [pendingVaultPaths, failedVaultPaths, reportedFailures]) {
    for (const key of [...set]) {
      const next = rebasePath(key, oldRel, newRel);
      if (next === null) continue;
      set.delete(key);
      set.add(vaultPath(next));
      spellings.set(vaultPath(next), next);
      moved = true;
    }
  }
  if (moved) notifyWriteState();
});

/**
 * Per-path write generation for COMPONENT writes (everything routed through
 * {@link trackComponentWrite}). Minted at the start of each `trackComponentWrite`
 * and threaded into the matching `endWrite`, whose success branch only clears
 * the path from `failedVaultPaths` when this write is still the newest — so a
 * timed-out write that lands late can't erase a NEWER writer's failure. The
 * 'full'-mode schedulers (board/config/misc) call `endWrite` with no generation
 * → unconditional clear. Keyed by case-folded `VaultPath`; cleared on vault swap.
 */
// allow-module-state: reset via resetWriteTracking called from boardSaver's pre-swap handler
const componentWriteGenByPath = new Map<VaultPath, number>();

/**
 * Session-monotonic write-generation mint, shared by `writeScheduler.ts`'s
 * `writeGenByPath` and `componentWriteGenByPath` above. Both per-path maps
 * PRUNE their entry on a still-newest success, so a per-path `+1` re-mint could
 * restart at 1 and collide with a generation an older write's late-success heal
 * still holds (erasing a newer write's failed mark). A counter that only climbs
 * makes a captured generation unambiguous, and a missing map entry still reads
 * "not current". Deliberately NOT reset on vault swap, so a stale continuation's
 * generation keeps comparing unequal to every post-swap mint.
 */
// allow-module-state: monotonic by design; per-path maps reset on vault swap
let writeGenerationCounter = 0;

/** Mints the next session-unique write generation (always ≥ 1). */
export function mintWriteGeneration(): number {
  writeGenerationCounter += 1;
  return writeGenerationCounter;
}

/**
 * Mints and records the component write generation for `path`. Called by
 * `trackComponentWrite` before its `beginWrite`; the returned value is handed
 * back to `endWrite` so the success branch can check it's still newest.
 */
function bumpComponentWriteGen(path: string): number {
  const key = vaultPath(path);
  const next = mintWriteGeneration();
  componentWriteGenByPath.set(key, next);
  return next;
}

/**
 * Defensive ceiling for the pending and reported sets (never the failed one) —
 * if one grows beyond this it indicates
 * a leak (e.g. rename-mid-debounce that didn't drop the old path). We trim
 * oldest entries (FIFO by insertion order) and warn so the user-visible
 * sentinel doesn't bloat.
 */
const MAX_TRACKED_PATHS = 256;

export function trimSetIfOverflowing<T extends string>(set: Set<T>, label: string): void {
  if (set.size <= MAX_TRACKED_PATHS) return;
  const overflow = set.size - MAX_TRACKED_PATHS;
  let removed = 0;
  // `for...of` over a Set yields entries in insertion order, so the first
  // N entries removed are the oldest. See `pendingVaultPaths` invariant.
  for (const entry of set) {
    if (removed >= overflow) break;
    set.delete(entry);
    removed++;
  }
  console.warn(
    `[boardSaver] ${label} exceeded ${MAX_TRACKED_PATHS} entries; trimmed ${removed} oldest (likely a write-tracking leak).`,
  );
}

// ── Write-error listener ──

export interface WriteErrorInfo {
  kind: 'board' | 'config' | 'component';
  path?: string;
  error: unknown;
}

type WriteErrorListener = (info: WriteErrorInfo) => void;
let writeErrorListener: WriteErrorListener | null = null;

/**
 * Registers a callback that fires whenever a disk write fails. The store
 * layer uses this to surface a toast — `lib/` cannot import `stores/`
 * directly without violating the architecture's layering rule.
 */
export function setWriteErrorListener(listener: WriteErrorListener | null): void {
  writeErrorListener = listener;
}

export function notifyWriteError(info: WriteErrorInfo): void {
  if (!writeErrorListener) return;
  try {
    writeErrorListener(info);
  } catch (err) {
    console.error('[boardSaver] write-error listener threw:', err);
  }
}

// ── Write-state listener ──
//
// Fires on every begin/end so the renderer can drive a save indicator.
// Reports raw counters; the store layer derives idle / saving / saved /
// error from them. Same layering rationale as `writeErrorListener`.

export interface WriteStateInfo {
  inflight: number;
  failed: number;
  /**
   * Count of paths queued for write (debounced-but-not-yet-fired AND
   * in-flight), i.e. `pendingVaultPaths.size`. Lets the save indicator show
   * "saving" during a debounce window even when `inflight` is 0 — the markdown
   * gateway tracks armed body writes here without bumping `inflight`.
   */
  pending: number;
  /**
   * Concrete paths in the failure set so the renderer
   * popover can list them with a Retry button. Order is undefined
   * (Set iteration order); the renderer dedups via its own queue.
   */
  failedPaths: string[];
  /** Failures their owner already reported, with nothing queued to retry. */
  reportedPaths: string[];
}

type WriteStateListener = (info: WriteStateInfo) => void;
let writeStateListener: WriteStateListener | null = null;

export function setWriteStateListener(listener: WriteStateListener | null): void {
  writeStateListener = listener;
}

function notifyWriteState(): void {
  if (!writeStateListener) return;
  try {
    writeStateListener({
      inflight: inflightWriteCount,
      failed: failedVaultPaths.size,
      pending: pendingVaultPaths.size,
      failedPaths: Array.from(failedVaultPaths),
      reportedPaths: Array.from(reportedFailures),
    });
  } catch (err) {
    console.error('[boardSaver] write-state listener threw:', err);
  }
}

// ── Sentinel refresh / write lifecycle ──

/**
 * The last spelling each tracked path was written under. The ledger keys are
 * case-folded; the sentinel names files as they are on disk, so the recovery
 * list next launch shows (and opens) the real file.
 */
// allow-module-state: reset via resetWriteTracking called from boardSaver's pre-swap handler
const spellings = new Map<VaultPath, string>();

function track(path: string): VaultPath {
  const key = vaultPath(path);
  spellings.set(key, path);
  if (spellings.size > 4 * MAX_TRACKED_PATHS) {
    for (const k of spellings.keys()) {
      if (!pendingVaultPaths.has(k) && !failedVaultPaths.has(k) && !reportedFailures.has(k)) spellings.delete(k);
    }
  }
  return key;
}

/** The pending and failed paths, in their on-disk spelling, for the sentinel. */
function sentinelPaths(): string[] {
  return Array.from(new Set<VaultPath>([...pendingVaultPaths, ...failedVaultPaths]), (k) => spellings.get(k) ?? k);
}

function refreshSentinel(vaultRoot: string | undefined): void {
  if (!vaultRoot) return;
  if (pendingVaultPaths.size === 0 && failedVaultPaths.size === 0 && inflightWriteCount === 0) return;
  void markDirty(vaultRoot, sentinelPaths());
}

/**
 * Adds `path` to the pending set without incrementing the inflight counter
 * and refreshes the sentinel. Used by schedulers when a debounce is reset
 * mid-flight against a different target path (e.g. a rename happened
 * between two `scheduleBoardWrite` calls). The original timer was already
 * counted by an earlier `beginWrite`, so we mustn't double-count.
 */
export function noteAdditionalPendingPath(vaultRoot: string | undefined, path: string): void {
  const key = track(path);
  if (pendingVaultPaths.has(key)) return;
  pendingVaultPaths.add(key);
  trimSetIfOverflowing(pendingVaultPaths, 'pendingVaultPaths');
  refreshSentinel(vaultRoot);
  // Surface the new pending path to the save indicator so a
  // debounced-but-not-inflight write (the note writer) reads "saving".
  notifyWriteState();
}

/**
 * Drops `path` from the pending set without touching the inflight counter
 * or moving it to `failedVaultPaths`. Used when the path of a still-pending
 * write changes mid-debounce (rename) — the old path is no longer the
 * write's target so it must leave `pendingVaultPaths` before the matching
 * `endWrite` fires against the new path. A path with another write armed
 * stays pending.
 */
export function dropPendingPath(vaultRoot: string | undefined, path: string): void {
  const key = vaultPath(path);
  if (isArmed(key) || !pendingVaultPaths.delete(key)) return;
  refreshSentinel(vaultRoot);
  // Keep the save indicator in step as the pending set drains.
  notifyWriteState();
}

/**
 * THE single authority for "does any scheduler have a pending or in-flight
 * write for this vault-relative path?". Gives both external-change reconcilers
 * (the `.md` classifier in `vaultExternalChanges` and the `.board.json`
 * reconciler in `vaultExternalReconcilers`) one consistent dirty-check.
 *
 * True when the path is:
 *  - pending (a debounce timer is armed — most schedulers mark this at
 *    schedule time via `beginWrite`),
 *  - in-flight (a `trackComponentWrite` IPC is mid-write — also in
 *    `pendingVaultPaths` for its duration),
 *  - failed (last write threw and hasn't been retried — keeps the file
 *    out-of-sync flag live).
 *
 * Every scheduler enters its armed writes in `pendingVaultPaths` at schedule
 * time: board / config / misc through `beginWrite` (`sentinelMode: 'full'`),
 * the note writer through `noteAdditionalPendingPath` (`'pending-path'`).
 *
 * Conservative on the narrow "flush resolved but the next schedule hasn't
 * armed yet" window — a false "clean" there just means a borderline-race
 * external edit reconciles silently instead of prompting, and the watcher's
 * self-write suppression covers that gap.
 */
export function isPathPending(path: string): boolean {
  const key = vaultPath(path);
  return pendingVaultPaths.has(key) || failedVaultPaths.has(key);
}

/** True when the path's last write failed and nothing has landed since. */
export function isPathFailed(path: string): boolean {
  return failedVaultPaths.has(vaultPath(path));
}

/**
 * "Is a write for this path armed or mid-flight RIGHT NOW?"
 * Distinct from {@link isPathPending}: deliberately EXCLUDES
 * `failedVaultPaths`. The board reconciler's self-write divergence tiebreak
 * (`reconcileBoardJsonChange`) uses this to recognise write N's watcher echo
 * arriving while write N+1 is still queued or in flight — N+1's bytes are on
 * disk but its post-write baseline stamp hasn't run, so the stat-vs-baseline
 * compare reads "diverged" even though both writers were Filo. A pending or
 * in-flight newer write EXPLAINS the divergence; a failed path does not, and
 * including it would silently drop genuine external-edit echoes for a path
 * whose last write failed.
 */
export function isPathQueuedOrInFlight(path: string): boolean {
  return pendingVaultPaths.has(vaultPath(path));
}

/**
 * True when ANY path's last write FAILED and hasn't since been retried
 * successfully (i.e. `failedVaultPaths` is non-empty).
 *
 * A per-scheduler `flushAll()` only reports failures for writes it drained THIS
 * cycle; a timer write that already failed and settled before the flush is
 * only recorded here. `vaultStore.save()` consults this after its flushes so the
 * Ctrl+S / flush-and-quit result is honest.
 */
export function hasFailedWrites(): boolean {
  return failedVaultPaths.size > 0;
}

/**
 * Extra sources of unsaved paths that the ledger can't see: a note body held
 * in memory with no write armed (a conflict waits for its answer). The note
 * store registers one; it can't be imported here without a cycle.
 */
const unsavedSources: Array<() => string[]> = [];

/** Registers a source consulted by {@link unsavedWork}. Register once, at module load. */
export function registerUnsavedSource(source: () => string[]): void {
  unsavedSources.push(source);
}

/**
 * Each write scheduler's answer to "is a write of this path armed (its timer
 * set, or parked behind a write in flight) and not yet fired?". A write that
 * finishes while a newer one of the same path is armed must leave the path
 * pending: the newer change isn't on disk, and clearing the mark would let the
 * crash sentinel be cleared and the external-change check treat the file as
 * saved.
 */
const armedSources: Array<(key: VaultPath) => boolean> = [];

/** Registers a scheduler's armed-path check. Returns the unregister. */
export function registerArmedPathSource(source: (key: VaultPath) => boolean): () => void {
  armedSources.push(source);
  return () => {
    const i = armedSources.indexOf(source);
    if (i >= 0) armedSources.splice(i, 1);
  };
}

function isArmed(key: VaultPath): boolean {
  return armedSources.some((source) => source(key));
}

/** What {@link unsavedWork} reports. Paths are case-folded vault paths. */
export interface UnsavedWork {
  /** Queued or being written, not (yet) failed. */
  pending: VaultPath[];
  /** The last write failed, or the change is held (a conflict, a missing file). */
  failed: VaultPath[];
  /** Writes in flight, including ones with no path (an exclusive create). */
  inflight: number;
}

/**
 * THE answer to "is anything unsaved?", for close, open-another-vault and
 * quit. Empty (no paths, nothing in flight) means leaving the vault loses
 * nothing.
 */
export function unsavedWork(): UnsavedWork {
  const failed = new Set<VaultPath>(failedVaultPaths);
  const pending = new Set<VaultPath>();
  for (const p of pendingVaultPaths) if (!failed.has(p)) pending.add(p);
  for (const source of unsavedSources) {
    let paths: string[] = [];
    try {
      paths = source();
    } catch (err) {
      console.error('[writeStateTracking] unsaved source threw:', err);
    }
    for (const rel of paths) {
      const key = vaultPath(rel);
      if (!failed.has(key)) pending.add(key);
    }
  }
  return { pending: [...pending], failed: [...failed], inflight: inflightWriteCount };
}

/** True when {@link unsavedWork} has nothing to report. */
export function isUnsavedWorkEmpty(work: UnsavedWork): boolean {
  return work.pending.length === 0 && work.failed.length === 0 && work.inflight === 0;
}

/**
 * Records a path as out-of-sync with disk without going through a full
 * begin/endWrite pair. Used when a writer can't even begin (e.g. the
 * upstream read failed) but the user-visible state — "I asked Filo to
 * update this file's frontmatter" — still didn't make it to disk, so the
 * sentinel and failed-path tracker must reflect the drift.
 *
 * Mirrors the `endWrite(..., success=false)` move-to-failed behaviour
 * without touching the inflight counter.
 */
export function markPathFailed(vaultRoot: string | undefined, path: string): void {
  if (!path) return;
  const key = track(path);
  pendingVaultPaths.delete(key);
  // Never trimmed: each entry is a change not on disk, and dropping one would
  // let save() and the leave check report it saved.
  failedVaultPaths.add(key);
  refreshSentinel(vaultRoot);
  notifyWriteState();
}

/**
 * Records a failed write that nothing will retry, whose owner has already
 * told the user (see `reportedFailures`). Takes the path out of the failed
 * and pending sets, so save() and the leave check don't wait on it.
 */
export function markPathReported(vaultRoot: string | undefined, path: string): void {
  if (!path) return;
  const key = vaultPath(path);
  pendingVaultPaths.delete(key);
  failedVaultPaths.delete(key);
  reportedFailures.add(key);
  trimSetIfOverflowing(reportedFailures, 'reportedFailures');
  syncSentinelIfIdle(vaultRoot);
  notifyWriteState();
}

/** Failures their owner already reported, with nothing queued to retry. */
export function reportedFailedPaths(): VaultPath[] {
  return Array.from(reportedFailures);
}

/**
 * Clears `path` from the failed set after a LATE success: a write that exceeded
 * the scheduler's `writeTimeoutMs` (so the path was marked failed) but then
 * actually LANDED on disk.
 *
 * The note writer self-heals via
 * `trackComponentWrite`'s late `endWrite(true)`. Board / config / misc call
 * their IPC directly, so without this their phantom "failed" mark would stick
 * for the session (save() false, `.filo/.dirty` set, recovery prompt next
 * launch) while the bytes are on disk.
 *
 * Does NOT touch `inflightWriteCount` — the timeout's `endWrite`/`safeEndWrite`
 * already balanced the begin/end pair. Syncs the sentinel (markClean iff the
 * vault is now idle + clean). Idempotent: a no-op when `path` wasn't failed
 * (e.g. a scheduler that already self-healed).
 */
export function clearFailedPathAfterLateSuccess(
  vaultRoot: string | undefined,
  path: string,
): void {
  if (!path) return;
  const key = vaultPath(path);
  const wasReported = reportedFailures.delete(key);
  if (!failedVaultPaths.delete(key) && !wasReported) return; // wasn't failed → nothing to heal
  syncSentinelIfIdle(vaultRoot);
  notifyWriteState();
}

/**
 * Defensive end-of-flush sentinel sync. Called by `flushAll` after every
 * scheduled write has been drained — if our counter says idle and the
 * tracking sets are empty, mark clean; otherwise mark dirty with the
 * remaining paths. Lets the orchestrator settle the sentinel without
 * exposing the internal sets.
 */
export function syncSentinelIfIdle(vaultRoot: string | undefined): void {
  if (inflightWriteCount !== 0 || !vaultRoot) return;
  if (failedVaultPaths.size === 0 && pendingVaultPaths.size === 0) {
    void markClean(vaultRoot);
  } else {
    void markDirty(vaultRoot, sentinelPaths());
  }
}

export function beginWrite(vaultRoot: string | undefined, pendingPath?: string): void {
  if (pendingPath) {
    pendingVaultPaths.add(track(pendingPath));
    trimSetIfOverflowing(pendingVaultPaths, 'pendingVaultPaths');
  }
  if (inflightWriteCount === 0 && vaultRoot) {
    void markDirty(vaultRoot, sentinelPaths());
  } else if (pendingPath) {
    refreshSentinel(vaultRoot);
  }
  inflightWriteCount++;
  notifyWriteState();
}

export function endWrite(
  vaultRoot: string | undefined,
  pendingPath?: string,
  success: boolean = true,
  // The component write generation captured at `beginWrite` time
  // (from `bumpComponentWriteGen`). When provided, the success branch only
  // clears the path's failed mark if THIS write is still the newest for the
  // path. Undefined for the 'full'-mode schedulers → unconditional clear.
  writeGen?: number,
): void {
  if (inflightWriteCount === 0) {
    // Dev-only signal that the begin/end pairing has drifted.
    // Production code self-corrects (counter stays at 0), but a double-end
    // means a writer either finished twice or skipped its beginWrite — both
    // are bugs worth investigating before they corrupt the sentinel.
    if (import.meta.env.DEV) {
      console.warn(
        '[writeStateTracking] endWrite called with inflightWriteCount=0',
        { pendingPath, success },
      );
    }
  } else {
    inflightWriteCount--;
  }
  if (pendingPath) {
    const key = track(pendingPath);
    if (success) {
      // A newer write of the path armed while this one was out keeps it
      // pending: the file isn't saved yet, and the sentinel must still say so.
      if (!isArmed(key)) pendingVaultPaths.delete(key);
      // Only clear the failed mark when this write is still the newest for the
      // path (a no-generation caller clears unconditionally), so a stale
      // timed-out write landing late leaves a newer writer's failure intact.
      const genCurrent = writeGen === undefined ? undefined : componentWriteGenByPath.get(key);
      if (writeGen === undefined || genCurrent === writeGen) {
        failedVaultPaths.delete(key);
        reportedFailures.delete(key);
      }
      // Prune the generation entry on a still-newest success so the map doesn't
      // grow per distinct `.md` path. A superseded late write leaves it for the
      // newest write to prune.
      if (writeGen !== undefined && genCurrent === writeGen) {
        componentWriteGenByPath.delete(key);
      }
    } else {
      // A failed write must keep the sentinel dirty — the file on disk is
      // out of sync with memory. Move it from "pending" to "failed" so a
      // later successful retry can drop it.
      pendingVaultPaths.delete(key);
      failedVaultPaths.add(key); // never trimmed (see markPathFailed)
    }
  }
  if (inflightWriteCount === 0 && vaultRoot) {
    if (failedVaultPaths.size === 0 && pendingVaultPaths.size === 0) {
      void markClean(vaultRoot);
    } else {
      void markDirty(vaultRoot, sentinelPaths());
    }
  }
  notifyWriteState();
}

// ── Reset hook registry ──
//
// Other write modules (config, viewport, misc) own their own pending state
// (e.g. `latestMiscArgs`, `lastWrittenConfigs`, `viewportsCache`) but the
// authoritative reset entry points live here. Each module registers a
// cleanup at module load via `registerResetCallback` (production reset on
// vault swap) and `registerTestResetCallback` (test-only nuke including
// listener slots).

const resetCallbacks: Array<() => void> = [];
const testResetCallbacks: Array<() => void> = [];

export function registerResetCallback(cb: () => void): void {
  resetCallbacks.push(cb);
}

export function registerTestResetCallback(cb: () => void): void {
  testResetCallbacks.push(cb);
}

/**
 * Clears all in-memory write tracking. Called when a vault is closed.
 *
 * `oldVaultRoot` — when provided, schedules a `markClean` against the
 * outgoing vault BEFORE clearing the in-memory sets. Without this, a
 * pending-write timer cancelled mid-debounce leaves a `.filo/.dirty`
 * sentinel on the old vault that names paths the new session will never
 * touch — the next vault open against that path would surface a phantom
 * "Recover unsaved work" modal.
 *
 * The sentinel write is fire-and-forget; the in-memory state cleanup
 * cannot wait on disk I/O without blocking the vault-swap UI thread.
 * The mutex inside `dirtyFlagRecovery.markClean` keeps the disk write
 * ordered against any concurrent markDirty.
 */
export function resetWriteTracking(oldVaultRoot?: string): void {
  if (oldVaultRoot) void markClean(oldVaultRoot);
  pendingVaultPaths.clear();
  failedVaultPaths.clear();
  reportedFailures.clear();
  spellings.clear();
  recentSelfWrites.clear();
  // Drop per-path component write generations so a stale late self-heal from
  // the outgoing vault can't match and clear.
  componentWriteGenByPath.clear();
  clearComponentRetries();
  inflightWriteCount = 0;
  for (const cb of resetCallbacks) cb();
  notifyWriteState();
}

/**
 * Test-only — resets the inflight counter and every registered module's
 * local state between tests.
 */
export function __resetDirtyTrackingForTests(): void {
  inflightWriteCount = 0;
  pendingVaultPaths.clear();
  failedVaultPaths.clear();
  reportedFailures.clear();
  spellings.clear();
  recentSelfWrites.clear();
  componentWriteGenByPath.clear();
  clearComponentRetries();
  writeErrorListener = null;
  writeStateListener = null;
  for (const cb of testResetCallbacks) cb();
}

/**
 * Test-only — count of retained per-path component write-generation entries.
 * Pins the success-path prune: after component writes complete it returns
 * to ~0 rather than retaining one entry per distinct path until vault swap.
 */
export function __componentWriteGenSizeForTests(): number {
  return componentWriteGenByPath.size;
}

// ── Component-write wrapper ──

/**
 * Wraps a per-component IPC write so it participates in the same inflight /
 * sentinel / write-error pipeline as board and config writes.
 *
 * Without this, a per-component write failure would only be logged to the
 * console — the save indicator would stay "saved" and the `.filo/.dirty`
 * sentinel would never reflect the loss.
 *
 * On failure the listener is notified and the path is moved into
 * `failedVaultPaths` (so the sentinel stays dirty until a later retry
 * succeeds). The error is re-thrown so the caller can decide whether to
 * swallow it (e.g. fire-and-forget timer paths) or surface it further.
 *
 * Pass `notifyOnError: false` when the caller plans to surface its own
 * aggregated toast (e.g. the bulk tag-rename loop, which would otherwise
 * spam N error toasts in a row instead of "failed for N of M files").
 * The sentinel tracking still runs in that case so a crash mid-loop still
 * recovers the affected paths.
 */
export interface TrackComponentWriteOptions {
  kind?: WriteErrorInfo['kind'];
  notifyOnError?: boolean;
  /**
   * What a failure leaves behind, for a write no scheduler retries:
   *  - `retry`: a transient failure is kept for Retry (`componentWriteRetry.ts`),
   *    with `rescueText` as the file for a rescue copy and `onSuccess` run
   *    after a retry lands; any other failure is reported, since firing it
   *    again can't help.
   *  - `'report'`: the failure's toast is the whole story (a delete or rename
   *    that didn't happen leaves nothing unsaved), so the path is reported,
   *    not left failed.
   * Omitted: the path stays failed until a later write of it succeeds (the
   * note writer, which keeps the change queued itself).
   */
  onFailure?: { retry: { rescueText?: () => string; onSuccess?: () => void } } | 'report';
}

export async function trackComponentWrite<T>(
  vaultRoot: string,
  path: string,
  writeFn: () => Promise<T>,
  optionsOrKind: TrackComponentWriteOptions | WriteErrorInfo['kind'] = {},
): Promise<T> {
  const options: TrackComponentWriteOptions =
    typeof optionsOrKind === 'string' ? { kind: optionsOrKind } : optionsOrKind;
  const kind = options.kind ?? 'component';
  const notifyOnError = options.notifyOnError ?? true;

  // Capture this write's per-path generation BEFORE beginWrite so a late
  // `endWrite(true)` self-heal can be gated on still being the newest.
  const writeGen = bumpComponentWriteGen(path);
  // This write supersedes a failed one of the same path kept for Retry.
  releaseComponentWrite(path);
  beginWrite(vaultRoot, path);
  // Register suppression BEFORE awaiting the IPC: the watcher event for our
  // own write can reach the renderer before the IPC resolves and would be
  // treated as an external edit. Re-mark on success to refresh the TTL in case
  // the IPC took longer than the suppression window.
  markRecentSelfWrite(path);
  try {
    const result = await writeFn();
    markRecentSelfWrite(path);
    endWrite(vaultRoot, path, true, writeGen);
    return result;
  } catch (err) {
    // Clear the recent-self-write registration before re-throwing. The write
    // never landed, so suppressing the next watcher event would mask a
    // recovery action (re-save in another tool, git checkout, …) as Filo's own.
    dropRecentSelfWrite(path);
    if (notifyOnError) notifyWriteError({ kind, path, error: err });
    endWrite(vaultRoot, path, false);
    const onFailure = options.onFailure;
    if (onFailure !== undefined && componentWriteGenByPath.get(vaultPath(path)) === writeGen) {
      if (onFailure !== 'report' && isRetainableWriteError(err, true)) {
        const { rescueText, onSuccess } = onFailure.retry;
        retainComponentWrite({
          relPath: path,
          rescueText,
          run: async () => {
            await trackComponentWrite(vaultRoot, path, writeFn, options);
            onSuccess?.();
          },
        });
      } else {
        // Nothing a retry could fix, and the toast above said so.
        markPathReported(vaultRoot, path);
      }
    }
    throw err;
  }
}

// Retry fan-out across all five schedulers (board, markdown
// gateway, frontmatter, config, misc); implemented next to the failure ledger.
export { retryAllFailedWrites } from './writeSchedulerFailures';

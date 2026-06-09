/**
 * writeStateTracking — single source of truth for save-pipeline counters.
 *
 * Owns the in-flight counter, the pending / failed path sets, the
 * write-error and write-state listener slots, and the
 * `beginWrite` / `endWrite` lifecycle that every scheduler routes through.
 *
 * Sibling write modules (boardWriteScheduler, configWriteScheduler,
 * miscWriteScheduler, viewportCache) call `beginWrite` / `endWrite` to
 * keep the counter authoritative, and register their own cleanup hooks
 * via `registerResetCallback` / `registerTestResetCallback` so the
 * orchestrator's reset entry points sweep every module's local state.
 */

import { markDirty, markClean } from '../vault/dirtyFlagRecovery';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';

// ── Recent self-write registry (Phase 19 S3) ──
//
// The main-process file watcher suppresses its own write echoes for ~500-2000ms
// via `FileWatcher.suppress`. On slow disks, large batches (tag-rename of 200
// files), or simply a heavily loaded system, the OS-level change event can
// arrive AFTER the main-side window has expired. Without a renderer-side
// safety net, the late event flows into `handleExternalMarkdownChanges` and
// either (a) re-reads the file the renderer just wrote (no-op but wasteful)
// or (b) classifies the disk content as an external edit and surfaces a
// spurious "Reload / Keep local" toast.
//
// Every write path that funnels through `trackComponentWrite` or the board /
// config schedulers now registers its target path here with a TTL. The
// `vault:files-changed` listener consults this registry before dispatching
// external-change reconciliation; recently-self-written paths are dropped.
//
// The TTL extends adaptively: while inflight writes are non-zero, every
// `markRecentSelfWrite` call uses the bulk window (5000ms) so a long
// rewrite loop keeps every path's entry alive past the final OS event.

const RECENT_SELF_WRITE_TTL_MS = 1500;
const RECENT_SELF_WRITE_TTL_BULK_MS = 5000;

/**
 * Phase 4 — every key is routed through `vaultPath()` so the lookup is
 * unconditionally case-insensitive (matching the rest of the codebase via
 * `normalizeVaultRelative`). Pre-Phase-4 this module had its own
 * `detectCaseInsensitiveFs` gate that case-folded only on Windows/macOS;
 * the gate has been removed in favour of the unified `VaultPath` rule so
 * the registry, the watcher's suppression map, and the tag-storage
 * normaliser all agree on key identity regardless of platform.
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
  // Phase 4 — case-fold + slash-normalise via `vaultPath()` so an OS-emitted
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
  // Phase 4 — symmetric `vaultPath()` so the late OS watcher event's
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
 * Phase 1 / 1.4 — drops `path` from the recent-self-write registry
 * immediately, rather than waiting for the TTL. Called from
 * `trackComponentWrite`'s catch branch when the underlying IPC throws:
 * the write never reached disk, so we MUST NOT suppress the next watcher
 * event for it — the user (or another process) may be trying to recover
 * the file and the renderer needs to see that event flow through the
 * external-change pipeline. Without this delete, a failed Filo write
 * leaves an entry in the registry whose TTL ranges from 1.5 s to 5 s,
 * during which a manual edit-then-save by the user against the same
 * path would be classified as a self-write and silently dropped.
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
 * Same insertion-order invariant as `pendingVaultPaths` — overflow trim
 * removes the oldest failures first.
 */
// allow-module-state: reset via resetWriteTracking called from boardSaver's pre-swap handler
const failedVaultPaths = new Set<VaultPath>();

/**
 * Audit-14 1.5 — monotonic per-path write generation for COMPONENT writes
 * (everything routed through {@link trackComponentWrite}: the markdown gateway,
 * the frontmatter scheduler, the per-component `.md` writers). Bumped once at
 * the start of each `trackComponentWrite` and threaded into the matching
 * `endWrite`. The success branch only clears the path from `failedVaultPaths`
 * when this write is still the newest for the path — so a write that timed out
 * in the scheduler but LANDS LATE (its `endWrite(true)` self-heal) can't erase
 * a NEWER writer's legitimately-recorded failure for the same path (mirrors the
 * Audit-13 M3 generation guard the board/config/misc late-success heal already
 * has via `clearFailedPathAfterLateSuccess`). The 'full'-mode schedulers
 * (board/config/misc) call `endWrite` with no generation → unconditional clear,
 * back-compat. Keyed by case-folded `VaultPath`; cleared on vault swap.
 */
// allow-module-state: reset via resetWriteTracking called from boardSaver's pre-swap handler
const componentWriteGenByPath = new Map<VaultPath, number>();

/**
 * Bumps and returns the component write generation for `path`. Called by
 * `trackComponentWrite` before its `beginWrite`; the returned value is handed
 * back to `endWrite` so the success branch can check it's still newest.
 */
function bumpComponentWriteGen(path: string): number {
  const key = vaultPath(path);
  const next = (componentWriteGenByPath.get(key) ?? 0) + 1;
  componentWriteGenByPath.set(key, next);
  return next;
}

/**
 * Defensive ceiling — if either tracking set grows beyond this it indicates
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
   * Audit2 2.3 — count of paths queued for write (debounced-but-not-yet-fired
   * AND in-flight), i.e. `pendingVaultPaths.size`. Lets the save indicator
   * show "saving" during a debounce window even when `inflight` is still 0 —
   * the markdown gateway tracks its armed-but-not-fired body writes here
   * (sentinel-mode 'pending-path') without bumping `inflight`, so without this
   * the indicator read a premature "idle"/"saved" while text was unwritten.
   */
  pending: number;
  /**
   * Phase C / C.10 — concrete paths in the failure set so the renderer
   * popover can list them with a Retry button. Order is undefined
   * (Set iteration order); the renderer dedups via its own queue.
   */
  failedPaths: string[];
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
    });
  } catch (err) {
    console.error('[boardSaver] write-state listener threw:', err);
  }
}

// ── Sentinel refresh / write lifecycle ──

function refreshSentinel(vaultRoot: string | undefined): void {
  if (!vaultRoot) return;
  const union = new Set<VaultPath>([...pendingVaultPaths, ...failedVaultPaths]);
  if (union.size === 0 && inflightWriteCount === 0) return;
  void markDirty(vaultRoot, Array.from(union));
}

/**
 * Adds `path` to the pending set without incrementing the inflight counter
 * and refreshes the sentinel. Used by schedulers when a debounce is reset
 * mid-flight against a different target path (e.g. a rename happened
 * between two `scheduleBoardWrite` calls). The original timer was already
 * counted by an earlier `beginWrite`, so we mustn't double-count.
 */
export function noteAdditionalPendingPath(vaultRoot: string | undefined, path: string): void {
  const key = vaultPath(path);
  if (pendingVaultPaths.has(key)) return;
  pendingVaultPaths.add(key);
  trimSetIfOverflowing(pendingVaultPaths, 'pendingVaultPaths');
  refreshSentinel(vaultRoot);
  // Audit2 2.3 — surface the new pending path to the save indicator so a
  // debounced-but-not-inflight write (markdown gateway) reads "saving".
  notifyWriteState();
}

/**
 * Drops `path` from the pending set without touching the inflight counter
 * or moving it to `failedVaultPaths`. Used when the path of a still-pending
 * write changes mid-debounce (rename) — the old path is no longer the
 * write's target so it must leave `pendingVaultPaths` before the matching
 * `endWrite` fires against the new path. Phase 31 A2.3.
 */
export function dropPendingPath(vaultRoot: string | undefined, path: string): void {
  if (!pendingVaultPaths.delete(vaultPath(path))) return;
  refreshSentinel(vaultRoot);
  // Audit2 2.3 — keep the save indicator in step as the pending set drains.
  notifyWriteState();
}

/**
 * Phase 4 / E3 — extra pending-write probes. Most schedulers
 * (board / frontmatter / config / misc) call `beginWrite` at SCHEDULE time
 * (`manageSentinel: true`), so a debounced-but-not-yet-fired write already
 * shows up in `pendingVaultPaths`. The markdown-file gateway is the
 * exception: it opts out (`manageSentinel: false`) because its
 * `trackComponentWrite` wrapper does begin/endWrite around the disk I/O,
 * so its SCHEDULED writes don't enter the ledger until they fire. Such a
 * scheduler registers a probe here so `isPathPending` can still answer
 * "yes" for its armed-but-not-fired writes — making the authority genuinely
 * cover *every* scheduler.
 */
const pendingProbes: Array<(path: string) => boolean> = [];

/**
 * Registers an additional "is a write armed for this path?" probe consulted
 * by {@link isPathPending}. Used by the markdown gateway (which manages its
 * own sentinel) so its scheduled writes participate in the single
 * pending-write authority. Idempotent registration is the caller's concern
 * (register once at module load).
 */
export function registerPendingProbe(probe: (path: string) => boolean): void {
  pendingProbes.push(probe);
}

/**
 * Phase 4 / E3 — THE single authority for "does any scheduler have a
 * pending or in-flight write for this vault-relative path?". Recurrence-proofs
 * F4 by giving both external-change reconcilers (the `.md` classifier in
 * `vaultExternalChanges` and the `.board.json` reconciler in
 * `vaultExternalReconcilers`) one consistent dirty-check instead of each
 * re-deriving "is an editor open?" / "is a board write queued?" differently.
 *
 * True when the path is:
 *  - pending (a debounce timer is armed — most schedulers mark this at
 *    schedule time via `beginWrite`),
 *  - in-flight (a `trackComponentWrite` IPC is mid-write — also in
 *    `pendingVaultPaths` for its duration),
 *  - failed (last write threw and hasn't been retried — keeps the file
 *    out-of-sync flag live),
 *  - OR flagged by a registered probe (the markdown gateway's
 *    `manageSentinel: false` scheduled writes).
 *
 * Conservative on the narrow "flush resolved but the next schedule hasn't
 * armed yet" window — a false "clean" there just means a borderline-race
 * external edit reconciles silently instead of prompting, and the watcher's
 * self-write suppression covers that gap.
 */
export function isPathPending(path: string): boolean {
  const key = vaultPath(path);
  if (pendingVaultPaths.has(key) || failedVaultPaths.has(key)) return true;
  for (const probe of pendingProbes) {
    if (probe(path)) return true;
  }
  return false;
}

/**
 * Back-compat alias for {@link isPathPending}. Predates the E3 consolidation;
 * retained so existing call sites / tests keep working. Prefer
 * `isPathPending` in new code — it's the named single authority.
 */
export function hasPendingWrite(path: string): boolean {
  return isPathPending(path);
}

/**
 * Phase 3 / 3.1 — true when ANY path's last write FAILED and hasn't since been
 * retried successfully (i.e. `failedVaultPaths` is non-empty).
 *
 * A per-scheduler `flushAll()` only re-surfaces failures for writes it actually
 * drained THIS cycle (pending timers + currently in-flight). A fire-and-forget
 * timer write that already FAILED and SETTLED before the flush is recorded in
 * `failedVaultPaths` but is no longer in any scheduler's pending/in-flight maps,
 * so the next `flushAll` reports a clean `failed: []`. `vaultStore.save()`
 * consults this after its flushes so the Ctrl+S / flush-and-quit aggregate
 * boolean is honest. The `.filo/.dirty` sentinel is unaffected — it is driven
 * by this same set, so it was already (correctly) staying dirty; this only
 * closes the boolean-honesty gap.
 */
export function hasFailedWrites(): boolean {
  return failedVaultPaths.size > 0;
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
  const key = vaultPath(path);
  pendingVaultPaths.delete(key);
  failedVaultPaths.add(key);
  trimSetIfOverflowing(failedVaultPaths, 'failedVaultPaths');
  refreshSentinel(vaultRoot);
  notifyWriteState();
}

/**
 * Audit-12 M2 — clears `path` from the failed set after a LATE success: a write
 * that exceeded the scheduler's `writeTimeoutMs` (so `fireWrite` stopped
 * awaiting it and `markPathFailed`-ed the path) but then actually LANDED on disk.
 *
 * The markdown gateway + frontmatter scheduler self-heal this for free — their
 * `performWrite` wraps the IPC in `trackComponentWrite`, whose late
 * `endWrite(true)` already drops the path from `failedVaultPaths`. Board / config
 * / misc call their IPC directly, so without this their phantom "failed" mark
 * sticks for the whole session — `vaultStore.save()` keeps returning false,
 * `.filo/.dirty` stays set, and the next launch shows a recovery prompt while the
 * bytes are actually on disk.
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
  if (!failedVaultPaths.delete(key)) return; // wasn't failed → nothing to heal
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
    void markDirty(vaultRoot, Array.from(new Set<VaultPath>([...pendingVaultPaths, ...failedVaultPaths])));
  }
}

export function beginWrite(vaultRoot: string | undefined, pendingPath?: string): void {
  if (pendingPath) {
    pendingVaultPaths.add(vaultPath(pendingPath));
    trimSetIfOverflowing(pendingVaultPaths, 'pendingVaultPaths');
  }
  if (inflightWriteCount === 0 && vaultRoot) {
    void markDirty(vaultRoot, Array.from(new Set<VaultPath>([...pendingVaultPaths, ...failedVaultPaths])));
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
  // Audit-14 1.5 — the component write generation captured at `beginWrite` time
  // (from `bumpComponentWriteGen`). When provided, the success branch only
  // clears the path's failed mark if THIS write is still the newest for the
  // path. Undefined for the 'full'-mode schedulers → unconditional clear.
  writeGen?: number,
): void {
  if (inflightWriteCount === 0) {
    // Phase 34 D1.1 — dev-only signal that the begin/end pairing has drifted.
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
    const key = vaultPath(pendingPath);
    if (success) {
      pendingVaultPaths.delete(key);
      // Audit-14 1.5 — only clear the failed mark when this write is still the
      // newest for the path. A no-generation caller (board/config/misc 'full'
      // mode) clears unconditionally as before. A stale, timed-out component
      // write landing late (its self-heal `endWrite(true)`) whose generation
      // is no longer current leaves a newer writer's legit failure intact.
      const genCurrent = writeGen === undefined ? undefined : componentWriteGenByPath.get(key);
      if (writeGen === undefined || genCurrent === writeGen) {
        failedVaultPaths.delete(key);
      }
      // Audit-14 1.5/1.6 — prune the generation entry on a still-newest success
      // so the map doesn't grow per distinct `.md` path for the session
      // (re-created at gen 1 by the next write). A superseded late write
      // (genCurrent !== writeGen) leaves it for the newest write to prune.
      if (writeGen !== undefined && genCurrent === writeGen) {
        componentWriteGenByPath.delete(key);
      }
    } else {
      // A failed write must keep the sentinel dirty — the file on disk is
      // out of sync with memory. Move it from "pending" to "failed" so a
      // later successful retry can drop it.
      pendingVaultPaths.delete(key);
      failedVaultPaths.add(key);
      trimSetIfOverflowing(failedVaultPaths, 'failedVaultPaths');
    }
  }
  if (inflightWriteCount === 0 && vaultRoot) {
    if (failedVaultPaths.size === 0 && pendingVaultPaths.size === 0) {
      void markClean(vaultRoot);
    } else {
      void markDirty(vaultRoot, Array.from(new Set<VaultPath>([...pendingVaultPaths, ...failedVaultPaths])));
    }
  }
  notifyWriteState();
}

// ── Reset hook registry ──
//
// Other write modules (config, viewport, misc) own their own pending state
// (e.g. `pendingMiscWrites`, `lastWrittenConfigs`, `viewportsCache`) but the
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
 * "Recover unsaved work" modal. Phase 18 H14.
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
  recentSelfWrites.clear();
  // Audit-14 1.5 — drop per-path component write generations so the new vault's
  // first write to a same-named path starts at generation 1 (a stale late
  // self-heal from the outgoing vault no longer matches and can't clear).
  componentWriteGenByPath.clear();
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
  recentSelfWrites.clear();
  componentWriteGenByPath.clear();
  writeErrorListener = null;
  writeStateListener = null;
  for (const cb of testResetCallbacks) cb();
}

/**
 * Test-only — count of retained per-path component write-generation entries.
 * Pins the Audit-14 1.5/1.6 prune: after component writes complete it returns
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
 * Without this, the four per-component markdown/frontmatter writers
 * (TextTile, DocumentEditor, PropertiesPopup, TaskListBoard) fire
 * `vault:write-file-text` directly and any failure is silently logged
 * to the console — the save indicator stays "saved" while the disk write
 * was rejected, and the `.filo/.dirty` sentinel never reflects the loss.
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

  // Audit-14 1.5 — capture this write's per-path generation BEFORE beginWrite so
  // a late `endWrite(true)` self-heal can be gated on still being the newest.
  const writeGen = bumpComponentWriteGen(path);
  beginWrite(vaultRoot, path);
  // Phase A.2a — register suppression BEFORE awaiting the IPC. The OS-level
  // file watcher event for our own write can fire (and reach the renderer)
  // before the IPC promise resolves; marking after the await meant
  // `vault:files-changed` saw the path as "unknown self-write" and routed
  // it into the external-edit pipeline, surfacing a spurious
  // "External edit replaced 'New Tile'" toast for every freshly-created
  // file. Re-mark on success to refresh the TTL in case the IPC took
  // longer than the suppression window.
  markRecentSelfWrite(path);
  try {
    const result = await writeFn();
    markRecentSelfWrite(path);
    endWrite(vaultRoot, path, true, writeGen);
    return result;
  } catch (err) {
    // Phase 1 / 1.4 — clear the recent-self-write registration before
    // re-throwing. The IPC failed, so the write never landed on disk;
    // suppressing the next watcher event for this path would mask any
    // recovery action (the user re-saving in another tool, a git
    // checkout, …) by treating the foreign change as one of Filo's own.
    // Mirrors the `failedVaultPaths` move done by `endWrite(success=false)`
    // below — both sides of the fail-state need to release suppression
    // so the recovery pipeline can observe disk.
    dropRecentSelfWrite(path);
    if (notifyOnError) notifyWriteError({ kind, path, error: err });
    endWrite(vaultRoot, path, false);
    throw err;
  }
}

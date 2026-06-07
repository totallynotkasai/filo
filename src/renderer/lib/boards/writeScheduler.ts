/**
 * writeScheduler — unified primitive for debounced disk-write pipelines.
 *
 * Five legacy scheduler modules (board / markdown / frontmatter / config /
 * misc) each reimplemented the same shape: pending Map + in-flight Map +
 * failure Set + timer cancellation + begin/endWrite integration. Two of
 * those reimplementations dropped in-flight failure attribution and
 * silently reported "saved" while writes were rejecting — markdownFileWriter
 * never populated its `inFlightFailures` Set, and configWriteScheduler
 * had no in-flight map at all so `flushScheduledConfig` returned `null`
 * the moment the timer fired even if the IPC was still pending.
 *
 * `createScheduler(opts)` owns the shared bookkeeping; each consumer
 * supplies `performWrite`, a sentinel-info mapper, and the small handful
 * of policy hooks (skip-write, failure-id, rename-mid-debounce).
 *
 * Contract:
 *  - One `beginWrite` per `schedule()` call (the debounce window covers
 *    sentinel state from arming to disk landing).
 *  - One matching `endWrite` per write outcome: timer-fire success/failure,
 *    flush success/failure, missing-source, skipped, or single-key cancel.
 *  - `cancelAll()` is the vault-swap exception — pairs are NOT closed
 *    because `resetWriteTracking` resets the counter; this matches the
 *    legacy schedulers' deferred-cleanup contract.
 *  - `reset()` clears in-flight tracker entries so a late `.then`/`.catch`
 *    against the OUTGOING vault doesn't mutate the new vault's tracking.
 *    A `trackerIsCurrent` guard inside `fireWrite` covers that race.
 *
 * Failure attribution model:
 *  - `performWrite` either resolves (success), resolves with
 *    `{ failed: [...] }` (per-target partial failure — used by
 *    config bundle), or throws (whole-write failure → single failureId).
 *  - The scheduler aggregates failures into a shared Set, then drains
 *    them per-key from `flush()` / `flushAll()` so callers attribute
 *    failures honestly to the Ctrl+S aggregate boolean.
 */

import {
  beginWrite,
  endWrite,
  noteAdditionalPendingPath,
  dropPendingPath,
  syncSentinelIfIdle,
  markPathFailed,
  clearFailedPathAfterLateSuccess,
} from './writeStateTracking';
import { reportError } from '../utils/errorBus';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';

/**
 * Audit5 R3 — sentinel a `performWrite` race resolves to when it outruns the
 * optional `writeTimeoutMs` bound. A module-level unique symbol so the
 * `Promise.race` outcome type discriminates cleanly from a `string[]` failure
 * list (whose entries are paths / callerIds, never this token).
 */
const WRITE_TIMEOUT: unique symbol = Symbol('write-timeout');

/**
 * Per-write sentinel info — what `beginWrite`/`endWrite` need to keep the
 * `.filo/.dirty` sentinel and `failedVaultPaths` accurate. Returned by the
 * consumer's `getSentinelInfo(args)` hook.
 */
export interface SchedulerSentinelInfo {
  vaultRoot?: string;
  path?: string;
}

/**
 * Optional shape `performWrite` can return to express partial failures.
 * Used by the config bundle to surface multi-target failure lists without
 * collapsing them to a single throw. A bare `void` resolution is treated
 * as full success.
 */
export interface PerformWriteResult {
  failed?: string[];
}

export interface CreateSchedulerOptions<TArgs> {
  /** Diagnostic name (used in error reports). */
  name: string;
  /** Idle-debounce window in milliseconds. */
  debounceMs: number;
  /**
   * Performs the disk write. Resolve `void` for success, resolve
   * `{ failed: [...] }` for partial failure, or throw for whole-write
   * failure. Throws are attributed to a single failureId.
   */
  performWrite: (args: TArgs) => Promise<PerformWriteResult | void>;
  /** Maps args → (vaultRoot, path) for `beginWrite`/`endWrite`. */
  getSentinelInfo: (args: TArgs) => SchedulerSentinelInfo;
  /**
   * Identifier emitted in `flushAll().failed[]` / `flush().ok` attribution
   * when `performWrite` throws. Defaults to the sentinel-info `path` field.
   * Schedulers that key by an internal id but report failures by a
   * user-visible name (board → boardPath, markdown → callerId) supply this.
   */
  getFailureId?: (args: TArgs) => string;
  /**
   * Returns true if the write should be skipped at fire/flush time
   * (counts as success for sentinel). Used by the config bundle's
   * corrupt-config gate.
   */
  shouldSkipWrite?: (args: TArgs) => boolean;
  /**
   * Called when an existing pending key is rescheduled. Receives the
   * sentinel info captured at the previous schedule call and the new one.
   * Used by the board scheduler for rename-mid-debounce path bookkeeping
   * (drop old pendingVaultPath, add new). Other schedulers ignore.
   */
  onReschedule?: (
    prevSentinel: SchedulerSentinelInfo,
    nextSentinel: SchedulerSentinelInfo,
  ) => void;
  /**
   * Returns the user-facing message when timer-fire or flush finds the
   * source removed (args getter returns null). Returning `undefined`
   * silences the toast — appropriate for fire-and-forget paths where the
   * cancel-after-unmount case is benign.
   */
  missingSourceMessage?: (key: string) => string | undefined;
  /**
   * Whether the primitive should call `beginWrite` at schedule time and
   * `endWrite` at fire/flush time. Defaults to `true`.
   *
   * Set `false` when the consumer's `performWrite` already wraps the IPC
   * in a `trackComponentWrite` (markdownFileWriter does this), so the
   * primitive doesn't double-increment the inflight counter. The
   * consumer remains responsible for its own sentinel coverage.
   *
   * @deprecated Prefer `sentinelMode`. `manageSentinel: false` maps to
   *   `sentinelMode: 'none'`; the default maps to `'full'`.
   */
  manageSentinel?: boolean;
  /**
   * Audit2 2.3 — how the primitive keeps the `.filo/.dirty` sentinel and the
   * `pendingVaultPaths` ledger in sync across the debounce → write window:
   *  - `'full'` (default): `beginWrite` at schedule, `endWrite` at outcome —
   *    owns BOTH the inflight counter and the pending path for the whole
   *    window.
   *  - `'none'`: no tracking — the consumer's `performWrite` owns everything.
   *  - `'pending-path'`: track ONLY the pending PATH during the armed window
   *    (`noteAdditionalPendingPath` at schedule, `dropPendingPath` +
   *    `syncSentinelIfIdle` at fire-handoff / cancel / reschedule / reset),
   *    WITHOUT bumping inflight. Used by the markdown gateway, whose
   *    `performWrite` wraps its own `trackComponentWrite` (inflight) at fire
   *    time — this closes the body-edit crash window (no sentinel during the
   *    300 ms debounce) and lets the save indicator read "saving", without
   *    double-counting inflight.
   *
   * Defaults derived from `manageSentinel` for back-compat.
   */
  sentinelMode?: 'full' | 'none' | 'pending-path';
  /**
   * Optional snapshot transform applied at fire-time (timer or flush)
   * BEFORE `performWrite` runs. Used by the board scheduler to deep-clone
   * the live cache proxy so a mid-flush mutation can't leak into the
   * payload. Critically, snapshots taken during `flushAll`'s synchronous
   * capture loop freeze BEFORE any await — preserving Phase 25 L12 / C5
   * "capture path + snapshot upfront" semantics.
   */
  snapshotArgs?: (args: TArgs) => TArgs;
  /**
   * Audit5 R3 — optional upper bound (ms) on a single `performWrite`. When set,
   * `fireWrite` races the write against this timeout; if it elapses first the
   * scheduler STOPS awaiting that write, marks its path failed (keeping the
   * `.filo/.dirty` sentinel + the save indicator's failed list live), and
   * attributes the failure so `flush`/`flushAll` (and the `save()` boolean that
   * folds them) report it instead of hanging forever. The underlying
   * `performWrite` keeps running — a late success self-heals via its own
   * `trackComponentWrite` `endWrite`. Omit to await indefinitely (the prior
   * behaviour, correct for schedulers whose writes can't wedge on user input).
   * Set ONLY high enough to exceed any legitimate in-write await (e.g. the
   * markdown gateway's interactive drift prompt); it is a wedged-write backstop,
   * not a latency budget.
   */
  writeTimeoutMs?: number;
}

interface PendingEntry<TArgs> {
  timer: ReturnType<typeof setTimeout>;
  getArgs: () => TArgs | null;
  /** Sentinel info captured at schedule time; used by `cancel` and missing-source endWrite. */
  scheduleVaultRoot: string | undefined;
  schedulePath: string | undefined;
}

interface InFlightEntry {
  /** Error-swallowed tracker. `flushAll` awaits these via `Promise.all` without try/catch. */
  promise: Promise<void>;
  /** Identifier added to the shared failures Set if the write rejects. */
  failureId: string;
  /**
   * Populated when the inner promise resolves. `null` means "not yet
   * settled" (or the late-settle path skipped capture because reset()
   * cleared the entry mid-IPC). Empty array means clean success.
   * `flush(key)` reads this so partial failures returned via
   * `{ failed: [...] }` surface correctly in the per-key `ok` boolean.
   */
  capturedFailures: string[] | null;
}

/**
 * Per-scheduler flush result. Intentionally distinct from the markdown
 * gateway/registry `FlushAllResult` (`{ ok: number; failed: {ownerId,error}[] }`):
 * here `failed` is a flat list of failure identifiers and `vaultRoot` carries
 * the last-seen root for post-drain sentinel sync. Do not unify the two.
 *
 * 6.3.P4 — `ok` tracks the count of writes drained successfully so the
 * gateway-side `flushAllMarkdownWriters` (which composes scheduler + test
 * flushers) reports a meaningful production count. Pre-fix the gateway's
 * `ok` was a `testFlushers.size - testFailures.length` synthesis, which
 * is always 0 in production (no test flushers registered) — masking the
 * shim-migration leftover where `lastSeenArgs` was still populated by
 * every write but read by no production consumer.
 */
export interface FlushAllResult {
  /** Identifiers (paths or failure ids) whose write failed. */
  failed: string[];
  /**
   * Count of writes drained (pending-timer-fired + already-in-flight)
   * whose `performWrite` resolved without surfacing a failure id. Always
   * equals `drainedTotal - failed.length` for any single `flushAll` call.
   * Mirror of the gateway's `ok` field; production callers usually check
   * `failed.length === 0` and ignore this count.
   */
  ok: number;
  /**
   * Last vault root observed during the flush. Callers driving
   * `syncSentinelIfIdle` after a multi-scheduler drain consult this so a
   * scheduler with no pending writes doesn't strand the union sentinel sync.
   */
  vaultRoot: string | undefined;
}

export interface Scheduler<TArgs> {
  /**
   * Arms a debounced write for `key`. Subsequent calls cancel the previous
   * timer and replace the args getter — last call wins. The getter is
   * invoked at fire/flush time so the write captures the latest in-memory
   * state, not the state at schedule time.
   */
  schedule(
    key: string,
    getArgs: () => TArgs | null,
    delayOverride?: number,
  ): void;
  /**
   * Cancels the pending timer for `key` and counts it as a clean
   * "no write needed" — emits `endWrite(success=true)` so the sentinel
   * doesn't strand a phantom dirty entry. `fallbackPath` overrides the
   * schedule-time captured path (e.g. a board-delete site that knows the
   * board's most recent path).
   */
  cancel(key: string, fallbackPath?: string): void;
  /**
   * Cancels every pending timer without firing them and without emitting
   * `endWrite`. Vault-swap caller is responsible for `resetWriteTracking`,
   * which clears the inflight counter and tracking sets in one shot.
   */
  cancelAll(): void;
  /**
   * Drains the pending timer for `key` and awaits any in-flight write for
   * it. Returns `{ ok }` reflecting the per-write outcome — used by tab
   * close to surface a save-failure toast without depending on the global
   * sentinel.
   *
   * `overrideGetArgs` lets the caller substitute a fresh args resolver
   * (e.g. the board scheduler's `flushBoardWrite` passes a getter that
   * reads the latest cache state, which may have been cleared since the
   * original schedule call). Falls back to the stored getter when omitted.
   */
  flush(key: string, overrideGetArgs?: () => TArgs | null): Promise<{ ok: boolean }>;
  /**
   * Drains every pending timer and awaits every in-flight write. Aggregates
   * per-key failure identifiers into `failed[]` for Ctrl+S attribution.
   */
  flushAll(): Promise<FlushAllResult>;
  /**
   * Vault-swap nuclear option — clears pending timers, in-flight tracker
   * entries, and failure attribution Set. Late `.then`/`.catch` callbacks
   * against cleared entries no-op via the `trackerIsCurrent` guard.
   */
  reset(): void;
  /**
   * Phase 4 / E3 — true when any armed (pending, not-yet-fired) timer's args
   * satisfy `predicate`. Lets a scheduler that opts out of sentinel
   * management (`manageSentinel: false`, e.g. the markdown gateway) still
   * expose its scheduled writes to the single `isPathPending` authority via
   * a registered probe. Does NOT consult in-flight writes — those already
   * live in the shared ledger via `beginWrite`/`trackComponentWrite`.
   */
  hasPending(predicate: (args: TArgs) => boolean): boolean;
  /**
   * Test-only — count of attributed-but-undrained failure identifiers retained
   * in the internal `failures` Set. Pins the Audit-7 L12 fix: a fire-and-forget
   * failure followed by a successful write to the SAME key must prune the stale
   * id (returns 0), rather than retaining it until `reset()`. Production code
   * never needs this; the Set is otherwise an opaque internal.
   */
  __failuresSizeForTests(): number;
}

export function createScheduler<TArgs>(
  opts: CreateSchedulerOptions<TArgs>,
): Scheduler<TArgs> {
  const pending = new Map<string, PendingEntry<TArgs>>();
  /**
   * Phase F2 — in-flight writes are tracked per-fire, not per-key. Each
   * `fireWrite` adds its own entry to the key's bucket (a Set), so two writes
   * for the same key that overlap (a reschedule fires while the prior write's
   * IPC is still pending) each settle with their own `endWrite`. Keying by
   * `key` alone let the second fire's `inFlight.set` overwrite the first
   * entry; the first's late `.then` then hit the `trackerIsCurrent` guard and
   * returned WITHOUT `endWrite`, stranding its `beginWrite`. The inflight
   * counter never drained to 0 → save indicator stuck on "saving" and
   * `markClean` never deleted the `.filo/.dirty` sentinel (phantom recovery
   * prompt on next launch).
   */
  const inFlight = new Map<string, Set<InFlightEntry>>();
  /**
   * Per-failure-id Set populated by `fireWrite` on rejection / partial
   * failure. `flush(key)` and `flushAll()` consume entries that match the
   * in-flight failureId(s) they awaited, so the attribution stays scoped
   * to writes the caller actually waited on (not unrelated failures from
   * earlier fire-and-forget timer fires).
   */
  const failures = new Set<string>();
  /**
   * Audit-13 M3 — monotonic per-path write generation. Bumped each time a
   * write FIRES for a path (in `fireWrite`) and captured at fire time. A
   * timed-out write's late-success self-heal (the `writeTimeoutMs` branch's
   * `clearFailedPathAfterLateSuccess` continuation) consults this so it only
   * clears the failed mark when THIS write is still the newest for its path —
   * otherwise an OLDER, superseded write finally landing would erase a NEWER
   * write's legitimate failure recorded in the interim, falsely reporting the
   * path clean. Keyed by the case-folded `VaultPath` so two fires for the same
   * file (differing only in OS casing) share one generation counter. Cleared on
   * vault swap via `reset()`.
   */
  const writeGenByPath = new Map<VaultPath, number>();

  // Back-compat: `manageSentinel: false` → 'none'; default → 'full'.
  const sentinelMode: 'full' | 'none' | 'pending-path' =
    opts.sentinelMode ?? (opts.manageSentinel === false ? 'none' : 'full');

  const failureIdFor = (args: TArgs): string => {
    if (opts.getFailureId) return opts.getFailureId(args);
    return opts.getSentinelInfo(args).path ?? '<unknown>';
  };

  const safeBeginWrite = (info: SchedulerSentinelInfo): void => {
    if (sentinelMode === 'full') {
      beginWrite(info.vaultRoot, info.path);
    } else if (sentinelMode === 'pending-path' && info.path) {
      // 2.3 — track the armed debounce window in the sentinel ledger WITHOUT
      // an inflight bump; the consumer's performWrite owns inflight (via
      // trackComponentWrite) once the write actually fires.
      noteAdditionalPendingPath(info.vaultRoot, info.path);
    }
  };

  const safeEndWrite = (
    info: SchedulerSentinelInfo,
    success: boolean,
  ): void => {
    if (sentinelMode === 'full') {
      endWrite(info.vaultRoot, info.path, success);
    } else if (sentinelMode === 'pending-path' && info.path) {
      // 2.3 — the armed window closed: fire-handoff to trackComponentWrite, a
      // cancel, or a no-write early-return inside performWrite (e.g. the user
      // chose "reload" on a pre-write drift prompt). Release the schedule-time
      // pending path; a real write already moved it to inflight/failed inside
      // trackComponentWrite, so dropPendingPath is a no-op there, and
      // syncSentinelIfIdle markCleans iff nothing else is pending/inflight/
      // failed. `success` is irrelevant here — real failures are tracked by
      // trackComponentWrite's own endWrite(false).
      dropPendingPath(info.vaultRoot, info.path);
      syncSentinelIfIdle(info.vaultRoot);
    }
  };

  /**
   * Runs `performWrite` and threads in-flight tracking, late-arrival
   * guards, sentinel updates, and failure attribution. Never throws — the
   * returned promise resolves with the list of failure identifiers
   * (empty == success). Fire-and-forget callers (timer fire) discard the
   * return value; awaiting callers (`flush`, `flushAll`) treat
   * `failureList.length === 0` as success.
   */
  function fireWrite(key: string, args: TArgs): Promise<string[]> {
    const sentinel = opts.getSentinelInfo(args);
    const failureId = failureIdFor(args);

    if (opts.shouldSkipWrite?.(args)) {
      safeEndWrite(sentinel, true);
      return Promise.resolve([]);
    }

    // Audit-13 M3 — bump this path's write generation and capture it for the
    // `writeTimeoutMs` branch's late-success self-heal below. A skipped write
    // (above) never reaches here, so the generation tracks only real writes.
    let writeGen = 0;
    let writePathKey: VaultPath | undefined;
    if (sentinel.path) {
      writePathKey = vaultPath(sentinel.path);
      writeGen = (writeGenByPath.get(writePathKey) ?? 0) + 1;
      writeGenByPath.set(writePathKey, writeGen);
    }

    // Wrap performWrite so a synchronous throw is treated as failure
    // attribution rather than blowing up the timer callback.
    const innerPromise: Promise<string[]> = (async () => {
      const writePromise: Promise<string[]> = (async () => {
        try {
          const result = await opts.performWrite(args);
          return result?.failed ?? [];
        } catch {
          return [failureId];
        }
      })();

      // Audit5 R3 — when no bound is configured, await the write indefinitely
      // (legacy behaviour). When `writeTimeoutMs` is set, race it: a write that
      // wedges (e.g. a never-resolving drift prompt — #1 — or a stuck IPC) must
      // not hang an awaiting `flushAll`/`save()` forever.
      const timeoutMs = opts.writeTimeoutMs;
      if (timeoutMs === undefined) return writePromise;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof WRITE_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(WRITE_TIMEOUT), timeoutMs);
      });
      try {
        const outcome = await Promise.race([writePromise, timeout]);
        if (outcome === WRITE_TIMEOUT) {
          // Stopped waiting. Move the path to the failed set DIRECTLY so the
          // sentinel stays dirty even in 'pending-path' mode (where the
          // `safeEndWrite(false)` below would otherwise just drop the pending
          // path and let `syncSentinelIfIdle` mark clean — losing the recovery
          // flag for a write that never landed). Then attribute the failure.
          if (sentinel.path) {
            markPathFailed(sentinel.vaultRoot, sentinel.path);
            // Audit-12 M2 — the underlying write keeps running; we only STOPPED
            // awaiting it. Board/config/misc call their IPC directly (no
            // trackComponentWrite), so a LATE success would otherwise never clear
            // the failed mark → a permanent phantom "Save failed" + sticky
            // `.filo/.dirty` for the rest of the session while the bytes are
            // actually on disk. Self-heal on a late success. (The markdown +
            // frontmatter schedulers already self-heal via trackComponentWrite's
            // endWrite(true); the clear is idempotent there.)
            const healVaultRoot = sentinel.vaultRoot;
            const healPath = sentinel.path;
            const healGen = writeGen;
            const healKey = writePathKey;
            void writePromise.then(
              (lateFailures) => {
                if (lateFailures.length === 0) {
                  // Audit-13 M3 — only self-heal if THIS write is still the
                  // newest for its path. A newer write that FAILED in the interim
                  // bumped the generation and recorded a fresh, legitimate failed
                  // mark; clearing it here (just because an OLDER, superseded
                  // write finally landed) would falsely report the path clean and
                  // mask the newer failure. When the generations still match,
                  // no newer write fired, so the heal is safe (the M2 case).
                  if (healKey !== undefined && writeGenByPath.get(healKey) !== healGen) {
                    return;
                  }
                  clearFailedPathAfterLateSuccess(healVaultRoot, healPath);
                }
              },
              () => {
                /* late rejection — already marked failed, nothing to heal */
              },
            );
          }
          return [failureId];
        }
        return outcome;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();

    // Error-swallowed tracker so `Promise.all(inflightSnapshot)` in
    // `flushAll` cannot throw on a rejected write.
    const tracker: Promise<void> = innerPromise.then(
      () => undefined,
      () => undefined,
    );
    const entry: InFlightEntry = {
      promise: tracker,
      failureId,
      capturedFailures: null,
    };
    // Register this fire under its own entry in the key's bucket. Overlapping
    // writes for the same key each get a distinct entry, so neither cancels
    // the other's settle/endWrite (Phase F2).
    let bucket = inFlight.get(key);
    if (!bucket) {
      bucket = new Set<InFlightEntry>();
      inFlight.set(key, bucket);
    }
    bucket.add(entry);

    // Vault-swap guard: if `reset()` clears the in-flight map mid-IPC, the
    // late settle must NOT touch the new vault's sentinel state. Identity is
    // the entry object itself — a superseding write for the same key adds a
    // sibling entry rather than replacing this one, so this guard now fires
    // ONLY on a genuine reset (entry no longer present), never on overlap.
    const trackerIsCurrent = (): boolean =>
      inFlight.get(key)?.has(entry) ?? false;

    return innerPromise.then((failureList) => {
      if (!trackerIsCurrent()) return failureList;
      // Capture on the entry BEFORE removing it from the bucket so an
      // awaiting `flush(key)` (which keeps its own reference to the entry)
      // sees the settled outcome.
      entry.capturedFailures = failureList;
      const settledBucket = inFlight.get(key);
      if (settledBucket) {
        settledBucket.delete(entry);
        if (settledBucket.size === 0) inFlight.delete(key);
      }
      const success = failureList.length === 0;
      safeEndWrite(sentinel, success);
      if (success) {
        // Audit-7 L12 — a fire-and-forget write that FAILS adds its failureId
        // to `failures`; if it settles before any flush snapshots the bucket,
        // no flush ever drains that id and it leaked until `reset()` (vault
        // swap). A LATER successful write to the same id means that id is no
        // longer in a failed state, so prune it here — bounding `failures`
        // growth within a session, not just at swap. Crash recovery is
        // unaffected: the `.filo/.dirty` sentinel + `failedVaultPaths` are
        // owned by `endWrite`/`markPathFailed`, not this attribution Set.
        failures.delete(failureId);
      } else {
        for (const f of failureList) failures.add(f);
      }
      return failureList;
    });
  }

  /**
   * Audit-13 H1 / Audit-12 H4 — awaits every in-flight write currently
   * registered for `key`, for ORDERING only (failure attribution stays on each
   * entry + the shared `failures` Set — we neither consume nor remove here). A
   * fire path calls this BEFORE firing a new write for the same key so the
   * newest write lands LAST: without it, a prior write still in flight on a
   * slow/synced volume (OneDrive/SMB) overlaps the new IPC and the OS can land
   * the OLDER one last, clobbering the newer payload — and the post-write stat
   * then stamps the drift baseline to the stale bytes (no future drift warning).
   *
   * Each awaited entry is the timeout-bounded `tracker`, so a wedged prior can't
   * block past its own `writeTimeoutMs`. Snapshot the bucket first — entries
   * remove themselves from it as they settle inside `fireWrite`, so iterating
   * the live Set would skip survivors. `flush(key)` uses `consumeInflight`
   * instead (it ALSO folds the prior's outcome into its own `ok`).
   */
  async function drainPriorInFlight(key: string): Promise<void> {
    const bucket = inFlight.get(key);
    if (!bucket || bucket.size === 0) return;
    for (const priorEntry of Array.from(bucket)) await priorEntry.promise;
  }

  function schedule(
    key: string,
    getArgs: () => TArgs | null,
    delayOverride?: number,
  ): void {
    const existing = pending.get(key);
    const probe = getArgs();
    const nextSentinel: SchedulerSentinelInfo = probe
      ? opts.getSentinelInfo(probe)
      : { vaultRoot: undefined, path: undefined };

    if (existing) {
      clearTimeout(existing.timer);
      const prevSentinel: SchedulerSentinelInfo = {
        vaultRoot: existing.scheduleVaultRoot,
        path: existing.schedulePath,
      };
      opts.onReschedule?.(prevSentinel, nextSentinel);
      // 2.3 — pending-path mode: retarget the sentinel entry when a reschedule
      // changes the path (e.g. rename mid-debounce). Same-path reschedules are
      // a no-op (noteAdditionalPendingPath is idempotent on the Set), so we
      // only act on an actual change to avoid a needless drop→re-add churn.
      if (sentinelMode === 'pending-path' && prevSentinel.path !== nextSentinel.path) {
        if (prevSentinel.path) dropPendingPath(prevSentinel.vaultRoot, prevSentinel.path);
        if (nextSentinel.path) noteAdditionalPendingPath(nextSentinel.vaultRoot, nextSentinel.path);
        syncSentinelIfIdle(prevSentinel.vaultRoot);
      }
    } else {
      // New pending — count it against the sentinel for the entire debounce
      // window, not just the eventual disk-I/O window. Schedulers whose
      // `performWrite` already wraps the IPC in `trackComponentWrite`
      // (markdownFileWriter) opt out via `manageSentinel: false` to avoid
      // double-counting.
      safeBeginWrite(nextSentinel);
    }

    const debounce = delayOverride ?? opts.debounceMs;
    // Reads the freshest args and fires (or surfaces missing-source). Shared by
    // the synchronous fast path and the H1 drained path below — both re-read
    // `getArgs()` at the moment of firing so the write captures the latest state.
    const fireFromTimer = (): void => {
      const args = getArgs();
      if (!args) {
        // Source removed between schedule and fire (component unmount,
        // cache eviction, vault swap mid-debounce). Surface the loss if
        // the consumer opted in, then keep the sentinel dirty so the
        // recovery sentinel survives.
        const message = opts.missingSourceMessage?.(key);
        if (message) {
          reportError(
            opts.name,
            new Error(`scheduled write missed for "${key}": source removed before flush`),
            message,
          );
        }
        safeEndWrite(nextSentinel, false);
        return;
      }
      // Snapshot at fire time (Phase C/C.5 for board scheduler). Other
      // schedulers omit `snapshotArgs` — they pass args straight through.
      const snapshotted = opts.snapshotArgs ? opts.snapshotArgs(args) : args;
      // Fire-and-forget. Failure attribution lives on `failures` Set;
      // `flushAll` consumes from there when it awaits in-flight writes.
      void fireWrite(key, snapshotted);
    };
    const timer = setTimeout(() => {
      pending.delete(key);
      // Audit-13 H1 — serialize the timer fire behind any write still in flight
      // for this key so the newest write lands LAST (mirrors flush()'s WC-3 and
      // flushAll()'s H4 pre-drain). Without this, the debounced fire overlapped a
      // prior in-flight write on a slow/synced volume and the OS could land the
      // OLDER one last, clobbering the newer .board.json/config payload (the
      // post-write stat then stamps the drift baseline to the stale bytes).
      const priorBucket = inFlight.get(key);
      if (priorBucket && priorBucket.size > 0) {
        // A prior write is in flight — drain it first, THEN fire (re-reading args
        // for the freshest state). A reschedule landing during the drain arms its
        // own timer; both fires serialize via this same drain and last-wins, so
        // the extra write is benign. The drain awaits the timeout-bounded
        // tracker, so a wedged prior can't block past its `writeTimeoutMs`.
        void (async () => {
          await drainPriorInFlight(key);
          fireFromTimer();
        })();
      } else {
        // Common case — nothing in flight for this key. Fire synchronously so
        // the in-flight entry registers before the next microtask, preserving
        // the sync-fire timing flush()/flushAll() and the test suite rely on.
        fireFromTimer();
      }
    }, debounce);

    pending.set(key, {
      timer,
      getArgs,
      scheduleVaultRoot: nextSentinel.vaultRoot,
      schedulePath: nextSentinel.path,
    });
  }

  function cancel(key: string, fallbackPath?: string): void {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    const resolvedPath = fallbackPath ?? entry.schedulePath;
    safeEndWrite({ vaultRoot: entry.scheduleVaultRoot, path: resolvedPath }, true);
  }

  function cancelAll(): void {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    // Intentionally NO endWrite — the vault-swap caller (or other batch
    // reset) is expected to follow with `resetWriteTracking`, which resets
    // the inflight counter and tracking sets in one shot. Calling endWrite
    // here would race with that reset.
  }

  async function flush(
    key: string,
    overrideGetArgs?: () => TArgs | null,
  ): Promise<{ ok: boolean }> {
    const pendingEntry = pending.get(key);
    const initialBucket = inFlight.get(key);

    if (!pendingEntry && (!initialBucket || initialBucket.size === 0)) {
      return { ok: true };
    }

    let success = true;

    // Consumes an in-flight entry's settled outcome into `success` + the shared
    // failures Set. Shared by the WC-3 pre-drain and the post-fire drain below.
    const consumeInflight = async (entry: InFlightEntry): Promise<void> => {
      await entry.promise;
      // Captured failures live on the entry — `flush(key)` consumes them from
      // the shared Set so a subsequent `flushAll` doesn't double-report. Falls
      // back to the primary failureId for the legacy throw-only path where
      // `capturedFailures` stayed null (vault swap mid-IPC), matching the legacy
      // board scheduler's attribution.
      const captured = entry.capturedFailures;
      if (captured && captured.length > 0) {
        success = false;
        for (const f of captured) failures.delete(f);
      } else if (captured === null && failures.delete(entry.failureId)) {
        success = false;
      }
    };

    if (pendingEntry) {
      // Audit-11 WC-3 — disarm the pending timer UP-FRONT (before any await), so
      // it can't self-fire during the in-flight drain below and double-write.
      clearTimeout(pendingEntry.timer);
      pending.delete(key);

      // WC-3 — when a write is ALREADY in-flight for this key, drain it BEFORE
      // firing the pending one so the pending write (newest args) lands LAST.
      // Previously the pending fire ran concurrently with the older in-flight
      // write; markdown/frontmatter writes serialize per path so they were
      // safe, but a non-serialized scheduler (board/config/misc) could let the
      // OLDER write win the atomic-rename race and clobber the newer payload.
      // Snapshot the prior set now — the pending fire adds its own entry, which
      // is drained by the post-fire loop below.
      const priorBucket = inFlight.get(key);
      if (priorBucket && priorBucket.size > 0) {
        for (const priorEntry of Array.from(priorBucket)) await consumeInflight(priorEntry);
      }

      // Fire the pending write. Args are read NOW (after the drain) so a
      // live-cache getter captures the freshest state; the just-disarmed timer
      // guarantees this is the only fire of this pending entry.
      const argsGetter = overrideGetArgs ?? pendingEntry.getArgs;
      const args = argsGetter();
      if (!args) {
        const message = opts.missingSourceMessage?.(key);
        if (message) {
          reportError(
            opts.name,
            new Error(`flush missed for "${key}": source removed before flush`),
            message,
          );
        }
        safeEndWrite(
          { vaultRoot: pendingEntry.scheduleVaultRoot, path: pendingEntry.schedulePath },
          false,
        );
        success = false;
      } else {
        const snapshotted = opts.snapshotArgs ? opts.snapshotArgs(args) : args;
        const failureList = await fireWrite(key, snapshotted);
        if (failureList.length > 0) success = false;
        // Drain attributed failures from the shared Set so a later flushAll
        // doesn't double-report them.
        for (const f of failureList) failures.delete(f);
      }
    }

    // Await every remaining in-flight write for this key. Overlapping fires each
    // own a bucket entry (Phase F2); the freshly fired pending write above and
    // any WC-3 pre-drained entries already settled and removed themselves, so
    // this catches the only-in-flight (no pending) case and any fire that
    // appeared concurrently. Snapshot the survivors now — fireWrite's settle
    // callback removes them from the bucket as they land.
    const bucket = inFlight.get(key);
    const inflightEntries = bucket ? Array.from(bucket) : [];
    for (const inflightEntry of inflightEntries) {
      await consumeInflight(inflightEntry);
    }

    return { ok: success };
  }

  async function flushAll(): Promise<FlushAllResult> {
    interface DrainedEntry {
      key: string;
      /** Args + snapshot captured synchronously upfront — frozen before any await. */
      args: TArgs | null;
      scheduleVaultRoot: string | undefined;
      schedulePath: string | undefined;
    }

    // Capture pending entries' args AND snapshot synchronously upfront.
    // Phase 25 L12 / C/C.5 — without this, a propagateRename mutation that
    // lands between iterations of the await loop could rebind one board's
    // path onto another, or a mid-flush cache mutation could leak into a
    // later board's payload. Calling `getArgs` and `snapshotArgs` inside
    // this synchronous loop freezes both the path AND the payload before
    // any disk I/O begins.
    const drained: DrainedEntry[] = [];
    for (const [key, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      const rawArgs = entry.getArgs();
      const args = rawArgs && opts.snapshotArgs
        ? opts.snapshotArgs(rawArgs)
        : rawArgs;
      drained.push({
        key,
        args,
        scheduleVaultRoot: entry.scheduleVaultRoot,
        schedulePath: entry.schedulePath,
      });
    }
    pending.clear();

    // Snapshot in-flight up-front so a write that resolves between this
    // capture and our await loop is still surfaced via failure attribution.
    // Holds the live entry reference so post-settle capturedFailures are
    // visible after `await`. Flatten every key's bucket — overlapping fires
    // for one key each hold a distinct entry (Phase F2), all of which must be
    // awaited and attributed.
    const inflightSnapshot: { key: string; entry: InFlightEntry }[] = [];
    for (const [key, bucket] of inFlight.entries()) {
      for (const entry of bucket) inflightSnapshot.push({ key, entry });
    }

    let trackedVault: string | undefined;
    const failed: string[] = [];
    // 6.3.P4 — track drained entries (drained-pending + drained-inflight) so
    // we can return `ok = drained - failed`. Counted from the synchronous
    // capture loops above so a late-arriving write doesn't shift the
    // denominator under us.
    const drainedTotal = drained.length + inflightSnapshot.length;

    for (const entry of drained) {
      if (!entry.args) {
        const message = opts.missingSourceMessage?.(entry.key);
        if (message) {
          reportError(
            opts.name,
            new Error(`flushAll missed for "${entry.key}": source removed before flush`),
            message,
          );
        }
        safeEndWrite(
          { vaultRoot: entry.scheduleVaultRoot, path: entry.schedulePath },
          false,
        );
        const id = entry.schedulePath ?? entry.key;
        if (!failed.includes(id)) failed.push(id);
        continue;
      }
      // Audit-12 H4 / Audit-13 H1 — mirror flush()'s WC-3 pre-drain via the
      // shared `drainPriorInFlight` helper. For a non-serialized scheduler
      // (board/config/misc) an OLDER write can already be in flight for this key
      // (it's in `inflightSnapshot` above). Drain it BEFORE firing the pending
      // (newest) write so the newest lands LAST; otherwise the OS can land the
      // stale write last on a slow OneDrive/SMB volume and clobber the newer
      // .board.json/config payload. These prior entries stay in `inflightSnapshot`,
      // so their failure attribution still runs in the post-loop below — here we
      // only enforce write ORDERING (await, don't consume).
      //
      // Guard the await on a NON-EMPTY bucket: `await drainPriorInFlight(...)`
      // yields a microtask even when nothing is in flight, which would defer
      // `fireWrite` (and its synchronous IPC dispatch) one tick — breaking
      // callers that fire-and-don't-await `flushAll()` and then synchronously
      // observe the write has begun (A9-L7's mid-save assertion).
      const prior = inFlight.get(entry.key);
      if (prior && prior.size > 0) await drainPriorInFlight(entry.key);
      const sentinel = opts.getSentinelInfo(entry.args);
      if (sentinel.vaultRoot) trackedVault = sentinel.vaultRoot;
      const failureList = await fireWrite(entry.key, entry.args);
      for (const f of failureList) {
        failures.delete(f);
        if (!failed.includes(f)) failed.push(f);
      }
    }

    if (inflightSnapshot.length > 0) {
      // Trackers swallow rejection so Promise.all cannot throw.
      await Promise.all(inflightSnapshot.map((e) => e.entry.promise));
      for (const e of inflightSnapshot) {
        const captured = e.entry.capturedFailures;
        if (captured && captured.length > 0) {
          // Partial-failure attribution: the entry's capturedFailures
          // carries the exact id list `performWrite` reported, which may
          // differ from the primary failureId for bundle writers.
          for (const f of captured) {
            failures.delete(f);
            if (!failed.includes(f)) failed.push(f);
          }
        } else if (captured === null && failures.delete(e.entry.failureId)) {
          // Legacy throw-attribution path — entry was cleared by reset()
          // mid-IPC so capturedFailures stayed null; consult the global
          // failures Set for any matching primary failureId.
          if (!failed.includes(e.entry.failureId)) failed.push(e.entry.failureId);
        }
      }
    }

    const ok = Math.max(0, drainedTotal - failed.length);
    return { vaultRoot: trackedVault, failed, ok };
  }

  function reset(): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      // 2.3 — pending-path mode owns its entries in the shared ledger; drop
      // them so a reset() outside the vault-swap path (e.g. per-test cleanup,
      // where `resetWriteTracking` isn't also called) can't strand a dirty
      // sentinel path. On vault swap, `resetWriteTracking` clears the ledger
      // wholesale anyway, so this is a harmless no-op there.
      if (sentinelMode === 'pending-path' && entry.schedulePath) {
        dropPendingPath(entry.scheduleVaultRoot, entry.schedulePath);
      }
    }
    pending.clear();
    inFlight.clear();
    failures.clear();
    // Audit-13 M3 — drop the per-path generations so the new vault's first write
    // to a same-named path starts at generation 1 (a stale late-success
    // continuation from the outgoing vault no longer matches and can't heal).
    writeGenByPath.clear();
  }

  function hasPending(predicate: (args: TArgs) => boolean): boolean {
    for (const entry of pending.values()) {
      const args = entry.getArgs();
      if (args && predicate(args)) return true;
    }
    return false;
  }

  function __failuresSizeForTests(): number {
    return failures.size;
  }

  return { schedule, cancel, cancelAll, flush, flushAll, reset, hasPending, __failuresSizeForTests };
}

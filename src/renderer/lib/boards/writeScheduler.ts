/**
 * writeScheduler — unified primitive for debounced disk-write pipelines.
 *
 * Five legacy scheduler modules (board / markdown / frontmatter / config / misc)
 * each reimplemented the same shape (pending + in-flight Maps, failure Set, timer
 * cancellation, begin/endWrite). Two dropped in-flight failure attribution and
 * silently reported "saved" while writes rejected (markdownFileWriter never
 * populated its failures Set; configWriteScheduler had no in-flight map, so
 * `flushScheduledConfig` returned `null` the moment the timer fired).
 * `createScheduler(opts)` owns the shared bookkeeping; each consumer supplies
 * `performWrite`, a sentinel-info mapper, and a few policy hooks.
 *
 * Contract:
 *  - One `beginWrite` per `schedule()` (the debounce window covers sentinel state
 *    from arming to disk landing); one matching `endWrite` per outcome (timer-fire
 *    success/failure, flush, missing-source, skipped, single-key cancel).
 *  - `cancelAll()` is the vault-swap exception — pairs are NOT closed because
 *    `resetWriteTracking` resets the counter (legacy deferred-cleanup contract).
 *  - `reset()` clears in-flight trackers so a late `.then`/`.catch` against the
 *    OUTGOING vault can't mutate the new one (the `trackerIsCurrent` guard in
 *    `fireWrite` also covers that race).
 *
 * Failure attribution: `performWrite` resolves (success), resolves `{ failed }`
 * (per-target partial failure — config bundle), or throws (whole-write → one
 * failureId). Failures aggregate into a shared Set, drained per-key by
 * `flush()` / `flushAll()` so the Ctrl+S aggregate boolean stays honest.
 */

import {
  beginWrite,
  endWrite,
  noteAdditionalPendingPath,
  dropPendingPath,
  syncSentinelIfIdle,
  markPathFailed,
  clearFailedPathAfterLateSuccess,
  isPathPending,
  mintWriteGeneration,
} from './writeStateTracking';
import { reportError } from '../utils/errorBus';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';
import type {
  CreateSchedulerOptions,
  FlushAllResult,
  InFlightEntry,
  ParkedEntry,
  PendingEntry,
  Scheduler,
  SchedulerSentinelInfo,
} from './writeSchedulerTypes';
import { createFailureLedger, isRetainableWriteError, registerRetryHook } from './writeSchedulerFailures';

/**
 * Audit5 R3 — sentinel a `performWrite` race resolves to when it outruns the
 * optional `writeTimeoutMs` bound. A module-level unique symbol so the
 * `Promise.race` outcome type discriminates cleanly from a `string[]` failure
 * list (whose entries are paths / callerIds, never this token).
 */
const WRITE_TIMEOUT: unique symbol = Symbol('write-timeout');

// Public type surface — moved to writeSchedulerTypes.ts (Audit-16 Phase 4
// ci:file-sizes split); re-exported so existing importers are unchanged.
export type {
  CreateSchedulerOptions,
  FlushAllResult,
  PerformWriteContext,
  PerformWriteResult,
  Scheduler,
  SchedulerSentinelInfo,
} from './writeSchedulerTypes';

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
   * Audit-14 1.1 — PARKED fires. A debounce timer firing for a key with a write
   * already in flight DEFERS the new write behind `drainPriorInFlight(key)` so the
   * newest lands LAST (Audit-13 H1). During that await it is in NEITHER `pending`
   * (timer deleted it) NOR `inFlight` (`fireWrite` hasn't run); `flush`/`flushAll`
   * snapshot both maps once, so a flush in that gap could resolve before the newest
   * edit landed. Each parked fire registers a promise here BEFORE the await and
   * resolves it once `fireFromTimer` registered the `inFlight` entry (or no-op'd),
   * so it's never in none of {pending, parked, inFlight}; `flush`/`flushAll` await
   * these then re-drain. A Set per key tracks two parked fires for one key.
   * Audit-16 4.4 — entries are {@link ParkedEntry} objects carrying the
   * schedule-time sentinel info + a `cancelled` flag, so `cancel(key)` can reach
   * a parked fire (see `cancel` below).
   */
  const parked = new Map<string, Set<ParkedEntry>>();

  const addParked = (key: string, entry: ParkedEntry): void => {
    let set = parked.get(key);
    if (!set) {
      set = new Set<ParkedEntry>();
      parked.set(key, set);
    }
    set.add(entry);
  };
  const removeParked = (key: string, entry: ParkedEntry): void => {
    const set = parked.get(key);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) parked.delete(key);
  };
  const anyParked = (): boolean => {
    for (const set of parked.values()) if (set.size > 0) return true;
    return false;
  };
  // Failure attribution (per-id Set + Audit-16 4.7 per-key record) and Audit-19
  // EXT-5 RETENTION of failed fires' args live in writeSchedulerFailures.ts.
  const ledger = createFailureLedger<TArgs>();
  /**
   * Audit-13 M3 — per-path write generation: the value last minted for a
   * path when a write FIRED for it (in `fireWrite`), captured at fire time. A
   * timed-out write's late-success self-heal (the `writeTimeoutMs` branch's
   * `clearFailedPathAfterLateSuccess` continuation) consults this so it only
   * clears the failed mark when THIS write is still the newest for its path —
   * otherwise an OLDER, superseded write finally landing would erase a NEWER
   * write's legitimate failure recorded in the interim, falsely reporting the
   * path clean. Keyed by the case-folded `VaultPath` so two fires for the same
   * file (differing only in OS casing) share one generation. Cleared on
   * vault swap via `reset()`.
   *
   * Audit-16 4.1 — values are minted from the session-monotonic
   * `mintWriteGeneration` counter (shared with `componentWriteGenByPath`),
   * NOT a per-path `(get(key) ?? 0) + 1`: the Audit-14 1.6 success-path
   * prune deletes the entry, so a per-path re-mint restarted at 1 and could
   * COLLIDE with a generation an older timed-out write's heal continuation
   * still holds — erasing a newer write's legitimate failed mark.
   */
  const writeGenByPath = new Map<VaultPath, number>();
  /**
   * Audit-16 3.4 — scheduler-wide generation, bumped by `reset()` (the vault
   * swap). A PARKED fire's async closure survives `reset()` (the timer
   * already fired, so cancelAll's clearTimeout can't reach it); when the old
   * write finally settles, the dangling closure resumed and called
   * `fireFromTimer()` against the NEW vault's fresh tracking state — the
   * missing-source branch's direct `safeEndWrite(false)` never passes
   * `fireWrite`'s `trackerIsCurrent` settle guard (contrary to what reset()'s
   * pre-fix comment claimed), so the OLD vault's path entered the new
   * session's failed set + `.filo/.dirty` (false "couldn't save" toast,
   * phantom recovery prompt next launch); a still-non-null `getArgs()` even
   * re-FIRED the stale write into the fresh `inFlight` map. The closure
   * captures this generation at park time and bails after the drain when it
   * moved. (Audit-16 4.4 extends the same mechanism to per-key `cancel()`.)
   */
  let schedulerGeneration = 0;

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
  function fireWrite(key: string, args: TArgs, retainGetArgs?: () => TArgs | null): Promise<string[]> {
    const sentinel = opts.getSentinelInfo(args);
    const failureId = failureIdFor(args);
    let failError: unknown; // Audit-19 EXT-5 — decides retention of a failed fire

    if (opts.shouldSkipWrite?.(args)) {
      safeEndWrite(sentinel, true);
      return Promise.resolve([]);
    }

    // Audit-13 M3 — mint this path's write generation and capture it for the
    // `writeTimeoutMs` branch's late-success self-heal below. A skipped write
    // (above) never reaches here, so the generation tracks only real writes.
    // Audit-16 4.1 — minted from the session-monotonic counter so a pruned-
    // then-recreated path entry can never reissue a generation an older
    // write's heal continuation still holds (see `writeGenByPath`'s doc).
    let writeGen = 0;
    let writePathKey: VaultPath | undefined;
    if (sentinel.path) {
      writePathKey = vaultPath(sentinel.path);
      writeGen = mintWriteGeneration();
      writeGenByPath.set(writePathKey, writeGen);
    }

    // Wrap performWrite so a synchronous throw is treated as failure
    // attribution rather than blowing up the timer callback.
    const innerPromise: Promise<string[]> = (async () => {
      const writePromise: Promise<string[]> = (async () => {
        try {
          // Audit-14 1.4 — hand the write a currency check. A write whose IPC
          // overruns `writeTimeoutMs` and lands AFTER a newer write for the same
          // path fired is superseded; `isLatestWrite()` lets it skip its
          // post-write drift-baseline stamp so the baseline isn't anchored to
          // stale bytes (which would defeat the next drift check).
          const result = await opts.performWrite(args, {
            isLatestWrite: () =>
              writePathKey === undefined || writeGenByPath.get(writePathKey) === writeGen,
          });
          return result?.failed ?? [];
        } catch (err) {
          failError = err;
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
          failError = { code: 'WRITE_TIMEOUT' };
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
        // Audit-7 L12 / Audit-16 4.7 — prune this key's attributed ids (and any
        // retained re-fire) so the ledger can't grow for the whole session.
        // Crash recovery is unaffected: `.filo/.dirty` + `failedVaultPaths` are
        // owned by `endWrite`/`markPathFailed`, not this attribution ledger.
        ledger.recordSuccess(key, failureId);
        // Audit-14 1.6 — prune this path's write-generation entry on a still-
        // newest, now-clean success (checked AFTER `safeEndWrite` cleared this
        // write from the pending/failed sets), bounding `writeGenByPath` growth
        // within a session (was cleared only on vault swap). A later write
        // re-creates it at gen 1; a timed-out write keeps its entry (settles via
        // the failure branch, which the late-heal gen guard still needs).
        if (
          writePathKey !== undefined &&
          writeGenByPath.get(writePathKey) === writeGen &&
          !(sentinel.path && isPathPending(sentinel.path))
        ) {
          writeGenByPath.delete(writePathKey);
        }
      } else {
        ledger.recordFailed(key, failureList);
        // Audit-19 EXT-5 — keep a transient failure's args getter so the next
        // flushAll (Ctrl+S, quit drain, Retry) re-fires it instead of the edit
        // living only in memory. User-deferred / validation failures carry no
        // RETAINABLE code and are not re-fired (they would re-prompt).
        if (retainGetArgs && isRetainableWriteError(failError)) ledger.retain(key, retainGetArgs);
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
    ledger.release(key); // Audit-19 EXT-5 — newer args supersede a retained failed fire
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
      // Fire-and-forget. Failure attribution lives on the ledger; `flushAll`
      // consumes from there when it awaits in-flight writes.
      void fireWrite(key, snapshotted, getArgs);
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
        //
        // Audit-14 1.1 — register a PARKED promise BEFORE awaiting the drain so
        // this deferred fire is visible to `flush()` / `flushAll()` while it
        // waits (it is in neither `pending` nor `inFlight` yet). Resolve it only
        // after `fireFromTimer` has registered the `inFlight` entry (or no-op'd),
        // so there is no gap where the write is in no structure.
        let resolveParked!: () => void;
        const parkedPromise = new Promise<void>((res) => { resolveParked = res; });
        const parkedEntry: ParkedEntry = {
          promise: parkedPromise,
          vaultRoot: nextSentinel.vaultRoot,
          path: nextSentinel.path,
          cancelled: false,
        };
        addParked(key, parkedEntry);
        // Audit-16 3.4 — capture the scheduler generation at park time; a
        // `reset()` (vault swap) during the drain bumps it, and the dangling
        // closure must then neither fire (a stale write into the NEW vault's
        // fresh inFlight map) nor surface missing-source (its direct
        // `safeEndWrite(false)` would pollute the new session's failed set +
        // sentinel with the OUTGOING vault's path). The parked promise still
        // resolves via `finally`, so nothing awaiting it can hang.
        const parkedGeneration = schedulerGeneration;
        void (async () => {
          try {
            await drainPriorInFlight(key);
            if (schedulerGeneration !== parkedGeneration) return;
            // Audit-16 4.4 — `cancel(key)` reached this parked fire during
            // the drain (e.g. the board was deleted mid-park). The cancel
            // already emitted the balanced endWrite(true); firing now would
            // either resurrect a write against the deleted target or take
            // the missing-source branch — a false "couldn't save" toast plus
            // a failed mark for a path no later write can ever clear.
            if (parkedEntry.cancelled) return;
            fireFromTimer();
          } finally {
            removeParked(key, parkedEntry);
            resolveParked();
          }
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

  function cancel(key: string, fallbackPath?: string, pendingOnly = false): void {
    const entry = pending.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(key);
      const resolvedPath = fallbackPath ?? entry.schedulePath;
      safeEndWrite({ vaultRoot: entry.scheduleVaultRoot, path: resolvedPath }, true);
    }
    if (pendingOnly) return; // Audit-18 H1 — skip the parked-fire cancel below; a teardown that already flushed owns it (see Scheduler.cancel doc).
    // Audit-16 4.4 — also reach PARKED fires. A debounce timer that fired
    // into the drained branch is in NEITHER `pending` (timer deleted it) NOR
    // `inFlight` (it hasn't fired yet) while it awaits the drain, so the
    // pending-only cancel above silently misses it: a board deleted mid-park
    // had its parked fire resume AFTER the `board:delete` IPC, hit the
    // missing-source branch (getArgs → null), and planted the deleted
    // board's path in `failedVaultPaths` for the session — false "couldn't
    // save" toast, sticky `.filo/.dirty`, phantom recovery prompt next
    // launch. Each un-cancelled parked fire owes exactly one endWrite (its
    // schedule's beginWrite); emit the balanced success here, exactly as for
    // a pending timer, and let the parked closure bail.
    const parkedSet = parked.get(key);
    if (!parkedSet) return;
    for (const parkedEntry of parkedSet) {
      if (parkedEntry.cancelled) continue;
      parkedEntry.cancelled = true;
      safeEndWrite(
        { vaultRoot: parkedEntry.vaultRoot, path: fallbackPath ?? parkedEntry.path },
        true,
      );
    }
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
    // Audit-15 P1.1 — a PARKED fire (a debounce fire deferred behind an in-flight
    // write by `drainPriorInFlight`) is in NEITHER `pending` nor `inFlight` while
    // it waits, so this early-return must check `parked` too — matching the drain
    // loop below + `flushAll()`. Without it, in the microtask gap after the prior
    // write leaves `inFlight` but before the parked fire registers its own entry,
    // a single-key `flush` (tab-close) saw both maps empty and returned {ok:true}
    // before the newest edit landed — a false "saved".
    const initialParked = parked.get(key);
    if (
      !pendingEntry &&
      (!initialBucket || initialBucket.size === 0) &&
      !(initialParked && initialParked.size > 0)
    ) {
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
        for (const f of captured) ledger.consume(f);
      } else if (captured === null && ledger.consume(entry.failureId)) {
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
        const failureList = await fireWrite(key, snapshotted, argsGetter);
        if (failureList.length > 0) success = false;
        // Drain attributed failures from the shared Set so a later flushAll
        // doesn't double-report them.
        for (const f of failureList) ledger.consume(f);
      }
    }

    // Await every remaining in-flight write for this key AND any PARKED fire
    // (Audit-14 1.1) until both are quiescent. Overlapping fires each own a
    // bucket entry (Phase F2); the freshly fired pending write above and any
    // WC-3 pre-drained entries already settled and removed themselves. A parked
    // fire (deferred behind a prior in-flight write) is in neither map while it
    // waits — await its promise (which resolves once it has registered its own
    // `inFlight` entry), then the next loop pass drains that fresh entry.
    // Bounded so a pathological reschedule chain can't hang the flush.
    let guard = 0;
    do {
      const bucket = inFlight.get(key);
      for (const inflightEntry of bucket ? Array.from(bucket) : []) {
        await consumeInflight(inflightEntry);
      }
      const parkedSet = parked.get(key);
      if (parkedSet && parkedSet.size > 0) {
        await Promise.all(Array.from(parkedSet, (p) => p.promise));
      }
      guard++;
    } while ((inFlight.get(key)?.size || parked.get(key)?.size) && guard < 50);
    if (guard >= 50) {
      console.warn(`[${opts.name}] flush("${key}") drain hit the iteration bound (50) — possible reschedule loop.`);
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
      getArgs: () => TArgs | null;
    }
    drainRetained(); // Audit-19 EXT-5 — re-fire every retained failed write once

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
        getArgs: entry.getArgs,
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
      const failureList = await fireWrite(entry.key, entry.args, entry.getArgs);
      for (const f of failureList) {
        ledger.consume(f);
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
            ledger.consume(f);
            if (!failed.includes(f)) failed.push(f);
          }
        } else if (captured === null && ledger.consume(e.entry.failureId)) {
          // Legacy throw-attribution path — entry was cleared by reset()
          // mid-IPC so capturedFailures stayed null; consult the global
          // failures Set for any matching primary failureId.
          if (!failed.includes(e.entry.failureId)) failed.push(e.entry.failureId);
        }
      }
    }

    // Audit-14 1.1 — drain PARKED fires until quiescent. A timer that fired into
    // the drained branch is deferred behind a prior in-flight write — in neither
    // `pending` nor the `inflightSnapshot` above — so without this `flushAll`
    // (hence `save()`/quit) could resolve while the newest edit hadn't landed.
    // Re-drain BOTH fresh in-flight entries AND still-parked promises each pass:
    // a parked fire transitions parked → in-flight when the prior write resolves
    // and may already be in `inFlight` (not the snapshot) by the time we look.
    // Bounded so a reschedule chaining behind a wedge can't strand the flush.
    let parkedDrainedTotal = 0;
    let parkedGuard = 0;
    while ((anyParked() || inFlight.size > 0) && parkedGuard < 50) {
      parkedGuard++;
      // Drain freshly-registered in-flight entries (a parked fire that already
      // fired, or any write that appeared after the snapshot). Snapshot the live
      // buckets — entries self-remove from them as they settle in `fireWrite`.
      const fresh: InFlightEntry[] = [];
      for (const bucket of inFlight.values()) for (const entry of bucket) fresh.push(entry);
      if (fresh.length > 0) {
        await Promise.all(fresh.map((e) => e.promise));
        for (const entry of fresh) {
          parkedDrainedTotal++;
          const captured = entry.capturedFailures;
          if (captured && captured.length > 0) {
            for (const f of captured) {
              ledger.consume(f);
              if (!failed.includes(f)) failed.push(f);
            }
          }
        }
      }
      // Await any parked promise so its deferred fire registers an in-flight
      // entry (drained on the next pass). Resolves once the fire has fired or
      // no-op'd, so a still-parked write can't slip past the loop condition.
      if (anyParked()) {
        const parkedPromises: Promise<void>[] = [];
        for (const set of parked.values()) for (const p of set) parkedPromises.push(p.promise);
        await Promise.all(parkedPromises);
      }
    }
    if (parkedGuard >= 50) {
      console.warn(`[${opts.name}] flushAll parked-drain hit the iteration bound (50) — possible reschedule loop.`);
    }

    const ok = Math.max(0, drainedTotal + parkedDrainedTotal - failed.length);
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
    // Audit-14 1.1 — drop parked-fire references. A dangling parked async
    // closure (already past `pending.delete`, awaiting the now-cleared drain)
    // still resolves its own promise in its `finally`; clearing here just stops
    // new flushes from seeing the stale entry.
    // Audit-16 3.4 — the generation bump below is what actually neutralises
    // the dangling closure: it bails after its drain instead of firing or
    // calling the missing-source `safeEndWrite(false)` against the new
    // vault's fresh tracking state (the pre-fix comment here wrongly claimed
    // the `trackerIsCurrent` settle guard covered that path — the
    // missing-source branch never reaches `fireWrite`).
    parked.clear();
    schedulerGeneration += 1;
    ledger.clear(); // attribution ids, per-key records AND retained re-fires (outgoing vault)
    // Audit-13 M3 — drop the per-path generations so the new vault's first write
    // to a same-named path starts at generation 1 (a stale late-success
    // continuation from the outgoing vault no longer matches and can't heal).
    writeGenByPath.clear();
  }

  /**
   * Audit-19 EXT-5 — moves retained failed fires back into `pending` (delay 0)
   * so the caller's drain re-fires them with FRESH args. A key already pending
   * is superseded by its newer args; a source that vanished (null args) is
   * dropped silently (its failed mark + sentinel stay — no false toast).
   */
  function drainRetained(key?: string): void {
    for (const [k, getArgs] of ledger.takeRetained(key)) {
      if (!pending.has(k) && getArgs()) schedule(k, getArgs, 0);
    }
  }

  /** Audit-19 EXT-5 — Retry: re-fire retained failed writes and await them. */
  async function retryFailed(key?: string): Promise<{ failed: string[] }> {
    if (!ledger.hasRetained(key)) return { failed: [] };
    if (key !== undefined) {
      drainRetained(key);
      return { failed: (await flush(key)).ok ? [] : [key] };
    }
    return { failed: (await flushAll()).failed };
  }
  registerRetryHook(() => retryFailed());

  function hasPendingTimer(predicate: (args: TArgs) => boolean): boolean {
    for (const entry of pending.values()) {
      const args = entry.getArgs();
      if (args && predicate(args)) return true;
    }
    return false;
  }

  // Audit-17 5.5 — true when a non-cancelled PARKED fire matches `predicate` (a
  // fire deferred behind drainPriorInFlight, in neither `pending` nor `inFlight`).
  // SEPARATE from `hasPendingTimer` (P2.5 armed-timer-only); probes that must not
  // report idle/clean over a newer parked write OR the two. Parked entries carry
  // no args → the predicate sees the schedule-time `{ key, path }`.
  function hasParked(predicate: (info: { key: string; path: string | undefined }) => boolean): boolean {
    for (const [key, set] of parked.entries()) {
      for (const entry of set) {
        if (!entry.cancelled && predicate({ key, path: entry.path })) return true;
      }
    }
    return false;
  }

  function __failuresSizeForTests(): number {
    return ledger.size();
  }

  function __writeGenSizeForTests(): number {
    return writeGenByPath.size;
  }

  /**
   * Test-only (Audit-15 P1.1) — constructs the production-unreachable state where
   * a parked fire is pending but `pending`/`inFlight` are empty (the prior
   * in-flight write already settled + removed itself; the parked fire has not yet
   * registered its own `inFlight` entry — a one-microtask gap no external code can
   * land in). Returns a release that clears the parked entry, mirroring the parked
   * IIFE's `removeParked` tail. Lets a test prove `flush(key)` no longer reports
   * success while a write is still parked.
   */
  function __parkForTests(key: string): () => void {
    let release!: () => void;
    const parkedPromise = new Promise<void>((res) => { release = res; });
    const entry: ParkedEntry = {
      promise: parkedPromise,
      vaultRoot: undefined,
      path: undefined,
      cancelled: false,
    };
    addParked(key, entry);
    return () => { removeParked(key, entry); release(); };
  }

  return {
    schedule,
    cancel,
    cancelAll,
    flush,
    flushAll,
    retryFailed,
    reset,
    hasPendingTimer,
    hasParked,
    __failuresSizeForTests,
    __writeGenSizeForTests,
    __parkForTests,
  };
}

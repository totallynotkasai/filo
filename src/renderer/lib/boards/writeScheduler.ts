/**
 * writeScheduler — unified primitive for debounced disk-write pipelines
 * (board / markdown / frontmatter / config / misc). `createScheduler(opts)` owns
 * the shared bookkeeping (pending + in-flight maps, failure attribution, timer
 * cancellation, begin/endWrite); each consumer supplies `performWrite`, a
 * sentinel-info mapper, and a few policy hooks.
 *
 * Contract:
 *  - One `beginWrite` per `schedule()` (the debounce window covers sentinel state
 *    from arming to disk landing); one matching `endWrite` per outcome (timer-fire
 *    success/failure, flush, missing-source, skipped, single-key cancel).
 *  - `cancelAll()` is the vault-swap exception — pairs are NOT closed because
 *    `resetWriteTracking` resets the counter.
 *  - `reset()` clears in-flight trackers so a late `.then`/`.catch` against the
 *    OUTGOING vault can't mutate the new one (the `trackerIsCurrent` guard in
 *    `fireWrite` also covers that race).
 *
 * Failure attribution: `performWrite` resolves, resolves `{ failed }` (config
 * bundle), or throws (one failureId) — see the ledger in writeSchedulerFailures.ts.
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
  registerArmedPathSource,
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
import { newParkedEntry, ParkedWrites } from './writeSchedulerParked';

/**
 * What a `performWrite` race resolves to when it outruns the optional
 * `writeTimeoutMs` bound. A unique symbol so the `Promise.race` outcome
 * discriminates cleanly from a `string[]` failure list.
 */
const WRITE_TIMEOUT: unique symbol = Symbol('write-timeout');

// Public types live in writeSchedulerTypes.ts; re-exported unchanged.
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
   * In-flight writes are tracked per-fire, not per-key: each `fireWrite` adds its
   * own entry to the key's bucket, so overlapping writes for one key each settle
   * with their own `endWrite`. Keyed by `key` alone, a second fire would overwrite
   * the first entry and strand its `beginWrite` (save indicator stuck on
   * "saving", `.filo/.dirty` never cleared).
   */
  const inFlight = new Map<string, Set<InFlightEntry>>();
  /** Writes in neither `pending` nor `inFlight` (see `writeSchedulerParked.ts`). */
  const parked = new ParkedWrites();

  /** An entry a full save (`flushAll`) took from `pending`, to send in its turn. */
  interface Capture {
    key: string;
    /** Args + snapshot captured synchronously upfront — frozen before any await. */
    args: TArgs | null;
    scheduleVaultRoot: string | undefined;
    schedulePath: string | undefined;
    getArgs: () => TArgs | null;
    /** Registered as parked until it fires, so `flush(key)` / `hasWork` still see it while it waits its turn. */
    parked: ParkedEntry;
    resolveParked: () => void;
  }
  /**
   * A full save's captures not sent yet, per key. Each holds its key's args as
   * they were when the save began, so a newer `schedule` of the key takes its
   * place (`takeCapture`) and the full save skips it: sent after the newer
   * write (which doesn't wait for it), it would land the older bytes last,
   * and nothing would report the newer change unsaved.
   */
  const captures = new Map<string, Capture>();

  /**
   * Takes `key`'s capture out of the full save that holds it: marked
   * superseded so the save skips it, no longer parked, its waiters released
   * (a `flush(key)` among them sends the newer write instead). Its write
   * tracking carries over to the schedule that replaces it.
   */
  function takeCapture(key: string): Capture | undefined {
    const capture = captures.get(key);
    if (!capture) return undefined;
    captures.delete(key);
    capture.parked.superseded = true;
    parked.remove(key, capture.parked);
    capture.resolveParked();
    return capture;
  }

  /**
   * Writes that outlived `writeTimeoutMs`, per key. They were reported as
   * failed, but they can still land, so the next write of the key waits for
   * them too (up to another `writeTimeoutMs`). One still out after that is
   * `overtaken`: if it lands, the key's newest write fires again, so the
   * newest bytes are the last on disk.
   */
  const overdue = new Map<string, Set<{ settled: Promise<boolean>; overtaken: boolean }>>();

  const trackOverdue = (key: string, write: Promise<string[]>, getArgs?: () => TArgs | null): void => {
    const generation = schedulerGeneration;
    const item = { settled: write.then((failures) => failures.length === 0, () => false), overtaken: false };
    let set = overdue.get(key);
    if (!set) overdue.set(key, (set = new Set()));
    set.add(item);
    void item.settled.then((landed) => {
      const current = overdue.get(key);
      current?.delete(item);
      if (current?.size === 0) overdue.delete(key);
      if (landed && item.overtaken && getArgs && schedulerGeneration === generation && !pending.has(key) && getArgs()) {
        schedule(key, getArgs, 0);
      }
    });
  };

  async function drainOverdue(key: string): Promise<void> {
    const late = overdue.get(key);
    if (!late || late.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, opts.writeTimeoutMs ?? 0); });
    await Promise.race([Promise.all([...late].map((item) => item.settled)), bound]);
    if (timer !== undefined) clearTimeout(timer);
    for (const item of overdue.get(key) ?? []) item.overtaken = true;
  }

  const hasPriorWrite = (key: string): boolean => !!inFlight.get(key)?.size || !!overdue.get(key)?.size;

  // A write of the path armed here keeps it pending when an earlier one lands
  // (see `registerArmedPathSource`).
  registerArmedPathSource((path) => {
    for (const entry of pending.values()) {
      if (entry.schedulePath && vaultPath(entry.schedulePath) === path) return true;
    }
    return parked.holdsPath(path);
  });
  // Failure attribution and retention of failed fires' args live in
  // writeSchedulerFailures.ts.
  const ledger = createFailureLedger<TArgs>();
  /**
   * Per-path write generation, minted when a write fires. A timed-out write's
   * late-success self-heal only clears the failed mark when THIS write is still
   * the newest for its path — otherwise an older, superseded write landing would
   * erase a newer write's legitimate failure. Keyed by case-folded `VaultPath`.
   * Values come from the session-monotonic `mintWriteGeneration` counter (not a
   * per-path +1): entries are pruned on success, so a per-path re-mint could
   * collide with a generation an older heal continuation still holds.
   */
  const writeGenByPath = new Map<VaultPath, number>();
  /**
   * Scheduler-wide generation, bumped by `reset()` (vault swap). A parked fire's
   * async closure survives `reset()`; it captures this at park time and bails
   * after its drain if it moved, so it can neither fire a stale write into the
   * new vault nor mark the outgoing vault's path failed in the new session.
   */
  let schedulerGeneration = 0;

  const sentinelMode: 'full' | 'none' | 'pending-path' = opts.sentinelMode ?? 'full';

  const failureIdFor = (args: TArgs): string => {
    if (opts.getFailureId) return opts.getFailureId(args);
    return opts.getSentinelInfo(args).path ?? '<unknown>';
  };

  const safeBeginWrite = (info: SchedulerSentinelInfo): void => {
    if (sentinelMode === 'full') {
      beginWrite(info.vaultRoot, info.path);
    } else if (sentinelMode === 'pending-path' && info.path) {
      // Track the armed debounce window in the sentinel ledger WITHOUT
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
      // The armed window closed: fire-handoff to trackComponentWrite, a
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
    let failError: unknown; // decides retention of a failed fire

    if (opts.shouldSkipWrite?.(args)) {
      safeEndWrite(sentinel, true);
      return Promise.resolve([]);
    }

    // Mint this path's write generation for the late-success self-heal below
    // (see `writeGenByPath`). Skipped writes never reach here.
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
          // Hand the write a currency check. A write whose IPC overruns `writeTimeoutMs` and lands AFTER a newer write for the same
          // path fired is superseded; `isLatestWrite()` lets it skip its
          // post-write drift-baseline stamp so the baseline isn't anchored to
          // stale bytes (which would defeat the next drift check).
          const result = await opts.performWrite(args, {
            isLatestWrite: () =>
              writePathKey === undefined || writeGenByPath.get(writePathKey) === writeGen,
          });
          if (result?.error !== undefined && (result.failed?.length ?? 0) > 0) failError = result.error;
          return result?.failed ?? [];
        } catch (err) {
          failError = err;
          return [failureId];
        }
      })();

      // With no bound configured, await the write indefinitely. When
      // `writeTimeoutMs` is set, race it: a write that wedges (a never-resolving
      // drift prompt, a stuck IPC) must not hang `flushAll`/`save()` forever.
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
          trackOverdue(key, writePromise, retainGetArgs);
          if (sentinel.path) {
            markPathFailed(sentinel.vaultRoot, sentinel.path);
            // The underlying write keeps running; we only stopped awaiting it.
            // Board/config/misc call their IPC directly (no trackComponentWrite),
            // so without this self-heal a late success would leave a phantom
            // "Save failed" + sticky `.filo/.dirty` for the session. Idempotent
            // for markdown/frontmatter, which heal via trackComponentWrite.
            const healVaultRoot = sentinel.vaultRoot;
            const healPath = sentinel.path;
            const healGen = writeGen;
            const healKey = writePathKey;
            void writePromise.then(
              (lateFailures) => {
                if (lateFailures.length === 0) {
                  // Only self-heal if THIS write is still the newest for its
                  // path; otherwise a newer write's legitimate failure would be
                  // masked.
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
    // the other's settle/endWrite.
    let bucket = inFlight.get(key);
    if (!bucket) {
      bucket = new Set<InFlightEntry>();
      inFlight.set(key, bucket);
    }
    bucket.add(entry);

    // Vault-swap guard: if `reset()` clears the in-flight map mid-IPC, the
    // late settle must NOT touch the new vault's sentinel state. Identity is
    // the entry object itself — a superseding write for the same key adds a
    // sibling entry rather than replacing this one, so this guard fires
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
        // Prune this key's attributed ids (and any retained re-fire) so the
        // ledger can't grow for the whole session. Crash recovery is unaffected:
        // `.filo/.dirty` + `failedVaultPaths` are owned by `endWrite`/`markPathFailed`.
        ledger.recordSuccess(key, failureId);
        // Prune this path's write-generation entry on a still-newest, now-clean
        // success to bound `writeGenByPath`. A timed-out write keeps its entry
        // (the late-heal gen guard still needs it).
        if (
          writePathKey !== undefined &&
          writeGenByPath.get(writePathKey) === writeGen &&
          !(sentinel.path && isPathPending(sentinel.path))
        ) {
          writeGenByPath.delete(writePathKey);
        }
      } else {
        ledger.recordFailed(key, failureList);
        // Keep a transient failure's args getter so the next
        // flushAll (Ctrl+S, quit drain, Retry) re-fires it instead of the edit
        // living only in memory. User-deferred / validation failures carry no
        // RETAINABLE code and are not re-fired (they would re-prompt).
        if (retainGetArgs && isRetainableWriteError(failError, opts.retainIoError === true)) ledger.retain(key, retainGetArgs);
      }
      return failureList;
    });
  }

  /**
   * Awaits every in-flight write for `key`, for ORDERING only (attribution is not
   * consumed here). Fire paths call this before firing a new write for the same
   * key so the newest lands LAST: otherwise, on a slow/synced volume, the OS can
   * land the older write last, clobbering the newer payload and anchoring the
   * drift baseline to stale bytes.
   *
   * Each awaited entry is the timeout-bounded tracker, and an overdue write is
   * waited for at most one more `writeTimeoutMs`, so a wedged prior can't
   * block for ever. The bucket is snapshotted because entries self-remove as
   * they settle.
   */
  async function drainPriorInFlight(key: string): Promise<void> {
    const bucket = inFlight.get(key);
    for (const priorEntry of bucket ? Array.from(bucket) : []) await priorEntry.promise;
    await drainOverdue(key);
  }

  function schedule(
    key: string,
    getArgs: () => TArgs | null,
    delayOverride?: number,
  ): void {
    ledger.release(key); // newer args supersede a retained failed fire
    const existing = pending.get(key);
    // A full save's capture of the key, not sent yet, is older than these
    // args: this schedule replaces it as it would a pending entry.
    const replaced = existing ?? takeCapture(key);
    const probe = getArgs();
    const nextSentinel: SchedulerSentinelInfo = probe
      ? opts.getSentinelInfo(probe)
      : { vaultRoot: undefined, path: undefined };

    if (replaced) {
      // Out of the armed set before its old path is released below; the new
      // entry is set at the end.
      if (existing) {
        clearTimeout(existing.timer);
        pending.delete(key);
      }
      const prevSentinel: SchedulerSentinelInfo = {
        vaultRoot: replaced.scheduleVaultRoot,
        path: replaced.schedulePath,
      };
      opts.onReschedule?.(prevSentinel, nextSentinel);
      // Pending-path mode: retarget the sentinel entry when a reschedule
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
      // (the note writer) opt out via `sentinelMode` to avoid
      // double-counting.
      safeBeginWrite(nextSentinel);
    }

    const debounce = delayOverride ?? opts.debounceMs;
    // Reads the freshest args and fires (or surfaces missing-source). Shared by
    // the synchronous fast path and the drained path below — both re-read
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
      // Snapshot at fire time (board scheduler). Other
      // schedulers omit `snapshotArgs` — they pass args straight through.
      const snapshotted = opts.snapshotArgs ? opts.snapshotArgs(args) : args;
      // Fire-and-forget. Failure attribution lives on the ledger; `flushAll`
      // consumes from there when it awaits in-flight writes.
      void fireWrite(key, snapshotted, getArgs);
    };
    const onDue = (): void => {
      const armed = pending.get(key);
      const probe = opts.deferFire ? getArgs() : null;
      if (armed && probe && opts.deferFire?.(probe)) {
        armed.timer = setTimeout(onDue, opts.debounceMs); // not yet: stays pending
        return;
      }
      pending.delete(key);
      // Serialize the timer fire behind any write still in flight for this key
      // so the newest write lands LAST (see `drainPriorInFlight`).
      if (hasPriorWrite(key)) {
        // A prior write is in flight — drain it first, THEN fire (re-reading args
        // for the freshest state). A reschedule landing during the drain arms its
        // own timer; both fires serialize via this same drain and last-wins, so
        // the extra write is benign. The drain is time-bounded, so a wedged
        // prior can't block it for ever (see `drainPriorInFlight`).
        //
        // Register a PARKED promise BEFORE awaiting the drain so
        // this deferred fire is visible to `flush()` / `flushAll()` while it
        // waits (it is in neither `pending` nor `inFlight` yet). Resolve it only
        // after `fireFromTimer` has registered the `inFlight` entry (or no-op'd),
        // so there is no gap where the write is in no structure.
        const { entry: parkedEntry, resolve: resolveParked } = newParkedEntry(nextSentinel.vaultRoot, nextSentinel.path);
        parked.add(key, parkedEntry);
        // Capture the scheduler generation at park time; if a `reset()` (vault
        // swap) bumps it during the drain, the closure must neither fire nor
        // surface missing-source against the new vault. The parked promise still
        // resolves via `finally`, so nothing awaiting it can hang.
        const parkedGeneration = schedulerGeneration;
        void (async () => {
          try {
            await drainPriorInFlight(key);
            if (schedulerGeneration !== parkedGeneration) return;
            // `cancel(key)` reached this parked fire during the drain (e.g. the
            // board was deleted mid-park) and already emitted the balanced
            // endWrite(true); firing now would resurrect a write against the
            // deleted target or raise a false "couldn't save".
            if (parkedEntry.cancelled) return;
            // No longer armed once it fires (the in-flight entry registers
            // synchronously inside), so its hand-off can release the path.
            parked.remove(key, parkedEntry);
            fireFromTimer();
          } finally {
            parked.remove(key, parkedEntry);
            resolveParked();
          }
        })();
      } else {
        // Common case — nothing in flight for this key. Fire synchronously so
        // the in-flight entry registers before the next microtask, preserving
        // the sync-fire timing flush()/flushAll() and the test suite rely on.
        fireFromTimer();
      }
    };
    const timer = setTimeout(onDue, debounce);

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
    if (pendingOnly) return; // skip the parked-fire cancel below; a teardown that already flushed owns it (see Scheduler.cancel doc).
    // A full save's capture is one of the parked fires settled below, so no
    // later schedule may take it over (and settle it a second time).
    captures.delete(key);
    // Also reach PARKED fires (in neither `pending` nor `inFlight` while they
    // await the drain). Otherwise a board deleted mid-park would have its fire
    // resume after the delete and mark the deleted path failed for the session.
    // Each un-cancelled parked fire owes exactly one endWrite; emit the balanced
    // success here and let the parked closure bail.
    for (const parkedEntry of parked.of(key)) {
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
    // A PARKED fire is in neither `pending` nor `inFlight` while it waits, so this
    // early-return must check `parked` too — else a flush in that gap reports
    // {ok:true} before the newest edit landed.
    if (!pendingEntry && (!initialBucket || initialBucket.size === 0) && parked.of(key).size === 0) {
      return { ok: true };
    }

    let success = true;

    // Consumes an in-flight entry's settled outcome into `success` + the shared
    // failures Set. Shared by the pre-drain and the post-fire drain below.
    const consumeInflight = async (entry: InFlightEntry): Promise<void> => {
      await entry.promise;
      // Consume from the shared Set so a subsequent `flushAll` doesn't
      // double-report. Falls back to the primary failureId when
      // `capturedFailures` stayed null (vault swap mid-IPC).
      const captured = entry.capturedFailures;
      if (captured && captured.length > 0) {
        success = false;
        for (const f of captured) ledger.consume(f);
      } else if (captured === null && ledger.consume(entry.failureId)) {
        success = false;
      }
    };

    // Sends the key's pending write now, after any write of it still in flight.
    const sendPending = async (entry: PendingEntry<TArgs>): Promise<void> => {
      // Disarm the pending timer UP-FRONT (before any await), so it can't
      // self-fire during the in-flight drain below and double-write.
      clearTimeout(entry.timer);
      pending.delete(key);

      // Drain any write already in flight for this key BEFORE firing the pending
      // one so the newest args land LAST (non-serialized schedulers could
      // otherwise let the older write win the atomic-rename race). Snapshot the
      // prior set now — the pending fire's own entry is drained below.
      const priorBucket = inFlight.get(key);
      if (priorBucket && priorBucket.size > 0) {
        for (const priorEntry of Array.from(priorBucket)) await consumeInflight(priorEntry);
      }
      await drainOverdue(key);

      // Fire the pending write. Args are read NOW (after the drain) so a
      // live-cache getter captures the freshest state; the just-disarmed timer
      // guarantees this is the only fire of this pending entry.
      const argsGetter = overrideGetArgs ?? entry.getArgs;
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
          { vaultRoot: entry.scheduleVaultRoot, path: entry.schedulePath },
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
    };

    if (pendingEntry) await sendPending(pendingEntry);

    // Await every remaining in-flight write for this key AND any PARKED fire
    // until both are quiescent. Overlapping fires each own a bucket entry; the
    // freshly fired pending write above and any pre-drained entries already
    // settled and removed themselves. A parked
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
      const waited = Array.from(parked.of(key));
      if (waited.length > 0) await Promise.all(waited.map((p) => p.promise));
      // A full save's capture this flush waited for was replaced by a newer
      // schedule of the key (`takeCapture`), whose write now carries its
      // change: send that one, rather than return while it is still armed.
      const newer = waited.some((p) => p.superseded) ? pending.get(key) : undefined;
      if (newer) await sendPending(newer);
      guard++;
    } while ((inFlight.get(key)?.size || parked.of(key).size) && guard < 50);
    if (guard >= 50) {
      console.warn(`[${opts.name}] flush("${key}") drain hit the iteration bound (50) — possible reschedule loop.`);
    }

    return { ok: success };
  }

  async function flushAll(): Promise<FlushAllResult> {
    drainRetained(); // re-fire every retained failed write once

    // Capture pending entries' args AND snapshot synchronously upfront.
    // Without this, a propagateRename mutation that
    // lands between iterations of the await loop could rebind one board's
    // path onto another, or a mid-flush cache mutation could leak into a
    // later board's payload. Calling `getArgs` and `snapshotArgs` inside
    // this synchronous loop freezes both the path AND the payload before
    // any disk I/O begins. A key scheduled again meanwhile drops its
    // capture (see `captures`).
    const drained: Capture[] = [];
    for (const [key, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      const rawArgs = entry.getArgs();
      const args = rawArgs && opts.snapshotArgs
        ? opts.snapshotArgs(rawArgs)
        : rawArgs;
      const { entry: parkedEntry, resolve: resolveParked } = newParkedEntry(entry.scheduleVaultRoot, entry.schedulePath);
      // The loop below fires these one after another; one waiting its turn is
      // no longer pending, and without this a `flush(key)` (a board delete's
      // save first) would report it saved before it had even been sent.
      parked.add(key, parkedEntry);
      const capture: Capture = {
        key,
        args,
        scheduleVaultRoot: entry.scheduleVaultRoot,
        schedulePath: entry.schedulePath,
        getArgs: entry.getArgs,
        parked: parkedEntry,
        resolveParked,
      };
      captures.set(key, capture);
      drained.push(capture);
    }
    pending.clear();

    // Snapshot in-flight up-front so a write that resolves between this
    // capture and our await loop is still surfaced via failure attribution.
    // Holds the live entry reference so post-settle capturedFailures are
    // visible after `await`. Flatten every key's bucket — overlapping fires
    // for one key each hold a distinct entry, all of which must be
    // awaited and attributed.
    const inflightSnapshot: { key: string; entry: InFlightEntry }[] = [];
    for (const [key, bucket] of inFlight.entries()) {
      for (const entry of bucket) inflightSnapshot.push({ key, entry });
    }

    let trackedVault: string | undefined;
    const failed: string[] = [];
    // Track drained entries (drained-pending + drained-inflight) so
    // we can return `ok = drained - failed`. Counted from the synchronous
    // capture loops above so a late-arriving write doesn't shift the
    // denominator under us.
    const drainedTotal = drained.length + inflightSnapshot.length;

    const unpark = (entry: Capture): void => {
      parked.remove(entry.key, entry.parked);
      if (captures.get(entry.key) === entry) captures.delete(entry.key);
      entry.resolveParked();
    };
    // Not sent: `cancel(key)` reached it while it waited (the board was
    // deleted) and settled its write tracking, or a newer schedule of its key
    // took its place and its tracking with it (`takeCapture`).
    const dropped = (entry: Capture): boolean => entry.parked.cancelled || entry.parked.superseded;
    try {
      for (const entry of drained) {
        if (dropped(entry)) {
          unpark(entry);
          continue;
        }
        if (!entry.args) {
          unpark(entry);
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
        // Drain any older write in flight for this key BEFORE firing the pending
        // (newest) one so the newest lands LAST. The prior entries stay in
        // `inflightSnapshot`, so their attribution still runs below — here we only
        // enforce ORDERING.
        //
        // Guard the await on a NON-EMPTY bucket: awaiting yields a microtask even
        // when nothing is in flight, deferring `fireWrite`'s synchronous IPC
        // dispatch — callers that fire-and-don't-await `flushAll()` rely on the
        // write having begun synchronously.
        if (hasPriorWrite(entry.key)) await drainPriorInFlight(entry.key);
        if (dropped(entry)) {
          unpark(entry);
          continue;
        }
        const sentinel = opts.getSentinelInfo(entry.args);
        if (sentinel.vaultRoot) trackedVault = sentinel.vaultRoot;
        // Unparked just before the fire, which registers its in-flight entry
        // synchronously: there is no moment when the write is in neither.
        unpark(entry);
        const failureList = await fireWrite(entry.key, entry.args, entry.getArgs);
        for (const f of failureList) {
          ledger.consume(f);
          if (!failed.includes(f)) failed.push(f);
        }
      }
    } finally {
      // A throw above must not leave a `flush(key)` waiting for ever.
      for (const entry of drained) unpark(entry);
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
          // Throw-attribution path — entry was cleared by reset()
          // mid-IPC so capturedFailures stayed null; consult the global
          // failures Set for any matching primary failureId.
          if (!failed.includes(e.entry.failureId)) failed.push(e.entry.failureId);
        }
      }
    }

    // Drain PARKED fires until quiescent. A timer that fired into
    // the drained branch is deferred behind a prior in-flight write — in neither
    // `pending` nor the `inflightSnapshot` above — so without this `flushAll`
    // (hence `save()`/quit) could resolve while the newest edit hadn't landed.
    // Re-drain BOTH fresh in-flight entries AND still-parked promises each pass:
    // a parked fire transitions parked → in-flight when the prior write resolves
    // and may already be in `inFlight` (not the snapshot) by the time we look.
    // Bounded so a reschedule chaining behind a wedge can't strand the flush.
    let parkedDrainedTotal = 0;
    let parkedGuard = 0;
    while ((parked.any() || inFlight.size > 0) && parkedGuard < 50) {
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
      if (parked.any()) {
        await Promise.all(parked.promises());
      }
    }
    if (parkedGuard >= 50) {
      console.warn(`[${opts.name}] flushAll parked-drain hit the iteration bound (50) — possible reschedule loop.`);
    }

    const ok = Math.max(0, drainedTotal + parkedDrainedTotal - failed.length);
    return { vaultRoot: trackedVault, failed, ok };
  }

  function reset(): void {
    const armed = [...pending.values()];
    // Nothing is armed any more, so the drops below release the paths. Parked
    // references go too, so new flushes don't see them. The generation bump
    // below is what neutralises a dangling parked closure: it bails after its
    // drain instead of firing or marking failed against the new vault (the
    // missing-source branch never reaches `fireWrite`'s `trackerIsCurrent` guard).
    pending.clear();
    parked.clear();
    captures.clear();
    for (const entry of armed) {
      clearTimeout(entry.timer);
      // Pending-path mode owns its entries in the shared ledger; drop
      // them so a reset() outside the vault-swap path (e.g. per-test cleanup,
      // where `resetWriteTracking` isn't also called) can't strand a dirty
      // sentinel path. On vault swap, `resetWriteTracking` clears the ledger
      // wholesale anyway, so this is a harmless no-op there.
      if (sentinelMode === 'pending-path' && entry.schedulePath) {
        dropPendingPath(entry.scheduleVaultRoot, entry.schedulePath);
      }
    }
    inFlight.clear();
    overdue.clear();
    schedulerGeneration += 1;
    ledger.clear(); // attribution ids, per-key records AND retained re-fires (outgoing vault)
    // Drop per-path generations so a stale late-success continuation from the
    // outgoing vault can't match and heal.
    writeGenByPath.clear();
  }

  /**
   * Moves retained failed fires back into `pending` (delay 0)
   * so the caller's drain re-fires them with FRESH args. A key already pending
   * is superseded by its newer args; a source that vanished (null args) is
   * dropped silently (its failed mark + sentinel stay — no false toast).
   */
  function drainRetained(key?: string): void {
    for (const [k, getArgs] of ledger.takeRetained(key)) {
      const args = getArgs();
      // Waiting for the user's answer: re-firing would only meet the same question.
      if (args && opts.holdRetained?.(args)) ledger.retain(k, getArgs);
      else if (!pending.has(k) && args) schedule(k, getArgs, 0);
    }
  }

  /** Retry: re-fire retained failed writes and await them. */
  async function retryFailed(key?: string): Promise<{ failed: string[] }> {
    if (!ledger.hasRetained(key)) return { failed: [] };
    if (key !== undefined) {
      drainRetained(key);
      return { failed: (await flush(key)).ok ? [] : [key] };
    }
    return { failed: (await flushAll()).failed };
  }
  registerRetryHook(() => retryFailed());

  // Any unsaved work for `key`: pending / parked / in flight / retained.
  const hasWork = (key: string): boolean =>
    pending.has(key) || !!inFlight.get(key)?.size || parked.of(key).size > 0 || ledger.hasRetained(key);

  function hasPendingTimer(predicate: (args: TArgs) => boolean): boolean {
    for (const entry of pending.values()) {
      const args = entry.getArgs();
      if (args && predicate(args)) return true;
    }
    return false;
  }

  // True when a non-cancelled PARKED fire matches `predicate` (a fire deferred
  // behind drainPriorInFlight). Separate from `hasPendingTimer` (armed timers
  // only); probes that must not report idle/clean over a parked write OR the two. Parked entries carry
  // no args → the predicate sees the schedule-time `{ key, path }`.
  function hasParked(predicate: (info: { key: string; path: string | undefined }) => boolean): boolean {
    return parked.matches(predicate);
  }

  function __failuresSizeForTests(): number {
    return ledger.size();
  }

  function __writeGenSizeForTests(): number {
    return writeGenByPath.size;
  }

  /**
   * Test-only — constructs the production-unreachable state where
   * a parked fire is pending but `pending`/`inFlight` are empty (the prior
   * in-flight write already settled + removed itself; the parked fire has not yet
   * registered its own `inFlight` entry — a one-microtask gap no external code can
   * land in). Returns a release that clears the parked entry, mirroring the parked
   * IIFE's `removeParked` tail. Lets a test prove `flush(key)` doesn't report
   * success while a write is still parked.
   */
  function __parkForTests(key: string): () => void {
    const { entry, resolve } = newParkedEntry(undefined, undefined);
    parked.add(key, entry);
    return () => { parked.remove(key, entry); resolve(); };
  }

  return {
    schedule,
    cancel,
    cancelAll,
    flush,
    flushAll,
    retryFailed,
    discardRetained: (key: string) => ledger.release(key),
    reset,
    hasPendingTimer,
    hasParked,
    hasWork,
    __failuresSizeForTests,
    __writeGenSizeForTests,
    __parkForTests,
  };
}

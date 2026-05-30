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
} from './writeStateTracking';
import { reportError } from '../utils/errorBus';

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
   */
  manageSentinel?: boolean;
  /**
   * Optional snapshot transform applied at fire-time (timer or flush)
   * BEFORE `performWrite` runs. Used by the board scheduler to deep-clone
   * the live cache proxy so a mid-flush mutation can't leak into the
   * payload. Critically, snapshots taken during `flushAll`'s synchronous
   * capture loop freeze BEFORE any await — preserving Phase 25 L12 / C5
   * "capture path + snapshot upfront" semantics.
   */
  snapshotArgs?: (args: TArgs) => TArgs;
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
 */
export interface FlushAllResult {
  /** Identifiers (paths or failure ids) whose write failed. */
  failed: string[];
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

  const manageSentinel = opts.manageSentinel ?? true;

  const failureIdFor = (args: TArgs): string => {
    if (opts.getFailureId) return opts.getFailureId(args);
    return opts.getSentinelInfo(args).path ?? '<unknown>';
  };

  const safeBeginWrite = (info: SchedulerSentinelInfo): void => {
    if (!manageSentinel) return;
    beginWrite(info.vaultRoot, info.path);
  };

  const safeEndWrite = (
    info: SchedulerSentinelInfo,
    success: boolean,
  ): void => {
    if (!manageSentinel) return;
    endWrite(info.vaultRoot, info.path, success);
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

    // Wrap performWrite so a synchronous throw is treated as failure
    // attribution rather than blowing up the timer callback.
    const innerPromise: Promise<string[]> = (async () => {
      try {
        const result = await opts.performWrite(args);
        return result?.failed ?? [];
      } catch {
        return [failureId];
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
      if (!success) for (const f of failureList) failures.add(f);
      return failureList;
    });
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
    } else {
      // New pending — count it against the sentinel for the entire debounce
      // window, not just the eventual disk-I/O window. Schedulers whose
      // `performWrite` already wraps the IPC in `trackComponentWrite`
      // (markdownFileWriter) opt out via `manageSentinel: false` to avoid
      // double-counting.
      safeBeginWrite(nextSentinel);
    }

    const debounce = delayOverride ?? opts.debounceMs;
    const timer = setTimeout(() => {
      pending.delete(key);
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

    if (pendingEntry) {
      clearTimeout(pendingEntry.timer);
      pending.delete(key);
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

    // Await every in-flight write for this key. Overlapping fires each own a
    // bucket entry (Phase F2), so there may be more than one; the freshly
    // fired pending write above already settled and removed itself. Snapshot
    // the survivors now — fireWrite's settle callback removes them from the
    // bucket as they land.
    const bucket = inFlight.get(key);
    const inflightEntries = bucket ? Array.from(bucket) : [];
    for (const inflightEntry of inflightEntries) {
      await inflightEntry.promise;
      // Captured failures live on the entry — `flush(key)` consumes them
      // from the shared Set so a subsequent `flushAll` doesn't double-
      // report. Falls back to the primary failureId for the legacy
      // throw-only path where `capturedFailures` stayed null (vault swap
      // mid-IPC), matching the legacy board scheduler's attribution.
      const captured = inflightEntry.capturedFailures;
      if (captured && captured.length > 0) {
        success = false;
        for (const f of captured) failures.delete(f);
      } else if (captured === null && failures.delete(inflightEntry.failureId)) {
        success = false;
      }
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

    return { vaultRoot: trackedVault, failed };
  }

  function reset(): void {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    inFlight.clear();
    failures.clear();
  }

  function hasPending(predicate: (args: TArgs) => boolean): boolean {
    for (const entry of pending.values()) {
      const args = entry.getArgs();
      if (args && predicate(args)) return true;
    }
    return false;
  }

  return { schedule, cancel, cancelAll, flush, flushAll, reset, hasPending };
}

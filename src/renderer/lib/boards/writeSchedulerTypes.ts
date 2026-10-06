/**
 * writeSchedulerTypes — the type surface of the `createScheduler` primitive.
 *
 * Pure declarations only; every name is re-exported from `writeScheduler.ts`.
 * The behavioural documentation lives here with the contracts it describes;
 * the implementation comments stay with the code.
 */

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
  /**
   * The error behind a partial failure, when every failure in it is one a
   * re-fire could fix. It decides retention the way a thrown error would.
   */
  error?: unknown;
}

/**
 * Per-fire context handed to `performWrite`. Lets a write
 * decide whether its post-write side effects (notably the drift-baseline
 * stamp) are still valid by the time its IPC lands.
 */
export interface PerformWriteContext {
  /**
   * True while THIS fire is still the newest write scheduled for its path —
   * i.e. no later write for the same path has fired since (which would have
   * bumped the per-path write generation). A board/config write whose IPC
   * exceeded `writeTimeoutMs` (so `drainPriorInFlight` stopped awaiting it and
   * a newer write for the same path fired) lands late as a SUPERSEDED write;
   * it must NOT stamp the post-write drift baseline, because that would anchor
   * the baseline to its now-stale bytes and silently defeat future drift
   * detection. Always `true` for a write whose sentinel info carries no
   * path (no generation tracked).
   */
  isLatestWrite(): boolean;
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
   *
   * The second argument is a per-fire {@link PerformWriteContext}; consumers
   * that have no post-write generation-sensitive side effect may ignore it
   * (a `(args) => …` callback is assignable here).
   */
  performWrite: (args: TArgs, ctx: PerformWriteContext) => Promise<PerformWriteResult | void>;
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
   * True while a retained failed write waits for the user's answer, which no
   * retry gives: `flushAll` and Retry leave it retained and don't re-fire it.
   * Used by the board scheduler for a board held for a drift decision.
   */
  holdRetained?: (args: TArgs) => boolean;
  /**
   * True while an armed write must not fire yet: when its debounce runs out it
   * is armed again instead (still pending, so saves and quit see it). A save
   * that forces it out meanwhile still fires it. Used by the board scheduler
   * for a board whose file an in-app rename is moving.
   */
  deferFire?: (args: TArgs) => boolean;
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
   * A key's write succeeded after earlier writes of it failed under another
   * failure id (the file was moved in between): each such id is no longer
   * owed. The board scheduler clears the failed mark left at the old path, or
   * the save indicator would report it for the rest of the session.
   */
  onEarlierFailureHealed?: (failureId: string, sentinel: SchedulerSentinelInfo) => void;
  /**
   * How the primitive keeps the `.filo/.dirty` sentinel and the
   * `pendingVaultPaths` ledger in sync across the debounce → write window:
   *  - `'full'` (default): `beginWrite` at schedule, `endWrite` at outcome —
   *    owns BOTH the inflight counter and the pending path for the whole
   *    window.
   *  - `'none'`: no tracking — the consumer's `performWrite` owns everything.
   *  - `'pending-path'`: track ONLY the pending PATH during the armed window
   *    (`noteAdditionalPendingPath` at schedule, `dropPendingPath` +
   *    `syncSentinelIfIdle` at fire-handoff / cancel / reschedule / reset),
   *    WITHOUT bumping inflight. Used by the note writer, whose
   *    `performWrite` wraps its own `trackComponentWrite` (inflight) at fire
   *    time — this closes the body-edit crash window (no sentinel during the
   *    300 ms debounce) and lets the save indicator read "saving", without
   *    double-counting inflight.
   */
  sentinelMode?: 'full' | 'none' | 'pending-path';
  /**
   * Optional snapshot transform applied at fire-time (timer or flush)
   * BEFORE `performWrite` runs. Used by the board scheduler to deep-clone
   * the live cache proxy so a mid-flush mutation can't leak into the
   * payload. Critically, snapshots taken during `flushAll`'s synchronous
   * capture loop freeze BEFORE any await ("capture path + snapshot upfront").
   */
  snapshotArgs?: (args: TArgs) => TArgs;
  /**
   * Optional upper bound (ms) on a single `performWrite`. When set,
   * `fireWrite` races the write against this timeout; if it elapses first the
   * scheduler STOPS awaiting that write, marks its path failed (keeping the
   * `.filo/.dirty` sentinel + the save indicator's failed list live), and
   * attributes the failure so `flush`/`flushAll` (and the `save()` boolean that
   * folds them) report it instead of hanging forever. The underlying
   * `performWrite` keeps running — a late success self-heals via its own
   * `trackComponentWrite` `endWrite`. Omit to await indefinitely (correct for
   * schedulers whose writes can't wedge on user input).
   * Set ONLY high enough to exceed any legitimate in-write await (e.g. the
   * note writer's conflict prompt); it is a wedged-write backstop,
   * not a latency budget.
   */
  writeTimeoutMs?: number;
  /**
   * Also keep failures coded `IO_ERROR` (an fs error main couldn't name) for
   * a re-fire. Only for schedulers whose payload is a whole-file snapshot
   * rebuilt at fire time, so a re-fire can't replay a stale partial change.
   */
  retainIoError?: boolean;
}

/** Internal — a pending (armed-timer) entry. */
export interface PendingEntry<TArgs> {
  timer: ReturnType<typeof setTimeout>;
  getArgs: () => TArgs | null;
  /** Sentinel info captured at schedule time; used by `cancel` and missing-source endWrite. */
  scheduleVaultRoot: string | undefined;
  schedulePath: string | undefined;
}

/** Internal — one in-flight fire's tracking entry. */
export interface InFlightEntry {
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
 * Internal — one PARKED fire's tracking entry (a debounce fire deferred
 * behind `drainPriorInFlight`, or a full save's capture waiting its turn; see
 * `writeSchedulerParked.ts`).
 *
 * Carries the schedule-time sentinel info plus a `cancelled` flag so
 * `cancel(key)` can reach a parked fire (e.g. a board deleted mid-park):
 * `cancel` marks the entry cancelled and emits the balanced `endWrite(true)`
 * itself; the parked closure bails without firing, so the deleted path is
 * never marked failed.
 */
export interface ParkedEntry {
  promise: Promise<void>;
  /** Sentinel info captured at schedule time — used by `cancel(key)`. */
  vaultRoot: string | undefined;
  path: string | undefined;
  /** Set by `cancel(key)`; the parked closure then neither fires nor endWrites. */
  cancelled: boolean;
  /**
   * Set when a newer `schedule` of the key replaced this full-save capture:
   * it is never sent, and a `flush(key)` that waited for it sends the newer
   * write instead.
   */
  superseded: boolean;
}

/**
 * Per-scheduler flush result: `failed` is a flat list of failure
 * identifiers and `vaultRoot` carries the last-seen root for post-drain
 * sentinel sync. `ok` counts the writes drained successfully.
 */
export interface FlushAllResult {
  /** Identifiers (paths or failure ids) whose write failed. */
  failed: string[];
  /**
   * Count of writes drained (pending-timer-fired + already-in-flight)
   * whose `performWrite` resolved without surfacing a failure id. Always
   * equals `drainedTotal - failed.length` for any single `flushAll` call.
   * Production callers usually check `failed.length === 0` and ignore this
   * count.
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
   * timer and replace the args getter — last call wins. That includes a
   * full save's copy of the key not sent yet (`flushAll` captures args up
   * front): it is dropped, never sent after this write. The getter is
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
   *
   * Also reaches PARKED fires (a debounce fire deferred behind an in-flight
   * write): each is marked cancelled (the parked closure bails instead of
   * firing / surfacing missing-source) and its balanced
   * `endWrite(success=true)` is emitted here.
   *
   * Pass `pendingOnly: true` to cancel ONLY an armed-but-unfired
   * timer and leave any parked/in-flight fire untouched. A teardown caller that
   * has ALREADY flushed (flush, then cancel in the same tick) owns the parked
   * fire — `flush` drains it and lands its
   * newest payload. Cancelling the parked fire there would make its closure bail,
   * dropping the freshest edit while the flush still reports success.
   */
  cancel(key: string, fallbackPath?: string, pendingOnly?: boolean): void;
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
   * Re-fires the retained failed writes (all, or `key`'s) with fresh args and
   * awaits them. `flushAll` also re-fires them once per call.
   */
  retryFailed(key?: string): Promise<{ failed: string[] }>;
  /** Drops `key`'s retained failed write: the change it held is no longer owed (the file was reloaded). */
  discardRetained(key: string): void;
  /**
   * The file at `oldPath` (or a folder above it) moved while a full save
   * holds a copy of a key's write made for that path, not yet sent: each such
   * copy is replaced by a new write of the key, which reads its path when it
   * fires. `isUnder(path)` says whether a copy's path is at or under the
   * moved one.
   */
  replaceCapturesUnder(isUnder: (path: string) => boolean): void;
  /** True while `key` has a pending, parked, in-flight or retained write. */
  hasWork(key: string): boolean;
  /**
   * Vault-swap nuclear option — clears pending timers, in-flight tracker
   * entries, and failure attribution Set. Late `.then`/`.catch` callbacks
   * against cleared entries no-op via the `trackerIsCurrent` guard.
   */
  reset(): void;
  /**
   * True when any armed (pending, not-yet-fired) timer's args satisfy
   * `predicate`. ONLY armed timers, never `parked`/`inFlight` (no args;
   * `markClean` needs "is a NEWER timer armed"). Durability checks use the
   * sentinel ledger (`isPathPending`), which tracks parked +
   * in-flight.
   */
  hasPendingTimer(predicate: (args: TArgs) => boolean): boolean;
  /**
   * True when a non-cancelled PARKED fire (a debounce fire deferred behind an
   * in-flight write by `drainPriorInFlight`, in neither `pending` nor
   * `inFlight` while it awaits the drain) matches `predicate`. Kept SEPARATE
   * from `hasPendingTimer` (whose armed-timer-only contract other callers
   * depend on); a probe that must NOT report idle / clean while a
   * newer parked write is unsaved ORs the two. Parked entries carry no args, so
   * the predicate sees the schedule-time `{ key, path }`.
   */
  hasParked(predicate: (info: { key: string; path: string | undefined }) => boolean): boolean;
  /**
   * Test-only — count of attributed-but-undrained failure identifiers retained
   * in the internal `failures` Set. Pins that a failure followed by a
   * successful write to the SAME key prunes the stale id(s) — including a
   * partial-failure id list — rather than retaining them until `reset()`.
   * Production code never needs this.
   */
  __failuresSizeForTests(): number;
  /**
   * Test-only — count of retained per-path write-generation entries
   * (`writeGenByPath`). Pins the success-path prune: after N distinct paths are
   * written to completion this returns to ~0 (each successful, still-newest
   * settle prunes its entry), rather than retaining one entry per
   * distinct-path-ever-written until `reset()`. Production code never needs it.
   */
  __writeGenSizeForTests(): number;
  /**
   * Test-only — registers a parked-fire placeholder for `key`
   * and returns a release that clears it. Lets a test construct the
   * production-unreachable "parked but pending/inFlight empty" gap to prove
   * `flush(key)` waits on it. Production code never needs it.
   */
  __parkForTests(key: string): () => void;
}

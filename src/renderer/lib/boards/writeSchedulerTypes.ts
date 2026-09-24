/**
 * writeSchedulerTypes — the type surface of the `createScheduler` primitive.
 *
 * Split out of `writeScheduler.ts` to keep it under the `gates:file-sizes` limit.
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
   * How the primitive keeps the `.filo/.dirty` sentinel and the
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
   * markdown gateway's interactive drift prompt); it is a wedged-write backstop,
   * not a latency budget.
   */
  writeTimeoutMs?: number;
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
 * behind `drainPriorInFlight`; see the `parked` map in `writeScheduler.ts`).
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
}

/**
 * Per-scheduler flush result. Intentionally distinct from the markdown
 * gateway/registry `FlushAllResult` (`{ ok: number; failed: {ownerId,error}[] }`):
 * here `failed` is a flat list of failure identifiers and `vaultRoot` carries
 * the last-seen root for post-drain sentinel sync. Do not unify the two.
 *
 * `ok` tracks the count of writes drained successfully so the gateway-side
 * `flushAllMarkdownWriters` reports a meaningful production count.
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
   *
   * Also reaches PARKED fires (a debounce fire deferred behind an in-flight
   * write): each is marked cancelled (the parked closure bails instead of
   * firing / surfacing missing-source) and its balanced
   * `endWrite(success=true)` is emitted here.
   *
   * Pass `pendingOnly: true` to cancel ONLY an armed-but-unfired
   * timer and leave any parked/in-flight fire untouched. A teardown caller that
   * has ALREADY flushed (PropertiesPopup.onDestroy: `flushIfPending()` then
   * cancel, same tick) owns the parked fire — `flush` drains it and lands its
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
   * `predicate` (a `manageSentinel:false` scheduler's probe into
   * `isPathPending`). ONLY armed timers, never `parked`/`inFlight` (no args;
   * `markClean` needs "is a NEWER timer armed"). Durability checks use the
   * sentinel ledger (`isPathPending`/`hasPendingWrite`), which tracks parked +
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

import { uiStore } from '../../stores/ui.svelte';

/**
 * 6.2.H4 — flush-and-quit handler, extracted from `App.svelte` for testability.
 *
 * The pre-fix path on a save failure was a 200 ms sleep followed by an
 * unconditional `app:ready-to-quit`. That gave the user about 200 ms to
 * read a toast naming a `<path>.<nonce>.tmp` location before the window
 * destroyed — silent data loss in practice.
 *
 * This handler keeps the happy path (save succeeded and the save-state
 * store reports no lingering error) on the fast track: send
 * `app:ready-to-quit` immediately, no UI. On a failure, surface a Confirm
 * dialog with "Retry now" / "Quit anyway" / "Stay open". Retry now
 * (Audit-19 EXT-5) re-fires the retained failed writes and drains again;
 * Stay open sends `app:cancel-quit` so main can rewind `isFlushingForQuit`
 * and the user keeps editing.
 *
 * Dependencies are injected so the unit test can drive every branch
 * without mocking the whole renderer.
 */
export interface QuitFlushDeps {
  saveStateState: () => 'idle' | 'saving' | 'saved' | 'error';
  save: () => Promise<boolean>;
  send: (
    channel:
      | 'app:ready-to-quit'
      | 'app:cancel-quit'
      | 'app:quit-awaiting-user'
      | 'app:drain-heartbeat',
  ) => void;
  reportError: (context: string, err: unknown, msg: string) => void;
  /**
   * Audit-6 M5 — awaits the dirty-flag sentinel mutex tail (the fire-and-forget
   * `markClean` `save()` enqueued while draining) so it lands on disk BEFORE we
   * tell main to destroy the renderer. Without it, `.filo/.dirty` outlives a
   * clean quit and the next launch shows a phantom recovery prompt. Optional so
   * existing unit deps don't have to supply it; production wires
   * `flushDirtyFlagSentinel`.
   */
  flushSentinel?: () => Promise<void>;
  /**
   * Audit-19 EXT-5 — re-fires every retained failed write (all five schedulers)
   * before the "Retry now" drain. Production wires `retryAllFailedWrites`.
   */
  retryFailed?: () => Promise<unknown>;
}

/**
 * Audit5 2.1 — heartbeat cadence while `save()` drains. Must stay comfortably
 * below main's `FLUSH_TIMEOUT_MS` (5 s) so the destroy timer main re-arms on
 * each beat never lapses in the gap between two beats on a slow drain.
 */
const DRAIN_HEARTBEAT_MS = 2000;

/**
 * Audit-11 WC-1 / QC-3 — absolute ceiling on the automated drain (`save()` plus
 * the terminal sentinel flush). The heartbeat above re-arms main's destroy timer
 * every ~2 s, so WITHOUT this an `save()` that never resolves (a wedged write the
 * per-scheduler `writeTimeoutMs` somehow didn't catch, an unbounded await, or a
 * future regression) would keep quit blocked FOREVER on the OneDrive/SMB target
 * environment. On elapse we stop beating and hand the decision to the user via
 * the existing "Save failed → Quit anyway / Stay" confirm — converting a silent
 * freeze into a choice. Sits at the per-write bound (60 s): a healthy or
 * slow-but-live drain finishes well under it, so it only ever fires on a genuine
 * stall, and "Stay open and retry" is the escape if it fires on a pathologically
 * slow (but eventually-succeeding) drain.
 */
const QUIT_DRAIN_DEADLINE_MS = 60_000;

/**
 * Audit-11 QC-3 — bound on the terminal `.filo/.dirty` sentinel flush. By the
 * time it runs the heartbeat is already cleared, so main's 5 s destroy timer is
 * the implicit backstop; bounding it explicitly keeps the renderer-initiated
 * clean shutdown deterministic instead of racing that timer.
 */
const SENTINEL_FLUSH_DEADLINE_MS = 5_000;

/**
 * Audit-11 QC-4 — re-entrancy guard. A second `app:flush-and-quit` dispatch
 * (main can't double-send today, but defense-in-depth against a future change)
 * must not start a second `save()` or stack a second confirm: the first
 * invocation owns the drain until it resolves to a terminal signal. Reset in
 * `finally` so a "Stay open and retry" leaves the next genuine quit free to drain.
 */
let isDrainingForQuit = false;

/** Test-only — clears the re-entrancy guard between cases. */
export function __resetQuitDrainingForTests(): void {
  isDrainingForQuit = false;
}

/**
 * Sentinel the drain race resolves to when the absolute deadline elapses before
 * the awaited op settles. A module-level unique symbol so it can't be confused
 * with any boolean the op itself resolves.
 */
const DRAIN_TIMED_OUT: unique symbol = Symbol('quit-drain-timed-out');

/**
 * Races `op` against an absolute `ms` deadline. Resolves to the op's value if it
 * settles first, or `DRAIN_TIMED_OUT` if the deadline wins. Rejections of `op`
 * propagate (the caller's try/catch owns them); the timer is always cleared so a
 * fast op leaves no dangling handle.
 */
async function raceDrainDeadline<T>(
  op: Promise<T>,
  ms: number,
): Promise<T | typeof DRAIN_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DRAIN_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(DRAIN_TIMED_OUT), ms);
  });
  try {
    return await Promise.race([op, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Audit-6 M5 / Audit-11 QC-3 — flushes the dirty-flag sentinel mutex tail,
 * bounded so a wedged sentinel IPC on a stalled volume can't hang the terminal
 * quit path. A timeout here is non-fatal: we proceed to `app:ready-to-quit`
 * anyway (worst case `.filo/.dirty` survives → one phantom recovery prompt,
 * which is also what main's forced destroy would produce).
 */
async function flushSentinelBounded(deps: QuitFlushDeps): Promise<void> {
  if (!deps.flushSentinel) return;
  await raceDrainDeadline(deps.flushSentinel(), SENTINEL_FLUSH_DEADLINE_MS);
}

export async function handleFlushAndQuit(deps: QuitFlushDeps): Promise<void> {
  // QC-4 — re-entrancy guard (see `isDrainingForQuit`). A concurrent dispatch
  // no-ops; the first invocation drives the quit to a terminal signal.
  if (isDrainingForQuit) return;
  isDrainingForQuit = true;
  try {
    await drainAndQuit(deps);
  } finally {
    isDrainingForQuit = false;
  }
}

async function drainAndQuit(deps: QuitFlushDeps): Promise<void> {
  // Audit5 2.1 (#2) — beat a drain-in-progress signal BEFORE and DURING the
  // flush. Main arms a 5 s auto-destroy timer the instant it asks us to flush;
  // a drain that legitimately runs longer than that (a large vault on a
  // contended volume — the user's vault lives under OneDrive) would otherwise
  // have the window destroyed mid-write, losing the very edits we're saving.
  // Each beat re-arms main's timer, so the ceiling bounds inter-beat SILENCE
  // (a wedged renderer) rather than total honest drain time. The interval is
  // cleared the moment `save()` settles OR the absolute deadline elapses — the
  // failure branch's open-ended confirm is then bounded by
  // `app:quit-awaiting-user`, not the heartbeat.
  //
  // Audit-19 EXT-5 — "Retry now" loops back here: it re-fires every retained
  // failed write (`retryFailed`) and drains again under a fresh heartbeat.
  let retrying = false;
  for (;;) {
    const failed = await runDrain(deps, retrying);
    if (!failed && deps.saveStateState() !== 'error') {
      // Audit-6 M5 — let the queued markClean reach disk (bounded — QC-3) before
      // main destroys us, or `.filo/.dirty` survives a clean quit → phantom
      // recovery next launch.
      await flushSentinelBounded(deps);
      deps.send('app:ready-to-quit');
      return;
    }
    // Save failed (or the save-state store still carries an unresolved error
    // from an earlier debounced write). Block the quit until the user
    // explicitly chooses: Retry now, Quit anyway (accept data loss; the user
    // can recover .tmp files from disk) or Stay open.
    //
    // Audit-4 DI-04 — heartbeat BEFORE the confirm. The dialog below is
    // open-ended (no timeout), but main destroys the window after a 5 s flush
    // ceiling. A human reading a "Save failed" dialog routinely takes longer
    // than 5 s, so the timer would fire first, vanish the dialog, and discard
    // the choice (and the edits). Tell main a human is now in the loop so it
    // clears that auto-destroy timer; the ready/cancel reply below then drives
    // the real quit on the user's schedule.
    deps.send('app:quit-awaiting-user');
    const choice = await new Promise<'quit' | 'stay' | 'retry'>((resolve) => {
      uiStore.openConfirm({
        title: 'Save failed',
        body:
          "Filo couldn't write your latest changes to disk (another program, such as " +
          'OneDrive or antivirus, may be holding the file). Quitting now will lose ' +
          'those edits — Filo preserved emergency .tmp files in the vault that you ' +
          'can recover manually if you do. Pick "Retry now" to try again, or ' +
          '"Stay open" to keep editing.',
        confirmLabel: 'Quit anyway',
        cancelLabel: 'Stay open',
        secondaryAction: { label: 'Retry now', onClick: () => resolve('retry') },
        danger: true,
        onConfirm: () => resolve('quit'),
        onCancel: () => resolve('stay'),
      });
    });
    if (choice === 'retry') {
      retrying = true;
      continue;
    }
    if (choice === 'quit') {
      // Audit-6 M5 — on "Quit anyway" the sentinel is (correctly) DIRTY: failed
      // writes enqueued a markDirty. Flush it (bounded — QC-3) so the next launch's
      // recovery prompt accurately names the lost paths instead of racing the
      // renderer's destroy.
      await flushSentinelBounded(deps);
      deps.send('app:ready-to-quit');
    } else {
      deps.send('app:cancel-quit');
    }
    return;
  }
}

/**
 * One bounded drain under the heartbeat. Returns true when it FAILED. On a
 * retry pass (Audit-19 EXT-5) the retained failed writes are re-fired first;
 * `save()` then drains everything else.
 */
async function runDrain(deps: QuitFlushDeps, retryFirst: boolean): Promise<boolean> {
  deps.send('app:drain-heartbeat');
  const heartbeat = setInterval(() => deps.send('app:drain-heartbeat'), DRAIN_HEARTBEAT_MS);
  try {
    // Audit-11 WC-1 (half 2) — bound the drain. A wedged write the per-scheduler
    // `writeTimeoutMs` didn't catch (or any unbounded await) must not keep the
    // heartbeat re-arming main's destroy timer forever; on the deadline treat it
    // as a failure and fall through to the user confirm.
    const op = (async (): Promise<boolean> => {
      if (retryFirst && deps.retryFailed) await deps.retryFailed();
      return deps.save();
    })();
    const outcome = await raceDrainDeadline(op, QUIT_DRAIN_DEADLINE_MS);
    return outcome === DRAIN_TIMED_OUT || outcome === false;
  } catch (err) {
    deps.reportError('App', err, 'flush-and-quit failed');
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}

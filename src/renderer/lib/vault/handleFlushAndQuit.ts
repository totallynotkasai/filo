import { uiStore } from '../../stores/ui.svelte';
import type { SaveState } from '../../stores/saveState.svelte';
import { quitFailureBody, rescueFailedDialog, type RescueResult, type UnsavedItem } from './unsavedMessages';

/**
 * Flush-and-quit handler, extracted from `App.svelte` for testability.
 *
 * The happy path (save succeeded and the save-state store reports no
 * lingering error) sends `app:ready-to-quit` immediately, no UI. On a
 * failure, a Confirm dialog blocks the quit with "Retry now" / "Quit anyway"
 * / "Stay open" — never a silent quit. Its text names each unsaved file and
 * why it isn't on disk. Retry now re-fires the retained failed writes and
 * drains again; Quit anyway first keeps a rescue copy of each unsaved change
 * in `.filo/recovery/` (and asks once more for any it couldn't copy);
 * Stay open sends `app:cancel-quit` so main can rewind `isFlushingForQuit`
 * and the user keeps editing.
 *
 * Dependencies are injected so the unit test can drive every branch
 * without mocking the whole renderer.
 */
export interface QuitFlushDeps {
  saveStateState: () => SaveState;
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
   * Awaits the dirty-flag sentinel mutex tail (the fire-and-forget `markClean`
   * `save()` enqueued while draining) so it lands on disk BEFORE we tell main
   * to destroy the renderer — else the next launch shows a phantom recovery
   * prompt. Production wires `flushDirtyFlagSentinel`.
   */
  flushSentinel?: () => Promise<void>;
  /**
   * Re-fires every retained failed write (all five schedulers)
   * before the "Retry now" drain. Production wires `retryAllFailedWrites`.
   */
  retryFailed?: () => Promise<unknown>;
  /** Each unsaved path and why, for the dialog. Production wires `describeUnsaved`. */
  describeUnsaved?: () => Promise<UnsavedItem[]>;
  /** Partial `.tmp` files a failed write preserved. Production wires `preservedTmpCount`. */
  preservedTmpCount?: () => Promise<number>;
  /** Rescue copies before "Quit anyway". Production wires `keepRescueCopies`. */
  keepRescueCopies?: () => Promise<RescueResult>;
  /**
   * Freezes the editors for the whole quit, as leaving a vault does, so no
   * keystroke lands after the check; returns the thaw, called only when the
   * user stays. Production wires `holdCloseDrainUntilSwap`.
   */
  freeze?: () => () => void;
  /**
   * The same check leaving a vault makes: nothing pending, failed, in flight,
   * unserialised or in an open raw view. Production wires
   * `isUnsavedWorkEmpty(unsavedWork())`.
   */
  nothingUnsaved?: () => boolean;
}

/**
 * Heartbeat cadence while `save()` drains. Must stay comfortably
 * below main's `FLUSH_TIMEOUT_MS` (5 s) so the destroy timer main re-arms on
 * each beat never lapses in the gap between two beats on a slow drain.
 */
const DRAIN_HEARTBEAT_MS = 2000;

/**
 * Absolute ceiling on the automated drain. The heartbeat re-arms main's
 * destroy timer every ~2 s, so without this a `save()` that never resolves
 * would block quit forever. On elapse we stop beating and hand the decision to
 * the user via the "Save failed" confirm. Matches the per-write bound (60 s),
 * so it only fires on a genuine stall.
 */
const QUIT_DRAIN_DEADLINE_MS = 60_000;

/**
 * Bound on the terminal `.filo/.dirty` sentinel flush. By the
 * time it runs the heartbeat is already cleared, so main's 5 s destroy timer is
 * the implicit backstop; bounding it explicitly keeps the renderer-initiated
 * clean shutdown deterministic instead of racing that timer.
 */
const SENTINEL_FLUSH_DEADLINE_MS = 5_000;

/**
 * Re-entrancy guard (defense-in-depth). A second `app:flush-and-quit` dispatch
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
 * Flushes the dirty-flag sentinel mutex tail,
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
  // Re-entrancy guard (see `isDrainingForQuit`). A concurrent dispatch
  // no-ops; the first invocation drives the quit to a terminal signal.
  if (isDrainingForQuit) return;
  isDrainingForQuit = true;
  const thaw = deps.freeze?.();
  try {
    // Staying (or anything that stops the quit) thaws the editors; a quit
    // that goes ahead leaves them frozen until the window closes.
    if (!(await drainAndQuit(deps))) thaw?.();
  } catch (err) {
    thaw?.();
    throw err;
  } finally {
    isDrainingForQuit = false;
  }
}

/** True when the quit went ahead (`app:ready-to-quit` was sent). */
async function drainAndQuit(deps: QuitFlushDeps): Promise<boolean> {
  // Beat a drain-in-progress signal BEFORE and DURING the flush. Main arms a
  // 5 s auto-destroy timer when it asks us to flush; a legitimately long drain
  // (large vault on OneDrive) would otherwise be destroyed mid-write. Each beat
  // re-arms main's timer, so the ceiling bounds inter-beat SILENCE rather than
  // total drain time. The failure branch's open-ended confirm is bounded by
  // `app:quit-awaiting-user`, not the heartbeat.
  //
  // "Retry now" loops back here: it re-fires every retained
  // failed write (`retryFailed`) and drains again under a fresh heartbeat.
  let retrying = false;
  for (;;) {
    const failed = await runDrain(deps, retrying);
    const state = deps.saveStateState();
    // The save's own result can't see a change handed over after it ran, so
    // the quit also asks what close asks: is anything at all left unsaved?
    const nothingLeft = deps.nothingUnsaved ? deps.nothingUnsaved() : true;
    if (!failed && nothingLeft && state !== 'error' && state !== 'attention') {
      // Let the queued markClean reach disk (bounded) before
      // main destroys us, or `.filo/.dirty` survives a clean quit → phantom
      // recovery next launch.
      await flushSentinelBounded(deps);
      deps.send('app:ready-to-quit');
      return true;
    }
    // Save failed (or the save-state store still carries an unresolved error
    // from an earlier debounced write). Block the quit until the user
    // explicitly chooses: Retry now, Quit anyway (rescue copies first) or
    // Stay open.
    //
    // Tell main a human is now in the loop BEFORE the open-ended confirm, so it
    // clears its 5 s auto-destroy timer (which would otherwise vanish the
    // dialog and discard the choice). The ready/cancel reply drives the quit.
    deps.send('app:quit-awaiting-user');
    const body = quitFailureBody(await settledOr(deps.describeUnsaved, []), await settledOr(deps.preservedTmpCount, 0));
    const choice = await new Promise<'quit' | 'stay' | 'retry'>((resolve) => {
      uiStore.openConfirm({
        title: 'Save failed',
        body,
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
      if (!(await keepRescueCopiesOrAsk(deps))) {
        deps.send('app:cancel-quit');
        return false;
      }
      // On "Quit anyway" the sentinel is (correctly) DIRTY: failed writes
      // enqueued a markDirty. Flush it (bounded) so the next launch's
      // recovery prompt accurately names the lost paths instead of racing the
      // renderer's destroy.
      await flushSentinelBounded(deps);
      deps.send('app:ready-to-quit');
      return true;
    }
    deps.send('app:cancel-quit');
    return false;
  }
}

/** `fn()`'s value, or `fallback` when there is no `fn` or it throws. */
async function settledOr<T>(fn: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (!fn) return fallback;
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Keeps a rescue copy of every unsaved change before "Quit anyway" lets it go.
 * True to go on quitting: every copy was written, or the user confirmed losing
 * the ones that couldn't be.
 */
async function keepRescueCopiesOrAsk(deps: QuitFlushDeps): Promise<boolean> {
  if (!deps.keepRescueCopies) return true;
  const rescue = await settledOr<RescueResult | null>(deps.keepRescueCopies, null);
  const notKept = rescue ? rescue.notKept : ['your unsaved changes'];
  if (notKept.length === 0) return true;
  const again = rescueFailedDialog(notKept, 'Quit anyway');
  return new Promise<boolean>((resolve) => {
    uiStore.openConfirm({
      title: again.message,
      body: again.detail,
      confirmLabel: again.anyway,
      cancelLabel: 'Stay open',
      danger: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/**
 * One bounded drain under the heartbeat. Returns true when it FAILED. On a
 * retry pass the retained failed writes are re-fired first;
 * `save()` then drains everything else.
 */
async function runDrain(deps: QuitFlushDeps, retryFirst: boolean): Promise<boolean> {
  deps.send('app:drain-heartbeat');
  const heartbeat = setInterval(() => deps.send('app:drain-heartbeat'), DRAIN_HEARTBEAT_MS);
  try {
    // Bound the drain. A wedged write the per-scheduler
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

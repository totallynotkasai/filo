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
 * dialog with "Quit anyway" / "Stay open and retry". The latter sends
 * `app:cancel-quit` so main can rewind `isFlushingForQuit` and the user
 * keeps editing.
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
}

/**
 * Audit5 2.1 — heartbeat cadence while `save()` drains. Must stay comfortably
 * below main's `FLUSH_TIMEOUT_MS` (5 s) so the destroy timer main re-arms on
 * each beat never lapses in the gap between two beats on a slow drain.
 */
const DRAIN_HEARTBEAT_MS = 2000;

export async function handleFlushAndQuit(deps: QuitFlushDeps): Promise<void> {
  // Audit5 2.1 (#2) — beat a drain-in-progress signal BEFORE and DURING the
  // flush. Main arms a 5 s auto-destroy timer the instant it asks us to flush;
  // a drain that legitimately runs longer than that (a large vault on a
  // contended volume — the user's vault lives under OneDrive) would otherwise
  // have the window destroyed mid-write, losing the very edits we're saving.
  // Each beat re-arms main's timer, so the ceiling bounds inter-beat SILENCE
  // (a wedged renderer) rather than total honest drain time. The interval is
  // cleared the moment `save()` settles — the failure branch's open-ended
  // confirm is then bounded by `app:quit-awaiting-user`, not the heartbeat.
  deps.send('app:drain-heartbeat');
  const heartbeat = setInterval(() => deps.send('app:drain-heartbeat'), DRAIN_HEARTBEAT_MS);

  let failed = false;
  try {
    const ok = await deps.save();
    if (!ok) failed = true;
  } catch (err) {
    deps.reportError('App', err, 'flush-and-quit failed');
    failed = true;
  } finally {
    clearInterval(heartbeat);
  }
  if (!failed && deps.saveStateState() !== 'error') {
    // Audit-6 M5 — let the queued markClean reach disk before main destroys us,
    // or `.filo/.dirty` survives a clean quit → phantom recovery next launch.
    await deps.flushSentinel?.();
    deps.send('app:ready-to-quit');
    return;
  }
  // Save failed (or the save-state store still carries an unresolved
  // error from an earlier debounced write). Block the quit until the
  // user explicitly chooses: Quit anyway (accept data loss; the user
  // can recover .tmp files from disk) or Stay open and retry.
  //
  // Audit-4 DI-04 — heartbeat BEFORE the confirm. The dialog below is
  // open-ended (no timeout), but main destroys the window after a 5 s flush
  // ceiling. A human reading a "Save failed" dialog routinely takes longer
  // than 5 s, so the timer would fire first, vanish the dialog, and discard
  // the choice (and the edits). Tell main a human is now in the loop so it
  // clears that auto-destroy timer; the ready/cancel reply below then drives
  // the real quit on the user's schedule.
  deps.send('app:quit-awaiting-user');
  const quitAnyway = await new Promise<boolean>((resolve) => {
    uiStore.openConfirm({
      title: 'Save failed',
      body:
        "Filo couldn't write your latest changes to disk. Quitting now " +
        'will lose those edits — Filo preserved emergency .tmp files in ' +
        "the vault that you can recover manually if you do. Pick " +
        '"Stay open and retry" to keep editing.',
      confirmLabel: 'Quit anyway',
      cancelLabel: 'Stay open and retry',
      danger: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
  if (quitAnyway) {
    // Audit-6 M5 — on "Quit anyway" the sentinel is (correctly) DIRTY: failed
    // writes enqueued a markDirty. Flush it so the next launch's recovery prompt
    // accurately names the lost paths instead of racing the renderer's destroy.
    await deps.flushSentinel?.();
    deps.send('app:ready-to-quit');
  } else {
    deps.send('app:cancel-quit');
  }
}

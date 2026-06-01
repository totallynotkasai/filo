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
  send: (channel: 'app:ready-to-quit' | 'app:cancel-quit') => void;
  reportError: (context: string, err: unknown, msg: string) => void;
}

export async function handleFlushAndQuit(deps: QuitFlushDeps): Promise<void> {
  let failed = false;
  try {
    const ok = await deps.save();
    if (!ok) failed = true;
  } catch (err) {
    deps.reportError('App', err, 'flush-and-quit failed');
    failed = true;
  }
  if (!failed && deps.saveStateState() !== 'error') {
    deps.send('app:ready-to-quit');
    return;
  }
  // Save failed (or the save-state store still carries an unresolved
  // error from an earlier debounced write). Block the quit until the
  // user explicitly chooses: Quit anyway (accept data loss; the user
  // can recover .tmp files from disk) or Stay open and retry.
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
  deps.send(quitAnyway ? 'app:ready-to-quit' : 'app:cancel-quit');
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleFlushAndQuit } from '@renderer/lib/vault/handleFlushAndQuit';
import { uiStore } from '@renderer/stores/ui.svelte';

/**
 * 6.2.H4 — flush-and-quit handler. Pre-fix, the renderer slept 200 ms on a
 * save failure and unconditionally sent `app:ready-to-quit`; the user had
 * about 200 ms to read a toast naming a `<path>.<nonce>.tmp` location
 * before the window destroyed.
 *
 * The handler now sends `app:ready-to-quit` immediately on success, and
 * surfaces a Confirm with "Quit anyway" / "Stay open and retry" on
 * failure. The latter sends a new `app:cancel-quit` signal that the main
 * process uses to rewind `isFlushingForQuit` so the user can keep editing.
 */
describe('handleFlushAndQuit — 6.2.H4 save-failure confirm flow', () => {
  beforeEach(() => {
    uiStore.closeConfirm();
  });

  afterEach(() => {
    uiStore.closeConfirm();
  });

  it('happy path: save succeeds → sends ready-to-quit immediately, no Confirm', async () => {
    let sentChannel: string | null = null;
    await handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => true,
      send: (c) => {
        sentChannel = c;
      },
      reportError: () => {},
    });
    expect(sentChannel).toBe('app:ready-to-quit');
    expect(uiStore.confirmDialog).toBeNull();
  });

  it('save fails (returns false): opens Confirm with Quit anyway / Stay open labels', async () => {
    const sent: string[] = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => {
        sent.push(c);
      },
      reportError: () => {},
    });

    // Yield to let openConfirm fire.
    await new Promise((r) => setTimeout(r, 10));

    expect(uiStore.confirmDialog).not.toBeNull();
    expect(uiStore.confirmDialog?.title).toBe('Save failed');
    expect(uiStore.confirmDialog?.confirmLabel).toBe('Quit anyway');
    expect(uiStore.confirmDialog?.cancelLabel).toBe('Stay open and retry');

    // Audit-4 DI-04 — the heartbeat has fired (so main cleared its
    // auto-destroy timer), but no TERMINAL quit signal yet — the window must
    // stay alive until the user clicks something.
    expect(sent).toEqual(['app:quit-awaiting-user']);

    // User picks "Quit anyway".
    uiStore.confirmDialog!.onConfirm(false);
    uiStore.closeConfirm();
    await promise;
    expect(sent).toEqual(['app:quit-awaiting-user', 'app:ready-to-quit']);
  });

  it('DI-04: emits app:quit-awaiting-user BEFORE opening the confirm on a save failure', async () => {
    // The heartbeat must reach main before the (open-ended) confirm appears so
    // main can clear its FLUSH_TIMEOUT_MS auto-destroy timer first — otherwise
    // the timer fires, destroys the window under the dialog, and discards the
    // user's choice + edits.
    const order: string[] = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => {
        if (c === 'app:quit-awaiting-user') {
          // At heartbeat time the confirm must not be open yet.
          expect(uiStore.confirmDialog).toBeNull();
        }
        order.push(c);
      },
      reportError: () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(uiStore.confirmDialog).not.toBeNull();
    expect(order).toEqual(['app:quit-awaiting-user']);

    uiStore.confirmDialog!.onCancel?.();
    uiStore.closeConfirm();
    await promise;
    expect(order).toEqual(['app:quit-awaiting-user', 'app:cancel-quit']);
  });

  it('save fails + Stay open: sends app:cancel-quit (no ready-to-quit)', async () => {
    let sentChannel: string | null = null;
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => {
        sentChannel = c;
      },
      reportError: () => {},
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(uiStore.confirmDialog).not.toBeNull();
    uiStore.confirmDialog!.onCancel?.();
    uiStore.closeConfirm();
    await promise;
    expect(sentChannel).toBe('app:cancel-quit');
  });

  it('save throws: also opens Confirm and routes both outcomes', async () => {
    let sentChannel: string | null = null;
    const reported: Array<[string, unknown, string]> = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => {
        throw new Error('disk full');
      },
      send: (c) => {
        sentChannel = c;
      },
      reportError: (ctx, err, msg) => {
        reported.push([ctx, err, msg]);
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(reported).toHaveLength(1);
    expect(reported[0][0]).toBe('App');
    expect(uiStore.confirmDialog).not.toBeNull();

    uiStore.confirmDialog!.onCancel?.();
    uiStore.closeConfirm();
    await promise;
    expect(sentChannel).toBe('app:cancel-quit');
  });

  it('save returns true but saveStateStore reports error: still opens Confirm', async () => {
    // A debounced write that errored a few seconds ago can leave the
    // save-state at 'error' even when the per-call drains return true
    // for this flush. Don't quit silently in that case.
    let sentChannel: string | null = null;
    const promise = handleFlushAndQuit({
      saveStateState: () => 'error',
      save: async () => true,
      send: (c) => {
        sentChannel = c;
      },
      reportError: () => {},
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(uiStore.confirmDialog).not.toBeNull();
    uiStore.confirmDialog!.onConfirm(false);
    uiStore.closeConfirm();
    await promise;
    expect(sentChannel).toBe('app:ready-to-quit');
  });
});

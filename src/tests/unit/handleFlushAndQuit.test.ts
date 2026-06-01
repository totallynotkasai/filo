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
    let sentChannel: string | null = null;
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => {
        sentChannel = c;
      },
      reportError: () => {},
    });

    // Yield to let openConfirm fire.
    await new Promise((r) => setTimeout(r, 10));

    expect(uiStore.confirmDialog).not.toBeNull();
    expect(uiStore.confirmDialog?.title).toBe('Save failed');
    expect(uiStore.confirmDialog?.confirmLabel).toBe('Quit anyway');
    expect(uiStore.confirmDialog?.cancelLabel).toBe('Stay open and retry');

    // Sentinel: no quit signal until the user clicks something.
    expect(sentChannel).toBeNull();

    // User picks "Quit anyway".
    uiStore.confirmDialog!.onConfirm(false);
    uiStore.closeConfirm();
    await promise;
    expect(sentChannel).toBe('app:ready-to-quit');
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

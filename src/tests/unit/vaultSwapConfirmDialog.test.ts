/**
 * A vault swap must resolve any pending confirm dialog rather than nulling it
 * out from under an awaiting caller.
 *
 * `tabStore.close` / `closeOthers` show a "Save failed — close anyway?"
 * confirm via `confirmCloseAnyway`, which returns a Promise resolved ONLY by
 * the dialog's `onConfirm` (→true) or `onCancel` (→false). The `ui` pre-swap
 * handler used to set `confirmDialog = null` directly, firing neither
 * callback — so a vault swap that landed while that confirm was open left the
 * promise pending forever and suspended the awaiting `close()` (phantom tab).
 *
 * The fix routes the pre-swap dismissal through the confirm's `onCancel` so
 * the awaited promise settles to `false` and the close returns cleanly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';

afterEach(() => {
  // Defensive: clear any confirm left open so state can't leak between tests.
  uiStore.closeConfirm();
});

describe('vault swap settles a pending confirm dialog', () => {
  it('fires the confirm dialog onCancel during a pre-swap (does not hang the awaiting promise)', async () => {
    // Model exactly what `confirmCloseAnyway` does: a promise resolved only
    // by the dialog callbacks.
    let settled: 'pending' | boolean = 'pending';
    const proceed = new Promise<boolean>((resolve) => {
      uiStore.openConfirm({
        title: 'Save failed',
        body: "Filo couldn't save the latest changes.",
        confirmLabel: 'Close anyway',
        cancelLabel: 'Cancel',
        danger: true,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    void proceed.then((v) => { settled = v; });

    expect(uiStore.confirmDialog).not.toBeNull();
    expect(settled).toBe('pending');

    await fireVaultSwap({
      phase: 'pre-swap',
      previousVault: '/vault/A',
      nextVault: '/vault/B',
      saveOutgoing: false,
    });

    // The dialog is cleared AND its onCancel fired, resolving the promise.
    expect(uiStore.confirmDialog).toBeNull();
    await expect(proceed).resolves.toBe(false);
    expect(settled).toBe(false);
  });

  it('leaves no confirm dialog open after a swap when none was showing', async () => {
    expect(uiStore.confirmDialog).toBeNull();
    await fireVaultSwap({
      phase: 'pre-swap',
      previousVault: '/vault/A',
      nextVault: '/vault/B',
      saveOutgoing: false,
    });
    expect(uiStore.confirmDialog).toBeNull();
  });
});

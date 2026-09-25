import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fireVaultSwap,
  __getResettableHandlerNames,
} from '@renderer/core/vaultLifecycle';
import { uiStore } from '@renderer/stores/ui.svelte';

/**
 * Module-level state that must reset on a vault swap:
 *
 *   - `vaultExternalChanges.inFlightDriftPrompts`: the per-path
 *     Reload/Keep-local promise dedup map. Without reset, an unresolved
 *     entry from the outgoing vault would block a fresh prompt for the
 *     same path in the new vault.
 *   - `ui.toasts onDismiss`: the `ui` pre-swap handler fires each toast's
 *     `onDismiss` before nulling the array. A prompt-shaped toast whose
 *     Promise resolves only through onAction/onDismiss would otherwise hang
 *     across the swap.
 */

describe('module state registered for vault-swap reset', () => {
  beforeEach(async () => {
    // Force every store / lib that subscribes a pre-swap handler to
    // evaluate so the registry sees the subscription.
    await Promise.all([
      import('@renderer/stores/vaultExternalChanges'),
      import('@renderer/stores/ui.svelte'),
    ]);
  });

  afterEach(() => {
    // Best-effort: drop any toasts left over from the test.
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  it('the drift-prompt dedup map is registered through vaultSwapResettable', () => {
    const names = __getResettableHandlerNames();
    expect(names.has('vaultExternalChanges.inFlightDriftPrompts')).toBe(true);
  });

  it('uiStore.pushToast.onDismiss fires on vault swap', async () => {
    let dismissedCount = 0;
    uiStore.pushToast({
      text: 'persistent toast',
      type: 'info',
      duration: 0,
      onDismiss: () => {
        dismissedCount++;
      },
    });
    uiStore.pushToast({
      text: 'second persistent toast',
      type: 'warning',
      duration: 0,
      onDismiss: () => {
        dismissedCount++;
      },
    });
    expect(uiStore.toasts.length).toBe(2);

    await fireVaultSwap({
      phase: 'pre-swap',
      previousVault: '/a',
      nextVault: '/b',
      saveOutgoing: false,
    });

    expect(uiStore.toasts.length).toBe(0);
    // Both onDismiss callbacks fired exactly once.
    expect(dismissedCount).toBe(2);
  });

  it('uiStore.pushToast without onDismiss is still cleared without error', async () => {
    uiStore.pushToast({ text: 'no-callback toast', type: 'info' });
    expect(uiStore.toasts.length).toBe(1);
    await expect(
      fireVaultSwap({
        phase: 'pre-swap',
        previousVault: '/a',
        nextVault: '/b',
        saveOutgoing: false,
      }),
    ).resolves.toBeUndefined();
    expect(uiStore.toasts.length).toBe(0);
  });
});

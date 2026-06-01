import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fireVaultSwap,
  __getResettableHandlerNames,
} from '@renderer/core/vaultLifecycle';
import { uiStore } from '@renderer/stores/ui.svelte';

/**
 * Phase 6.1.R2 — the four module-level subscriptions class-killed in this
 * pass:
 *
 *   - `vaultExternalChanges.inFlightDriftPrompts`: the per-path
 *     Reload/Keep-local promise dedup map. Without reset, an unresolved
 *     entry from the outgoing vault would block a fresh prompt for the
 *     same path in the new vault.
 *   - `fileTags.readOnlyTagToastShown`: docId-keyed Set that suppresses
 *     duplicate "tag updated but body not saved" toasts. Without reset,
 *     a docId that coincides across vaults (id collision, in-memory
 *     reuse) would suppress a legitimate toast.
 *   - `markdownFileWriter.testFlushers`: the test-only flusher registry.
 *     Defense-in-depth for tests that fire `fireVaultSwap` between
 *     fixtures and rely on the gateway's own per-test reset NOT having
 *     fired yet.
 *   - `ui.toasts onDismiss`: the existing `ui` pre-swap handler now
 *     fires each toast's `onDismiss` before nulling the array. A
 *     prompt-shaped toast whose Promise resolves only through
 *     onAction/onDismiss would otherwise hang across the swap.
 */

describe('Phase 6.1.R2 — leakers registered for vault-swap reset', () => {
  beforeEach(async () => {
    // Force every store / lib that subscribes a pre-swap handler to
    // evaluate so the registry sees the subscription.
    await Promise.all([
      import('@renderer/stores/vaultExternalChanges'),
      import('@renderer/stores/fileTags.svelte'),
      import('@renderer/lib/vault/markdownFileWriter'),
      import('@renderer/stores/ui.svelte'),
    ]);
  });

  afterEach(() => {
    // Best-effort: drop any toasts left over from the test.
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  it('the four new leakers are registered through vaultSwapResettable', () => {
    const names = __getResettableHandlerNames();
    expect(names.has('vaultExternalChanges.inFlightDriftPrompts')).toBe(true);
    expect(names.has('fileTags.readOnlyTagToastShown')).toBe(true);
    expect(names.has('markdownFileWriter.testFlushers')).toBe(true);
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

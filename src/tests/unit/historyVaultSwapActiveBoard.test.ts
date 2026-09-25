import { describe, it, expect } from 'vitest';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { historyStore } from '@renderer/stores/history.svelte';

/**
 * A vault swap forgets which board was active. Otherwise a vault opened with
 * no board on screen files its commands (a sidebar delete's undo, say) under
 * the previous vault's board id, where no Ctrl+Z can reach them — and the
 * sidebar delete wouldn't know to offer its Undo toast instead.
 */
describe('history — the active board across a vault swap', () => {
  it('is cleared by the swap', async () => {
    historyStore.setActiveBoard('board-in-old-vault');
    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/A', nextVault: '/B', saveOutgoing: false });
    expect(historyStore.activeBoardId).toBeNull();
  });
});

/**
 * D.9 — `recoveryDismissedResolver` must remain safe across a vault swap
 * during a parked recovery modal. The resolver captures the vault path
 * at creation, fires the awaiting promise regardless on Dismiss (so the
 * sequencer chain doesn't hang), and the post-await sequencer steps use
 * the captured `newVaultPath` plus a vault-identity guard to short-
 * circuit if the user picked a different vault during the modal's
 * lifetime.
 *
 * The internal state machine isn't directly exported. Instead this test
 * exercises the public contract via the recovery slice + a ctx mock
 * that swaps vault paths between calls, asserting:
 *  - `acknowledgeRecovery` always invokes `ctx.resolveRecoveryDismissed`
 *    even when the vault has swapped (so the awaiter doesn't hang).
 *  - The slice's `markClean` IPC fires against the CURRENT vault root,
 *    not a stale captured one, when invoked post-swap (so a confused
 *    sequencer doesn't write a sentinel into the wrong vault).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeRecoverySlice } from '@renderer/stores/vaultRecovery';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('recovery — D.9 resolver vault identity', () => {
  let writes: Array<{ channel: string; args: unknown[] }>;
  let activeVault: string;
  let resolverCalls: number;
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeRecoverySlice>;

  beforeEach(() => {
    writes = [];
    activeVault = '/vault-A';
    resolverCalls = 0;
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      return { success: true };
    });
    ctx = {
      getVaultPath: () => activeVault,
      setVaultPath: (next) => { activeVault = next ?? ''; },
      getFileTree: () => [],
      setFileTree: () => {},
      getSearchQuery: () => '',
      setSearchQuery: () => {},
      getIsLoading: () => false,
      setIsLoading: () => {},
      getExpandedFolders: () => new Set(),
      setExpandedFolders: () => {},
      getSelectedPaths: () => new Set(),
      setSelectedPaths: () => {},
      getProject: () => null,
      setProject: () => {},
      getRecoveryPendingPaths: () => [],
      setRecoveryPendingPaths: () => {},
      resolveRecoveryDismissed: () => {
        resolverCalls += 1;
      },
      markMetaDirty: () => {},
      refreshTree: async () => {},
      clearSelection: () => {},
      clearActiveRootFolderIfMatches: () => {},
    };
    slice = makeRecoverySlice(ctx);
  });

  afterEach(() => {
    restoreFiloDefault();
  });

  it('acknowledgeRecovery fires resolveRecoveryDismissed even after a vault swap', async () => {
    // Simulate the modal opening against vault A.
    expect(activeVault).toBe('/vault-A');
    // Vault swaps to B while the modal is parked.
    activeVault = '/vault-B';

    await slice.acknowledgeRecovery();

    // Resolver MUST fire — otherwise the sequencer hangs forever and
    // future recovery flows can't run. The sequencer is responsible
    // for noticing the vault swap via its own vault-identity check.
    expect(resolverCalls).toBe(1);
  });

  it('markClean writes against the CURRENT vault root (not a stale captured one)', async () => {
    activeVault = '/vault-B';

    await slice.acknowledgeRecovery();

    // The sentinel delete is bracketed by the current vault root, not
    // whatever vault was open when the modal first appeared.
    const sentinelDelete = writes.find(
      (w) =>
        w.channel === 'vault:delete' &&
        String(w.args[1]).endsWith('.filo/.dirty.a1b2c3d4e5f6'),
    );
    expect(sentinelDelete).toBeDefined();
    expect(String(sentinelDelete?.args[0])).toBe('/vault-B');
  });

  it('idempotent under repeated acknowledge — resolver still fires once per call', async () => {
    await slice.acknowledgeRecovery();
    await slice.acknowledgeRecovery();
    // The slice itself doesn't dedupe; vault.svelte.ts caps the
    // resolver at "set once per await". Both invocations propagate
    // through the slice to the ctx hook.
    expect(resolverCalls).toBe(2);
  });
});

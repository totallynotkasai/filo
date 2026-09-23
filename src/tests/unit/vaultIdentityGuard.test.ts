import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  beginVaultGeneration,
  captureVaultIdentity,
  isStillSameVault,
  currentVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import {
  withDrainedWrites,
  __resetDrainGuardForTests,
} from '@renderer/lib/vault/vaultOperations';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-5 G1 — generalized post-`await` vault-identity guard.
 *
 * Three layers under test:
 *   1. The `vaultIdentity` module — capture / compare / generation token,
 *      including the close→reopen-same-path case the bare `path ===` compare
 *      misses.
 *   2. `withDrainedWrites` re-entrancy keyed by GENERATION — a nested call in
 *      the same generation short-circuits its drain; a call after a mid-op
 *      swap (different generation) drains again instead of skipping.
 *   3. The `renameQueue` enqueue guard — a task enqueued against the outgoing
 *      vault no-ops if the vault swaps before it runs.
 */

describe('vaultIdentity module (G1)', () => {
  beforeEach(() => __resetVaultIdentityForTests());

  it('isStillSameVault holds within a generation and breaks after a swap', () => {
    beginVaultGeneration('/vaultA');
    const id = captureVaultIdentity();
    expect(isStillSameVault(id)).toBe(true);
    beginVaultGeneration('/vaultB');
    expect(isStillSameVault(id)).toBe(false);
  });

  it('detects a close→reopen of the SAME path via the generation token', () => {
    beginVaultGeneration('/vaultA');
    const id = captureVaultIdentity();
    beginVaultGeneration(''); // close to home
    beginVaultGeneration('/vaultA'); // reopen same path — different instance
    expect(id.path).toBe('/vaultA');
    expect(isStillSameVault(id)).toBe(false);
  });

  it('currentVaultGeneration increments on each begin', () => {
    const g0 = currentVaultGeneration();
    beginVaultGeneration('/x');
    expect(currentVaultGeneration()).toBe(g0 + 1);
    beginVaultGeneration('/y');
    expect(currentVaultGeneration()).toBe(g0 + 2);
  });
});

describe('withDrainedWrites — generation-scoped re-entrancy (G1)', () => {
  beforeEach(() => {
    __resetVaultIdentityForTests();
    __resetDrainGuardForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    __resetDrainGuardForTests();
    __resetVaultIdentityForTests();
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('drains ONCE for a nested call in the same generation', async () => {
    beginVaultGeneration('/vault');
    const drainSpy = vi
      .spyOn(boardCacheStore, 'flushAllDirty')
      .mockResolvedValue({ failed: [] });
    await withDrainedWrites(async () => {
      // Nested call, same generation → re-entrancy guard short-circuits.
      await withDrainedWrites(async () => 'inner');
    });
    expect(drainSpy).toHaveBeenCalledTimes(1);
  });

  it('drains AGAIN for a nested call after a mid-op vault swap', async () => {
    beginVaultGeneration('/vaultA');
    const drainSpy = vi
      .spyOn(boardCacheStore, 'flushAllDirty')
      .mockResolvedValue({ failed: [] });
    await withDrainedWrites(async () => {
      // A vault swap lands during the outer op. The nested call now belongs
      // to a different generation, so it must NOT be treated as re-entrant —
      // it has to drain the NEW vault's writers itself.
      beginVaultGeneration('/vaultB');
      await withDrainedWrites(async () => 'inner-after-swap');
    });
    expect(drainSpy).toHaveBeenCalledTimes(2);
  });
});

describe('renameQueue enqueue guard (G1)', () => {
  afterEach(() => {
    __resetVaultIdentityForTests();
  });

  it('runs an enqueued task when the vault is unchanged', async () => {
    vaultStore.setPath('/vaultA');
    let ran = false;
    await vaultStore.enqueueRenameQueueWork(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('no-ops an enqueued task if the vault swaps before it runs', async () => {
    vaultStore.setPath('/vaultA');
    let ran = false;
    // Capture happens synchronously at enqueue; the task body is deferred to a
    // microtask. Swapping the vault synchronously before awaiting means the
    // guard sees a stale identity when the body would otherwise run.
    const p = vaultStore.enqueueRenameQueueWork(async () => {
      ran = true;
    });
    vaultStore.setPath('/vaultB');
    await p;
    expect(ran).toBe(false);
  });
});

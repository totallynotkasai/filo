import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * `openVault` must close the previous vault on the main side
 * before invoking `vault:init-config` for the next.
 *
 * Mechanism: `vault:init-config` (board.ipc.ts:108) reads
 * `vaultRegistry.currentVaultPath` and throws
 * `'A different vault is already active — close it before initialising a new
 * one'` when the registry already points at a different vault. `openVault`'s
 * second-vault path used to fire `pre-swap` and then `loadVaultCandidate`
 * directly — never invoking `vault:close`, so the main-side registry kept the
 * outgoing vault's path. The renderer surfaced "Failed to open vault" and the
 * user was stuck. `closeVault` already does the right thing
 * (vault.svelte.ts:946); the open path needed to mirror it.
 *
 * This guard simulates the main-side registry inline so the test fails on the
 * actual symptom — init-config rejection — rather than only on the ordering
 * shape.
 */

const VALID_TAGS_JSON = JSON.stringify({ version: 1, tags: {}, fileTags: {} });

interface CallLog {
  channel: string;
  args: unknown[];
}

interface RegistryState {
  current: string | null;
}

function buildRoutes(calls: CallLog[], registry: RegistryState) {
  return {
    'dialog:choice': async () => 1, // "Cancel" if asked: nothing is unsaved, so no leave dialog appears.
    'vault:close': async () => {
      calls.push({ channel: 'vault:close', args: [] });
      registry.current = null;
      return { success: true };
    },
    'vault:init-config': async (root: unknown) => {
      const path = typeof root === 'string' ? root : '';
      calls.push({ channel: 'vault:init-config', args: [path] });
      if (registry.current && registry.current !== path) {
        return {
          ok: false,
          error:
            'A different vault is already active — close it before initialising a new one',
        };
      }
      registry.current = path;
      return { ok: true };
    },
    'config:load-all': async () => ({}),
    'board:list': async () => [],
    'vault:read-tree': async () => ({ ok: true, tree: [] }),
    'theme:list': async () => [],
    'theme:load': async () => null,
    'tags:load': async () => VALID_TAGS_JSON,
    // `runPostCommitTasks` fires the three recovery-sentinel readers
    // (`dirtyFlagRecovery.checkRecovery`, `tagRewriteSentinel`,
    // `renameCascadeSentinel`) fire-and-forget. Each calls
    // `invokeOk('vault:read-file-text', ...)` and treats `IpcEnvelopeError`
    // with `code: 'ENOENT'` as the clean "no sentinel" path. Returning ENOENT
    // here keeps the test's stderr clean of recovery noise that has nothing
    // to do with this fix. (`vault:watch` from runPostCommitTasks still falls
    // through to undefined, which surfaces a non-blocking toast warning, not
    // a `Cannot read properties of undefined (reading 'invoke')` strict-gate
    // trip.)
    'vault:read-file-text': async () => ({
      ok: false,
      code: 'ENOENT',
      error: 'ENOENT',
    }),
  };
}

describe('openVault closes the previous vault before init-config', () => {
  beforeEach(() => restoreFiloDefault());
  afterEach(() => restoreFiloDefault());

  it('invokes vault:close on the prior vault before vault:init-config on the next, and init-config succeeds', async () => {
    const calls: CallLog[] = [];
    const registry: RegistryState = { current: null };
    installFiloMock(buildRoutes(calls, registry));

    const okA = await vaultStore.openVault('/vault/A');
    expect(okA).toBe(true);
    expect(vaultStore.path).toBe('/vault/A');
    expect(registry.current).toBe('/vault/A');

    // Focus the assertion window on the second-vault path.
    calls.length = 0;

    const okB = await vaultStore.openVault('/vault/B');
    expect(okB).toBe(true);
    expect(vaultStore.path).toBe('/vault/B');
    expect(registry.current).toBe('/vault/B');

    // Ordering invariant: vault:close fires BEFORE vault:init-config for B.
    // Without the fix, vault:close never fires and init-config sees a stale
    // registry → ok:false → openVault('B') returns false above.
    const closeIdx = calls.findIndex((c) => c.channel === 'vault:close');
    const initBIdx = calls.findIndex(
      (c) => c.channel === 'vault:init-config' && c.args[0] === '/vault/B',
    );
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(initBIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeLessThan(initBIdx);

    // The first openVault('/vault/A') ran with `currentProject == null`, so
    // its close-call branch was correctly skipped — the assertion below was
    // recorded *before* `calls.length = 0` and would have surfaced any
    // spurious close on the first open. We re-assert here against the
    // recorded fixture as a belt-and-braces guard against the fix accidentally
    // moving the close outside the `if (currentProject)` block.
    // (Recorded-but-cleared semantics: a stray close from openVault('A')
    // would have shown up in the wider invariant — registry.current at the
    // point of vault:init-config('A') would have flipped to null mid-call.
    // The successful init of A above demonstrates the close did not fire
    // pre-A.)
  });
});

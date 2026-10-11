/**
 * A failed candidate load must NOT strand the user on an
 * empty-looking, half-torn-down vault.
 *
 * `openVault` tears the outgoing vault A down (pre-swap resets its stores;
 * `vault:close` releases the main registry) BEFORE the fallible
 * `loadVaultCandidate(B)`. That ordering is mandatory: `loadVaultCandidate`'s
 * first IPC, `vault:init-config`, is the single registry-arming authority and
 * main refuses to re-anchor B while A is active — so close-before-load is pinned
 * (vaultOpenClosesPriorVault.test.ts). If the B load then throws (here: a failing
 * `vault:read-tree`), the pre-fix code `reportError`+`return false` left the
 * renderer believing A was open (`vaultStore.path === A`) over empty stores, with
 * the main registry pointing at the half-opened B — and a follow-up save could
 * clobber A's `.filo/` layout.
 *
 * The fix reverts to the outgoing vault by reopening it from disk
 * (`revertToOutgoingVault`). The discriminating signal is the simulated main
 * registry: WITHOUT the fix it stays at B after a failed B-open; WITH the fix it
 * is re-anchored back to A. (`vaultStore.path` is `A` either way — it is never
 * reset on the failure path — so the registry is what proves the revert ran.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const VALID_TAGS_JSON = JSON.stringify({ version: 1, tags: {}, fileTags: {} });

interface CallLog {
  channel: string;
  args: unknown[];
}
interface RegistryState {
  current: string | null;
}

/**
 * Path-aware IPC routes with an inline main-side registry simulation (mirrors
 * vaultOpenClosesPriorVault.test.ts). `readTreeFails(root)` decides whether
 * `vault:read-tree` for a given root rejects — driving a candidate-load failure.
 */
function buildRoutes(
  calls: CallLog[],
  registry: RegistryState,
  readTreeFails: (root: string) => boolean,
) {
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
    'vault:read-tree': async (root: unknown) => {
      const path = typeof root === 'string' ? root : '';
      calls.push({ channel: 'vault:read-tree', args: [path] });
      if (readTreeFails(path)) {
        return { ok: false, code: 'EIO', error: 'read-tree boom' };
      }
      return { ok: true, tree: [] };
    },
    'theme:list': async () => [],
    'theme:load': async () => null,
    'tags:load': async () => VALID_TAGS_JSON,
    'vault:stat': async () => ({ ok: false, code: 'ENOENT', error: 'ENOENT' }),
    'vault:watch': async () => ({ success: true }),
    // Recovery sentinels (runPostCommitTasks) read these fire-and-forget; ENOENT
    // is the clean "no sentinel" path and keeps stderr quiet.
    'vault:read-file-text': async () => ({ ok: false, code: 'ENOENT', error: 'ENOENT' }),
  };
}

describe('openVault reverts to the outgoing vault on a failed load', () => {
  beforeEach(() => restoreFiloDefault());
  afterEach(() => restoreFiloDefault());

  it('reopens vault A (re-anchoring the registry) when vault B fails to load', async () => {
    const calls: CallLog[] = [];
    const registry: RegistryState = { current: null };
    // B's tree read fails; A's always succeeds (including the revert re-read).
    installFiloMock(buildRoutes(calls, registry, (root) => root === '/vault/B'));

    expect(await vaultStore.openVault('/vault/A')).toBe(true);
    expect(vaultStore.path).toBe('/vault/A');
    expect(registry.current).toBe('/vault/A');

    calls.length = 0; // focus on the failed-B path.

    const okB = await vaultStore.openVault('/vault/B');

    // The swap was abandoned, but A is fully restored — not left half-open.
    expect(okB).toBe(false);
    expect(vaultStore.path).toBe('/vault/A');
    // THE discriminator: without the fix the registry is stuck at '/vault/B'
    // (init-config(B) armed it, read-tree(B) then failed, no revert). The revert
    // closes B and re-anchors A.
    expect(registry.current).toBe('/vault/A');

    // The revert sequence ran: B's failed init-config, then a vault:close, then
    // a fresh init-config('/vault/A').
    const initBIdx = calls.findIndex(
      (c) => c.channel === 'vault:init-config' && c.args[0] === '/vault/B',
    );
    const closeAfterB = calls.findIndex(
      (c, i) => i > initBIdx && c.channel === 'vault:close',
    );
    const reinitAIdx = calls.findIndex(
      (c, i) =>
        i > closeAfterB &&
        c.channel === 'vault:init-config' &&
        c.args[0] === '/vault/A',
    );
    expect(initBIdx).toBeGreaterThanOrEqual(0);
    expect(closeAfterB).toBeGreaterThan(initBIdx);
    expect(reinitAIdx).toBeGreaterThan(closeAfterB);
  });

  it('control: a successful B open still commits and re-anchors to B', async () => {
    const calls: CallLog[] = [];
    const registry: RegistryState = { current: null };
    installFiloMock(buildRoutes(calls, registry, () => false)); // nothing fails

    expect(await vaultStore.openVault('/vault/A')).toBe(true);
    const okB = await vaultStore.openVault('/vault/B');

    expect(okB).toBe(true);
    expect(vaultStore.path).toBe('/vault/B');
    expect(registry.current).toBe('/vault/B');
  });

  it('falls to a clean no-vault state when the outgoing vault is also unreadable', async () => {
    const calls: CallLog[] = [];
    const registry: RegistryState = { current: null };
    // A's tree read succeeds on the first (initial) open but fails on the revert
    // re-read; B always fails. So both the B load AND the A re-open throw.
    let aTreeReads = 0;
    installFiloMock(
      buildRoutes(calls, registry, (root) => {
        if (root === '/vault/B') return true;
        if (root === '/vault/A') return ++aTreeReads > 1; // 1st ok, 2nd+ fail
        return false;
      }),
    );

    expect(await vaultStore.openVault('/vault/A')).toBe(true);

    const okB = await vaultStore.openVault('/vault/B');

    // Double failure → clean home state, and the registry is released so a
    // subsequent open isn't blocked by a stale anchor.
    expect(okB).toBe(false);
    expect(vaultStore.path).toBe('');
    expect(vaultStore.getData()).toBeNull();
    expect(registry.current).toBeNull();
  });
});

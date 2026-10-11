import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadVaultCandidate } from '@renderer/lib/vault/vaultCandidate';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Regression guard for the vault-open ordering. The worry: openVault flips the
 * renderer `vaultPath` while `vault:watch` (which arms the main-side
 * `vaultRegistry`) fires fire-and-forget, so a write triggered immediately
 * after open would be rejected by `assertActiveVault` (registry still stale),
 * surfacing a spurious save-failure toast + a transient `.filo/.dirty`.
 *
 * The registry is NOT armed by `vault:watch`. It is armed by `vault:init-config`
 * (`board.ipc.ts` → `vaultRegistry.setCurrentVault(vaultRoot)`), which
 * `loadVaultCandidate` awaits as its FIRST IPC (`vaultCandidate.ts:149`).
 * `openVault` awaits `loadVaultCandidate` BEFORE the synchronous
 * `commitVaultCandidate` that flips `vaultPath` (`vault.svelte.ts:876` → `:882`)
 * — so by the time the renderer considers the vault open (and the user can
 * write), the registry already points at the new vault. `vault:watch` (fired
 * later in `runPostCommitTasks`) only starts the file watcher and re-confirms
 * the already-armed registry; it is not the registration vector.
 *
 * This guard locks the ordering: `vault:init-config` is the first IPC
 * `loadVaultCandidate` invokes (before the config / board / theme / tags
 * loads).
 */

type InvokeRoutes = Record<string, (...args: unknown[]) => unknown | Promise<unknown>>;

const VALID_TAGS_JSON = JSON.stringify({ version: 1, tags: {}, fileTags: {} });

function happyPathRoutes(): InvokeRoutes {
  return {
    'vault:init-config': async () => ({ ok: true }),
    'config:load-all': async () => ({}),
    'board:list': async () => [],
    'vault:read-tree': async () => ({ ok: true, tree: [] }),
    'theme:list': async () => [],
    'theme:load': async () => null,
    'tags:load': async () => VALID_TAGS_JSON,
  };
}

describe('vault open registry-arming order', () => {
  beforeEach(() => restoreFiloDefault());
  afterEach(() => restoreFiloDefault());

  it('invokes vault:init-config (the registry arm) before any other open IPC', async () => {
    const calls: string[] = [];
    const recording: InvokeRoutes = {};
    for (const [channel, handler] of Object.entries(happyPathRoutes())) {
      recording[channel] = async (...args: unknown[]) => {
        calls.push(channel);
        return handler(...args);
      };
    }
    installFiloMock(recording);

    await loadVaultCandidate('/vault');

    // Registry is armed first — before config, boards, theme, tags load, and
    // (in the full flow) before commit flips vaultPath / vault:watch fires.
    expect(calls[0]).toBe('vault:init-config');
    expect(calls.indexOf('vault:init-config')).toBeLessThan(calls.indexOf('config:load-all'));
  });
});

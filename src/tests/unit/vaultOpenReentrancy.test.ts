/**
 * One vault open at a time. A second `openVault` started while another is
 * still loading (a click on a recent vault during the launch auto-open) does
 * nothing and reports 'busy'; the first commits with its registry armed.
 * Every `vault:close` names the vault it releases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { OpenVaultReport } from '@renderer/lib/vault/vaultOpenFailure';

const VALID_TAGS_JSON = JSON.stringify({ version: 1, tags: {}, fileTags: {} });

describe('openVault re-entrancy', () => {
  let registry: string | null;
  let closes: unknown[][];
  let releaseLoad: () => void;
  let loadGate: Promise<void>;

  beforeEach(() => {
    registry = null;
    closes = [];
    loadGate = new Promise<void>((r) => { releaseLoad = r; });
    installFiloMock({
      'dialog:choice': async () => 1,
      'vault:close': async (root: unknown) => {
        closes.push([root]);
        if (registry === root) registry = null;
        return { success: true };
      },
      'vault:init-config': async (root: unknown) => {
        if (registry && registry !== root) return { ok: false, error: 'A different vault is already active' };
        registry = String(root);
        return { ok: true };
      },
      'config:load-all': async () => {
        await loadGate;
        return {};
      },
      'board:list': async () => [],
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'theme:list': async () => [],
      'theme:load': async () => null,
      'tags:load': async () => VALID_TAGS_JSON,
      'vault:read-file-text': async () => ({ ok: false, code: 'ENOENT', error: 'ENOENT' }),
    });
  });

  afterEach(async () => {
    releaseLoad();
    await vaultStore.closeVault();
    restoreFiloDefault();
  });

  it('a second open while the first loads is refused as busy; the first commits with its registry armed', async () => {
    const first = vaultStore.openVault('/vault/A');
    await new Promise((r) => setTimeout(r, 0));
    expect(vaultStore.lifecycleBusy).toBe(true);

    const report: OpenVaultReport = {};
    expect(await vaultStore.openVault('/vault/B', report)).toBe(false);
    expect(report.failure).toBe('busy');

    releaseLoad();
    expect(await first).toBe(true);
    expect(vaultStore.path).toBe('/vault/A');
    expect(registry).toBe('/vault/A');
    expect(closes).toEqual([]);
    expect(vaultStore.lifecycleBusy).toBe(false);
  });

  it('closing names the vault it releases', async () => {
    releaseLoad();
    expect(await vaultStore.openVault('/vault/A')).toBe(true);
    expect(await vaultStore.closeVault()).toBe(true);
    expect(closes).toEqual([['/vault/A']]);
    expect(registry).toBeNull();
  });
});

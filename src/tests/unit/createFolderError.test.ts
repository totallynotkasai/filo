import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';

/**
 * vaultStore.createFolder propagates the IPC envelope so callers
 * can react to failures. Previously the wrapper coerced the result to a
 * plain boolean and discarded `{ code, error }`, so the sidebar's New Folder
 * button silently no-op'd on EACCES / EEXIST / vault-swap races.
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeRoute>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

describe('vaultStore.createFolder — error propagation', () => {
  beforeEach(() => {
    uninstallFiloStub();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    uninstallFiloStub();
  });

  it('returns { success: true } on a happy create', async () => {
    installFiloStub({
      'vault:create-folder': () => ({ success: true }),
      'vault:read-tree': () => ({ ok: true, tree: [] }),
    });
    const result = await vaultStore.createFolder('/vault', 'New Folder');
    expect(result.success).toBe(true);
  });

  it('returns the IPC error envelope verbatim on failure', async () => {
    installFiloStub({
      'vault:create-folder': () => ({
        success: false,
        code: 'EACCES',
        error: 'Error: EACCES: permission denied',
      }),
    });
    const result = await vaultStore.createFolder('/vault', 'Locked');
    expect(result.success).toBe(false);
    expect(result.code).toBe('EACCES');
    expect(result.error).toContain('EACCES');
  });

  it('does NOT refresh the tree on a failed create', async () => {
    let readTreeCalls = 0;
    installFiloStub({
      'vault:create-folder': () => ({ success: false, code: 'EEXIST', error: 'exists' }),
      'vault:read-tree': () => {
        readTreeCalls += 1;
        return { ok: true, tree: [] };
      },
    });
    await vaultStore.createFolder('/vault', 'Existing');
    expect(readTreeCalls).toBe(0);
  });
});

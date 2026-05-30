import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * M3 (AUDIT_REMEDIATION_PLAN_2026-05-29) — `vault:watch` must NOT self-register
 * an arbitrary directory. It requires the open-vault handshake
 * (`vault:init-config`, the single registration authority) to have already
 * made the path the active vault, and asserts the path matches via
 * `assertActiveVault`. Previously, calling it with no vault open self-registered
 * any stat-able directory, letting a buggy / compromised renderer anchor the
 * active vault at an arbitrary host directory (`~/.ssh`, …).
 *
 * Exercises the registered handler directly with electron mocked, mirroring
 * `vaultReconcileThrottle.test.ts`.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
  },
}));

const { registerVaultHandlers, stopActiveWatcher } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

type WatchResult = { success: boolean; code?: string; error?: string };

describe('vault:watch — requires the open-vault handshake (M3)', () => {
  let watchHandler: (...args: unknown[]) => Promise<WatchResult>;
  let vaultDir: string;
  let otherDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerVaultHandlers();
    const w = handlers.get('vault:watch');
    if (!w) throw new Error('vault:watch handler not registered');
    watchHandler = w as (...args: unknown[]) => Promise<WatchResult>;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-watch-active-'));
    otherDir = await fs.mkdtemp(join(tmpdir(), 'filo-watch-other-'));
    vaultRegistry.setCurrentVault(null);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await stopActiveWatcher();
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(otherDir, { recursive: true, force: true });
  });

  it('rejects watching a directory when no vault is open', async () => {
    const res = await watchHandler({}, vaultDir);
    expect(res.success).toBe(false);
    expect(res.code).toBe('NO_ACTIVE_VAULT');
    // No vault was self-registered off the back of the watch call.
    expect(vaultRegistry.currentVaultPath).toBeNull();
  });

  it('rejects watching a directory that is not the active vault', async () => {
    vaultRegistry.setCurrentVault(vaultDir);
    const res = await watchHandler({}, otherDir);
    expect(res.success).toBe(false);
    expect(res.code).toBe('NO_ACTIVE_VAULT');
  });

  it('watches the active vault once the handshake has registered it', async () => {
    // Simulates `vault:init-config` having registered the vault first.
    vaultRegistry.setCurrentVault(vaultDir);
    const res = await watchHandler({}, vaultDir);
    expect(res.success).toBe(true);
  });
});

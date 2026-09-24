import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Audit 5.8 — `vault:init-config` arms the main-process registry
 * (`vaultRegistry.setCurrentVault(vaultRoot)`) BEFORE awaiting
 * `initVaultConfig`. If init throws (EACCES on a read-only mount, ENOSPC, a
 * flaky network share), the handler must ROLL the registry BACK; otherwise a
 * half-initialised vault stays armed and the "a different vault is already
 * active" guard blocks a clean re-open of any other vault until the user
 * closes — while the renderer believes the open simply failed.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
}));

// initVaultConfig throws — simulate a `.filo/` init failure AFTER the registry
// was armed. All other configOps exports stay real so board.ipc's imports resolve.
vi.mock('../../main/vault/configOps', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../main/vault/configOps');
  return {
    ...actual,
    initVaultConfig: vi.fn(async () => {
      throw new Error('EACCES: cannot create .filo/');
    }),
  };
});

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('vault:init-config — registry rollback on init failure (audit 5.8)', () => {
  let vaultDir: string;
  let initHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerBoardHandlers();
    const h = handlers.get('vault:init-config');
    if (!h) throw new Error('vault:init-config handler not registered');
    initHandler = h;
  });

  beforeEach(async () => {
    // The registry stores the canonical path, and on Windows tmpdir() can be a
    // short 8.3 name (`RUNNER~1` on the CI runner), so compare against the
    // resolved one.
    vaultDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'filo-init-rollback-')));
    vaultRegistry.setCurrentVault(null);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('rolls the registry back when initVaultConfig throws (nothing armed before)', async () => {
    expect(vaultRegistry.currentVaultPath).toBeNull();
    const result = (await initHandler({}, vaultDir)) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    // The half-initialised vault must NOT stay armed — a clean re-open of any
    // other vault must not be blocked by a phantom active vault.
    expect(vaultRegistry.currentVaultPath).toBeNull();
  });

  it('leaves a genuinely-active vault armed when a same-vault re-init throws', async () => {
    // The vault was already active; a failed re-init must not clear it.
    vaultRegistry.setCurrentVault(vaultDir);
    const result = (await initHandler({}, vaultDir)) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(vaultRegistry.currentVaultPath).toBe(vaultDir);
  });
});

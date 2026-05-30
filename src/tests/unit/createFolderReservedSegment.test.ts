import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Polish phase 1.3 — `vault:create-folder` now runs the relative form of
 * the supplied path through `assertSafeRelativePath`, which validates
 * every segment with `assertSafeFilename`. Without this guard, a renderer
 * (or future caller) could request `foo/CON/bar` and successfully
 * create directories that subsequent writes can't open on Windows.
 *
 * Mirrors the per-segment guard in `vault:rename`'s
 * `assertSafeFilename(basename(newPath))` and the existing test
 * `vault:create-folder → .filo/subdir` in `vaultIpcFiloGuard.test.ts`,
 * extending it to Windows reserved names anywhere along the new path.
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

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('vault:create-folder — per-segment reserved-name guard (polish 1.3)', () => {
  let vaultDir: string;
  let createFolderHandler: (...args: unknown[]) => Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerVaultHandlers();
    const h = handlers.get('vault:create-folder');
    if (!h) throw new Error('vault:create-folder handler not registered');
    createFolderHandler = h as (...args: unknown[]) => Promise<unknown>;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-create-folder-guard-'));
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('rejects an interior segment matching a Windows reserved name', async () => {
    const result = (await createFolderHandler(
      {},
      vaultDir,
      join(vaultDir, 'foo', 'CON', 'bar'),
    )) as { success: boolean; code?: string; error?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_FILENAME');
    expect(result.error).toMatch(/CON/);
    // The folder must NOT exist on disk.
    await expect(fs.access(join(vaultDir, 'foo'))).rejects.toBeDefined();
  });

  it('rejects the leaf segment matching a Windows reserved name', async () => {
    const result = (await createFolderHandler(
      {},
      vaultDir,
      join(vaultDir, 'docs', 'AUX'),
    )) as { success: boolean; code?: string; error?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_FILENAME');
    expect(result.error).toMatch(/AUX/);
  });

  it('rejects a segment containing a control character', async () => {
    const dirty = `bad${String.fromCharCode(0x07)}name`;
    const result = (await createFolderHandler(
      {},
      vaultDir,
      join(vaultDir, dirty),
    )) as { success: boolean; code?: string; error?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_FILENAME');
  });

  it('happy path: a normal nested folder still creates successfully', async () => {
    const result = (await createFolderHandler(
      {},
      vaultDir,
      join(vaultDir, 'projects', 'alpha'),
    )) as { success: boolean };
    expect(result.success).toBe(true);
    const stat = await fs.stat(join(vaultDir, 'projects', 'alpha'));
    expect(stat.isDirectory()).toBe(true);
  });
});

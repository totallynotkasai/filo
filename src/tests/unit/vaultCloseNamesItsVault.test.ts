/**
 * `vault:close` names the vault it means to release, and main releases only
 * that one. A close from a failed open, meant for the vault that open tried,
 * must not release the registry another open has armed meanwhile: every gated
 * write to the open vault would then be refused.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => '' },
}));

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('vault:close', () => {
  let open: string;
  let other: string;
  let close: (root: string) => Promise<unknown>;

  beforeAll(() => {
    registerVaultHandlers();
    const h = handlers.get('vault:close');
    if (!h) throw new Error('vault:close not registered');
    close = async (root) => h({}, root);
  });

  beforeEach(async () => {
    open = await fs.mkdtemp(join(tmpdir(), 'filo-close-open-'));
    other = await fs.mkdtemp(join(tmpdir(), 'filo-close-other-'));
    vaultRegistry.setCurrentVault(open);
  });

  afterEach(async () => {
    vaultRegistry.setCurrentVault(null);
    await fs.rm(open, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  });

  it('a close naming another vault leaves the open vault registered', async () => {
    const before = vaultRegistry.currentVaultPath;
    expect(await close(other)).toMatchObject({ success: true, released: false });
    expect(vaultRegistry.currentVaultPath).toBe(before);
  });

  it('a close naming the open vault releases it', async () => {
    expect(await close(open)).toMatchObject({ success: true });
    expect(vaultRegistry.currentVaultPath).toBeNull();
  });

  it('on Windows the name is compared case-folded', async () => {
    if (process.platform !== 'win32') return;
    expect(await close(open.toUpperCase())).toMatchObject({ success: true });
    expect(vaultRegistry.currentVaultPath).toBeNull();
  });

  it('with nothing open it is a no-op success', async () => {
    vaultRegistry.setCurrentVault(null);
    expect(await close(other)).toMatchObject({ success: true });
  });
});

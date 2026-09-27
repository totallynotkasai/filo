import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * A vault's colour is copied into `recent-vaults.json`, so Home can show it
 * before the vault opens. Runs the real `vault:add-recent` handler over a
 * temp userData folder.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => userDataDir,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
  },
  shell: {
    openExternal: async () => undefined,
    openPath: async () => '',
    showItemInFolder: () => undefined,
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
}));

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');

type Recent = { path: string; name: string; color?: string; pinned?: boolean };
type AddRecentEnvelope = { ok: true; recents: Recent[] } | { ok: false; code?: string };

describe('recent-vaults colour', () => {
  let add: (...args: unknown[]) => unknown | Promise<unknown>;
  let list: (...args: unknown[]) => unknown | Promise<unknown>;
  let pin: (...args: unknown[]) => unknown | Promise<unknown>;
  let vault: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'filo-recents-color-'));
    vault = await fs.mkdtemp(join(tmpdir(), 'filo-recents-color-vault-'));
    handlers.clear();
    registerVaultHandlers();
    add = handlers.get('vault:add-recent') as typeof add;
    list = handlers.get('vault:list-recents') as typeof list;
    pin = handlers.get('vault:pin-recent') as typeof pin;
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
    await fs.rm(vault, { recursive: true, force: true });
  });

  async function stored(): Promise<Recent | undefined> {
    const recents = (await list({})) as Recent[];
    return recents.find((r) => r.path === vault);
  }

  it('saves the colour and reads it back after a restart', async () => {
    const result = (await add({}, vault, 'Work', '#1A73E8')) as AddRecentEnvelope;
    expect(result.ok).toBe(true);
    const onDisk = JSON.parse(await fs.readFile(join(userDataDir, 'recent-vaults.json'), 'utf8')) as { vaults: Recent[] };
    expect(onDisk.vaults[0].color).toBe('#1a73e8');
    expect((await stored())?.color).toBe('#1a73e8');
  });

  it('keeps the colour when an add leaves it out, and keeps the pin when the colour changes', async () => {
    await add({}, vault, 'Work', '#43a047');
    await pin({}, vault, true);
    await add({}, vault, 'Work');
    expect((await stored())?.color).toBe('#43a047');

    await add({}, vault, 'Work renamed', '#fb8c00');
    const entry = await stored();
    expect(entry?.color).toBe('#fb8c00');
    expect(entry?.name).toBe('Work renamed');
    expect(entry?.pinned).toBe(true);
  });

  it('an empty colour clears it, and a bad one is stored as none', async () => {
    await add({}, vault, 'Work', '#43a047');
    await add({}, vault, 'Work', '');
    expect((await stored())?.color).toBeUndefined();

    await add({}, vault, 'Work', 'url(javascript:1)');
    expect((await stored())?.color).toBeUndefined();
  });

  it('refuses a colour that is not a string', async () => {
    const result = (await add({}, vault, 'Work', 42)) as AddRecentEnvelope;
    expect(result.ok).toBe(false);
  });
});

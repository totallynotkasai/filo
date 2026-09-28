/**
 * `board:save` and `board:create` tell the watcher the bytes they left on
 * disk. Its cached size and hash otherwise describe the file from before the
 * write, so another program renaming the board (or its folder) straight after
 * a save isn't paired as a rename: the board looked deleted and its new file
 * like a copy with the same id.
 *
 * Also: `vault:init-config` tells a folder that is gone from a drive that
 * can't be reached, so Home keeps the recent entry for an unplugged drive.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
const recorded: Array<{ path: string; bytes: Buffer }> = [];

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
  getActiveWatcher: () => ({
    suppress: () => {},
    suppressWrite: () => {},
    recordOwnWrite: (path: string, bytes: Buffer) => recorded.push({ path, bytes }),
  }),
}));

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} not registered`);
  return async (...args) => h({}, ...args);
}

describe('board writes record their own bytes with the watcher', () => {
  let vaultDir: string;

  beforeAll(() => registerBoardHandlers());

  beforeEach(async () => {
    recorded.length = 0;
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-board-own-bytes-'));
    vaultRegistry.setCurrentVault(vaultDir);
  });

  afterEach(async () => {
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('board:save records exactly the bytes now on disk', async () => {
    const payload = JSON.stringify({ version: 8, board: { id: 'b1', name: 'Plan' } }, null, 2);
    const res = (await handler('board:save')(vaultDir, 'Plan.board.json', payload)) as { ok: boolean };
    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(join(vaultDir, 'Plan.board.json'));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.path).toBe('Plan.board.json');
    expect(recorded[0]?.bytes.equals(onDisk)).toBe(true);
  });

  it('board:create records exactly the bytes now on disk', async () => {
    const res = (await handler('board:create')(vaultDir, 'Plan', { version: 8 }, undefined)) as { ok: boolean; path: string };
    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(join(vaultDir, 'Plan.board.json'));
    expect(recorded.map((r) => r.path)).toEqual(['Plan.board.json']);
    expect(recorded[0]?.bytes.equals(onDisk)).toBe(true);
  });

  it('a refused save records nothing', async () => {
    const res = (await handler('board:save')(vaultDir, 'Plan.board.json', 'not json')) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe('vault:init-config on a folder that is gone', () => {
  afterEach(() => vaultRegistry.setCurrentVault(null));

  it('a missing folder on a reachable drive: ENOENT', async () => {
    const missing = join(tmpdir(), `filo-no-such-vault-${Date.now()}`);
    const res = (await handler('vault:init-config')(missing)) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('ENOENT');
  });

  it.runIf(process.platform === 'win32')('a folder on a drive that is not there: ENODEV', async () => {
    // Find a drive letter with nothing mounted on it.
    let letter = '';
    for (const c of 'QRSTUVWXYZ') {
      if (!(await fs.stat(`${c}:\\`).then(() => true, () => false))) { letter = c; break; }
    }
    if (!letter) return;
    const res = (await handler('vault:init-config')(`${letter}:\\Vault`)) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('ENODEV');
  });

  it('a file, not a folder: ENOTDIR', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'filo-init-file-'));
    const file = join(dir, 'note.md');
    await fs.writeFile(file, 'x');
    try {
      const res = (await handler('vault:init-config')(file)) as { ok: boolean; code?: string };
      expect(res.ok).toBe(false);
      expect(res.code).toBe('ENOTDIR');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

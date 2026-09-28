/**
 * `board:create` returns the new board's vault-relative path, which the
 * renderer keeps as the board's path for every later save. The vault root
 * can arrive spelled differently from the path `createBoardFile` builds
 * (forward slashes, a trailing separator, another drive-letter case): the
 * returned path must still be relative, or every `board:save` of the new
 * board is refused as an unsafe path and the board is never saved.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
  getActiveWatcher: () => ({ suppress: () => {}, suppressWrite: () => {}, recordOwnWrite: () => {} }),
}));

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

interface CreateResult { ok: boolean; path: string }

describe('board:create returns a vault-relative path for any spelling of the vault root', () => {
  let vaultDir: string;

  beforeAll(() => registerBoardHandlers());

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-board-create-rel-'));
    vaultRegistry.setCurrentVault(vaultDir);
  });

  afterEach(async () => {
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  async function create(root: string, name: string, subfolder?: string): Promise<CreateResult> {
    const handler = handlers.get('board:create');
    if (!handler) throw new Error('board:create handler not registered');
    return (await handler({}, root, name, { version: 8 }, subfolder)) as CreateResult;
  }

  const spellings: Array<[string, (dir: string) => string]> = [
    ['as given', (dir) => dir],
    ['with forward slashes', (dir) => dir.replace(/\\/g, '/')],
    ['with a trailing separator', (dir) => `${dir.replace(/\\/g, '/')}/`],
  ];
  if (process.platform === 'win32') {
    spellings.push(['with the other drive-letter case', (dir) =>
      dir.replace(/^[A-Za-z]/, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))]);
  }

  for (const [label, spell] of spellings) {
    it(`root ${label}`, async () => {
      const res = await create(spell(vaultDir), 'Plan');
      expect(res.ok).toBe(true);
      expect(res.path).toBe('Plan.board.json');
    });

    it(`root ${label}, into a subfolder`, async () => {
      await fs.mkdir(join(vaultDir, 'Boards'));
      const res = await create(spell(vaultDir), 'Plan', 'Boards');
      expect(res.ok).toBe(true);
      expect(res.path).toBe('Boards/Plan.board.json');
    });
  }
});

/**
 * Creating a board is Filo's own write. Main hides its watcher echo and
 * returns the new file's stat; the renderer marks the path as a recent self
 * write and seeds the drift baseline from that stat. Without them, an edit
 * made within a second or two of creating the board asks "modified
 * externally" when the create's echo arrives.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
const suppressed: Array<{ path: string; ms: number }> = [];

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
    suppress: (path: string, ms: number) => suppressed.push({ path, ms }),
    recordOwnWrite: () => {},
  }),
}));

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { boardCacheStore } = await import('@renderer/stores/boardCache.svelte');
const { vaultStore } = await import('@renderer/stores/vault.svelte');
const { getBaseline, __resetBaselinesForTests } = await import('@renderer/lib/vault/fileBaselineRegistry');
const { isRecentSelfWrite } = await import('@renderer/lib/boards/boardSaver');
const { installFiloMock, restoreFiloDefault } = await import('../helpers/filoBridge');

describe('board:create (main)', () => {
  let vaultDir: string;

  beforeAll(() => registerBoardHandlers());

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-board-create-stat-'));
    vaultRegistry.setCurrentVault(vaultDir);
    suppressed.length = 0;
  });

  afterEach(async () => {
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('hides the new file from the watcher and returns its stat', async () => {
    const create = handlers.get('board:create');
    if (!create) throw new Error('board:create handler not registered');
    const res = (await create({}, vaultDir, 'Plan', { version: 8 })) as {
      ok: boolean;
      path: string;
      mtimeMs?: number;
      size?: number;
    };
    expect(res.ok).toBe(true);
    expect(res.path).toBe('Plan.board.json');
    const stat = await fs.stat(join(vaultDir, 'Plan.board.json'));
    expect(res.mtimeMs).toBe(stat.mtimeMs);
    expect(res.size).toBe(stat.size);
    expect(suppressed.map((s) => s.path)).toEqual(['Plan.board.json']);
  });
});

describe('persistNewBoard (renderer)', () => {
  beforeEach(() => {
    __resetBaselinesForTests();
    boardCacheStore.clear();
    vaultStore.setPath('/vault');
  });

  afterEach(() => {
    restoreFiloDefault();
    boardCacheStore.clear();
    vaultStore.setPath('');
    __resetBaselinesForTests();
  });

  it('seeds the drift baseline from the create stat and marks the echo as its own', async () => {
    installFiloMock({
      'board:create': () => ({ ok: true, path: 'Kanban 1.board.json', mtimeMs: 1234.5, size: 321 }),
    });
    const board = await boardCacheStore.createBoard('Kanban 1', 'kanban');
    expect(board).not.toBeNull();
    expect(getBaseline('Kanban 1.board.json')).toEqual({ mtimeMs: 1234.5, size: 321 });
    expect(isRecentSelfWrite('Kanban 1.board.json')).toBe(true);
  });

  it('with no stat from main, leaves the baseline unset (the first save runs unchecked)', async () => {
    installFiloMock({
      'board:create': () => ({ ok: true, path: 'Kanban 2.board.json' }),
    });
    await boardCacheStore.createBoard('Kanban 2', 'kanban');
    expect(getBaseline('Kanban 2.board.json')).toBeUndefined();
    expect(isRecentSelfWrite('Kanban 2.board.json')).toBe(true);
  });
});

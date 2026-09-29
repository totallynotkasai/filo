/**
 * Creating a board is Filo's own write. Main hides its watcher echo and
 * returns the new file's stat; the renderer marks the path as a recent self
 * write and seeds the drift baseline from that stat. Without them, an edit
 * made within a second or two of creating the board asks "modified
 * externally" when the create's echo arrives.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
const suppressed: Array<{ path: string; ms: number }> = [];
/** Each own-bytes window board:create opens, and whether the file existed yet. */
const ownWrites: Array<{ path: string; content: string | undefined; fileExisted: boolean }> = [];
let watchedVault = '';

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
    suppressWrite: (path: string, _ms: number, content?: string) => {
      ownWrites.push({ path, content, fileExisted: existsSync(join(watchedVault, path)) });
    },
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
    watchedVault = vaultDir;
    suppressed.length = 0;
    ownWrites.length = 0;
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
    // Hidden only while it holds the bytes written: never a plain, time-only suppress.
    expect(suppressed).toEqual([]);
    const onDisk = await fs.readFile(join(vaultDir, 'Plan.board.json'), 'utf8');
    expect(ownWrites.filter((w) => w.fileExisted).map((w) => [w.path, w.content])).toEqual([['Plan.board.json', onDisk]]);
  });

  // The create reserves an empty placeholder, then writes the JSON over it. A
  // slow disk lets the watcher's debounce fire in between, and the renderer
  // then read the empty file as a broken board ("Unexpected end of JSON
  // input"). The echo is hidden before anything lands, for just those two
  // contents, so another program's file at the name still gets through.
  it('hides the placeholder and the JSON before the file exists, in a subfolder too', async () => {
    const create = handlers.get('board:create');
    if (!create) throw new Error('board:create handler not registered');
    const data = { version: 8 };
    const res = (await create({}, vaultDir, 'Plan', data, 'Boards')) as { ok: boolean; path: string };
    expect(res.ok).toBe(true);
    const before = ownWrites.filter((w) => !w.fileExisted);
    expect(before.map((w) => w.path)).toEqual(['Boards/Plan.board.json', 'Boards/Plan.board.json']);
    const onDisk = await fs.readFile(join(vaultDir, 'Boards', 'Plan.board.json'), 'utf8');
    expect(before.map((w) => w.content)).toEqual(['', onDisk]);
  });
});

describe('the pre-create window (watcher suppression)', () => {
  it('drops events while the file is empty or holds the new board, not for other bytes', async () => {
    const { SuppressionWindows, ownBytesOf } = await import('../../main/services/watcherSuppression');
    const json = '{\n  "version": 8\n}';
    const w = new SuppressionWindows();
    w.suppressWrite('Plan.board.json', 5000, '');
    w.suppressWrite('Plan.board.json', 5000, json);
    const holding = (text: string) => () => {
      const own = ownBytesOf(text);
      return { size: own.size, sha1: () => own.sha1 };
    };
    expect(w.isSuppressed('Plan.board.json', true, holding(''))).toBe(true);
    expect(w.isSuppressed('Plan.board.json', true, holding(json))).toBe(true);
    expect(w.isSuppressed('Plan.board.json', true, holding('{"version":8,"board":{"id":"theirs"}}'))).toBe(false);
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

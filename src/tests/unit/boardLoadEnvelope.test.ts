import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * `board:load` returned `null` for EVERY failure and the renderer read `null`
 * as "not-found": a board OneDrive held locked for a moment (or an online-only
 * placeholder while offline) looked deleted for the whole session. The handler
 * now retries a transient lock briefly and returns an envelope with a typed
 * failure code.
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
vi.mock('../../main/ipc/vault.ipc', () => ({ getActiveWatcher: () => null }));

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('board:load envelope + lock retry', () => {
  let vaultDir: string;
  let load: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const board = { board: { id: 'b1', name: 'Plan' }, tileDefs: {}, connections: {}, frames: [] };

  beforeAll(() => {
    registerBoardHandlers();
    load = handlers.get('board:load')!;
  });
  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-board-load-'));
    vaultRegistry.setCurrentVault(vaultDir);
    await fs.writeFile(join(vaultDir, 'Plan.board.json'), JSON.stringify(board));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('success → { success: true, data }', async () => {
    const res = await load({}, vaultDir, 'Plan.board.json');
    expect(res).toEqual({ success: true, data: board });
  });

  it('EBUSY ×2 then OK → success (bite: was null → "not-found")', async () => {
    const real = fs.readFile.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      calls++;
      if (calls <= 2) throw errno('EBUSY');
      return real(...args);
    }) as typeof fs.readFile);
    const res = await load({}, vaultDir, 'Plan.board.json');
    expect(res).toEqual({ success: true, data: board });
    expect(calls).toBe(3);
  });

  it('a persistent lock → code LOCKED', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(errno('EPERM'));
    const res = (await load({}, vaultDir, 'Plan.board.json')) as { success: boolean; code?: string };
    expect(res.success).toBe(false);
    expect(res.code).toBe('LOCKED');
  });

  it('EIO (offline cloud placeholder) → code OFFLINE', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(errno('EIO'));
    const res = (await load({}, vaultDir, 'Plan.board.json')) as { code?: string };
    expect(res.code).toBe('OFFLINE');
  });

  it('missing file → ENOENT; malformed JSON → PARSE', async () => {
    expect(((await load({}, vaultDir, 'Gone.board.json')) as { code?: string }).code).toBe('ENOENT');
    await fs.writeFile(join(vaultDir, 'Bad.board.json'), '{ not json');
    expect(((await load({}, vaultDir, 'Bad.board.json')) as { code?: string }).code).toBe('PARSE');
  });

  it('oversize → code TOO_LARGE', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 60 * 1024 * 1024 } as Awaited<ReturnType<typeof fs.stat>>);
    const res = (await load({}, vaultDir, 'Plan.board.json')) as { code?: string };
    expect(res.code).toBe('TOO_LARGE');
  });
});

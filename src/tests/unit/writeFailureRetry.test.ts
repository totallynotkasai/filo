import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * A board, config or tags write that fails in main must come back with a code,
 * so the renderer's schedulers keep it and Retry (the toast's, the popover's,
 * the quit dialog's) actually writes it again. Driven through the real
 * handlers: only the file write underneath them fails.
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

/** The next saves of these kinds fail with this error; null writes for real. */
const failNext: { board: Error | null; config: Error | null; tags: Error | null } = { board: null, config: null, tags: null };

vi.mock('../../main/vault/boardFileOps', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../main/vault/boardFileOps')>();
  return {
    ...real,
    saveBoardFile: async (filePath: string, data: unknown) => {
      if (failNext.board) throw failNext.board;
      return real.saveBoardFile(filePath, data);
    },
  };
});
vi.mock('../../main/vault/configOps', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../main/vault/configOps')>();
  return {
    ...real,
    saveConfig: async (...args: Parameters<typeof real.saveConfig>) => {
      if (failNext.config) throw failNext.config;
      return real.saveConfig(...args);
    },
    saveWorkspaceConfig: async (...args: Parameters<typeof real.saveWorkspaceConfig>) => {
      if (failNext.config) throw failNext.config;
      return real.saveWorkspaceConfig(...args);
    },
  };
});
vi.mock('../../main/vault/filenameUtils', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../main/vault/filenameUtils')>();
  return {
    ...real,
    atomicWriteFile: async (...args: Parameters<typeof real.atomicWriteFile>) => {
      if (failNext.tags && String(args[0]).endsWith('tags.json')) throw failNext.tags;
      return real.atomicWriteFile(...args);
    },
  };
});

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { registerTagsHandlers } = await import('../../main/ipc/tags.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { scheduleBoardWrite } = await import('@renderer/lib/boards/boardWriteScheduler');
const { scheduleConfigWrite } = await import('@renderer/lib/boards/configWriteScheduler');
const { unsavedWork, __resetDirtyTrackingForTests } = await import('@renderer/lib/boards/writeStateTracking');
const { retryAllFailedWrites, isRetainableWriteError } = await import('@renderer/lib/boards/writeSchedulerFailures');
const { __resetBaselinesForTests } = await import('@renderer/lib/vault/fileBaselineRegistry');
const { installFiloMock, restoreFiloDefault } = await import('../helpers/filoBridge');

function errno(code: string | undefined): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code ?? 'no code'}: simulated`), code ? { code } : {});
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out: ${what}`);
}

describe('failed writes carry a code and are retried', () => {
  let vaultDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerBoardHandlers();
    registerTagsHandlers();
  });
  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-write-retry-'));
    await fs.mkdir(join(vaultDir, '.filo'), { recursive: true });
    vaultRegistry.setCurrentVault(vaultDir);
    failNext.board = failNext.config = failNext.tags = null;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    // The renderer talks to the real handlers.
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) {
        if (channel === 'vault:stat') return { ok: false, code: 'ENOENT', error: 'not stubbed' };
        return undefined;
      }
      return handler({}, ...args);
    });
  });
  afterEach(async () => {
    errSpy.mockRestore();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    restoreFiloDefault();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('every write handler answers a failure with a code', async () => {
    failNext.board = errno('EBUSY');
    failNext.config = errno(undefined);
    failNext.tags = errno('EPERM');
    const board = await handlers.get('board:save')!({}, vaultDir, 'Plan.board.json', '{}');
    const config = await handlers.get('config:save')!({}, vaultDir, 'app.json', '{}');
    const workspace = await handlers.get('config:save-workspace')!({}, vaultDir, '{}');
    const tags = await handlers.get('tags:save')!({}, vaultDir, '{}');
    expect(board).toMatchObject({ ok: false, code: 'EBUSY' });
    expect(config).toMatchObject({ ok: false, code: 'IO_ERROR' });
    expect(workspace).toMatchObject({ ok: false, code: 'IO_ERROR' });
    expect(tags).toMatchObject({ ok: false, code: 'EPERM' });
  });

  it('a board save that fails on a lock is kept, and Retry writes it and clears the failure', async () => {
    failNext.board = errno('EBUSY');
    const cached = { version: 8, board: { id: 'b1', name: 'Plan' }, tileDefs: {}, connections: {}, frames: [] };
    scheduleBoardWrite('b1', () => ({ vaultRoot: vaultDir, boardPath: 'Plan.board.json', cached: cached as never }));
    await waitFor(() => unsavedWork().failed.length === 1, 'the board save to fail');
    await expect(fs.stat(join(vaultDir, 'Plan.board.json'))).rejects.toThrow();

    failNext.board = null;
    const { failed } = await retryAllFailedWrites();
    expect(failed).toEqual([]);
    expect(JSON.parse(await fs.readFile(join(vaultDir, 'Plan.board.json'), 'utf8'))).toMatchObject({ board: { id: 'b1' } });
    expect(unsavedWork().failed).toEqual([]);
  });

  it('a config save that fails with an unnamed IO error is kept, and Retry writes it', async () => {
    failNext.config = errno(undefined);
    const settings = { general: { globalFont: 'Retry Sans' }, mindmap: {}, kanban: {}, tasklist: {}, document: {} };
    scheduleConfigWrite(() => ({
      vaultRoot: vaultDir,
      settings: settings as never,
      theme: 'light',
      workspace: { openTabs: [], activeTabId: '' },
      layout: { paneTree: null, activePaneId: null, boardToolbars: {}, mindMapPanels: {}, spellcheck: true },
    }));
    await waitFor(() => unsavedWork().failed.length === 1, 'the config save to fail');

    failNext.config = null;
    const { failed } = await retryAllFailedWrites();
    expect(failed).toEqual([]);
    const app = JSON.parse(await fs.readFile(join(vaultDir, '.filo', 'app.json'), 'utf8')) as { globalFont?: string };
    expect(app.globalFont).toBe('Retry Sans');
    expect(unsavedWork().failed).toEqual([]);
  });

  it('IO_ERROR is kept only for schedulers whose payload is a whole snapshot', () => {
    const io = errno('IO_ERROR');
    expect(isRetainableWriteError(io, true)).toBe(true);
    expect(isRetainableWriteError(io)).toBe(false);
    expect(isRetainableWriteError(errno('EXTERNAL_EDIT'), true)).toBe(false);
  });
});

/**
 * A board write hides only its own watcher echo. `board:save` and
 * `board:create` suppress with the bytes they write, so inside the (lock-aware,
 * several-second) window the event for a file holding Filo's bytes is dropped,
 * while another program's save of the board is reported at once.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SuppressionWindows, ownBytesOf, type FileProbe } from '../../main/services/watcherSuppression';
import { sha1Hex } from '../../main/services/fileWatcherHash';

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
const windows = new SuppressionWindows();

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

// The watcher's suppression, as the real FileWatcher wires it.
vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => ({
    suppress: (path: string, ms: number) => windows.suppress(path, ms),
    suppressWrite: (path: string, ms: number, content?: string | Buffer) => windows.suppressWrite(path, ms, content),
    recordOwnWrite: (path: string, bytes: Buffer) => windows.recordLandedBytes(path, ownBytesOf(bytes)),
  }),
}));

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} not registered`);
  return async (...args) => h({}, ...args);
}

describe('board writes hide only their own echo', () => {
  let vaultDir: string;
  let probe: FileProbe;
  const REL = 'Plan.board.json';

  beforeAll(() => registerBoardHandlers());

  beforeEach(async () => {
    windows.clear();
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-board-echo-'));
    vaultRegistry.setCurrentVault(vaultDir);
    probe = (rel) => {
      const abs = join(vaultDir, rel);
      try {
        return { size: statSync(abs).size, sha1: () => sha1Hex(readFileSync(abs)) };
      } catch {
        return null;
      }
    };
  });

  afterEach(async () => {
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('board:save: its own echo is dropped, another program\'s save inside the window is reported', async () => {
    const payload = JSON.stringify({ version: 8, board: { id: 'b1', name: 'Plan' } }, null, 2);
    const res = (await handler('board:save')(vaultDir, REL, payload)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(windows.isSuppressed(REL, true, probe)).toBe(true);

    await fs.writeFile(join(vaultDir, REL), JSON.stringify({ version: 9, board: { id: 'b1' } }, null, 2));
    expect(windows.isSuppressed(REL, true, probe)).toBe(false);
  });

  it('board:create: the same', async () => {
    const res = (await handler('board:create')(vaultDir, 'Plan', { version: 8 }, undefined)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(windows.isSuppressed(REL, true, probe)).toBe(true);

    await fs.writeFile(join(vaultDir, REL), '{ "version": 9 }');
    expect(windows.isSuppressed(REL, true, probe)).toBe(false);
  });
});

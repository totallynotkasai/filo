/**
 * `config:load` must never answer an unreadable file with `{}`: the renderer
 * reads `{}` as "file absent". For hotkeys that installed EMPTY overrides, and
 * the next rebind wrote a one-entry hotkeys.json over every other binding.
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
  getActiveWatcher: () => null,
}));

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const {
  loadHotkeyOverrides,
  getHotkeyOverrides,
  setHotkeyOverrides,
  setHotkeyOverride,
  saveHotkeyOverrides,
  _resetForTests,
} = await import('@renderer/core/hotkeys');
const { isConfigPathCorrupt } = await import('@renderer/lib/boards/configWriteScheduler');
const { __resetDirtyTrackingForTests } = await import('@renderer/lib/boards/boardSaver');
const { flushAllMisc } = await import('@renderer/lib/boards/miscWriteScheduler');
const { hasFailedWrites, retryAllFailedWrites } = await import('@renderer/lib/boards/writeStateTracking');
const { vaultStore } = await import('@renderer/stores/vault.svelte');
const { installFiloMock, restoreFiloDefault } = await import('../helpers/filoBridge');

describe('config:load handler — unreadable file', () => {
  let vaultDir: string;
  let load: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerBoardHandlers();
    const h = handlers.get('config:load');
    if (!h) throw new Error('config:load handler not registered');
    load = h;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-config-load-'));
    await fs.mkdir(join(vaultDir, '.filo'));
    await fs.writeFile(join(vaultDir, '.filo', 'hotkeys.json'), '{"tile:add":"Ctrl+Shift+A"}');
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('a readable file loads normally', async () => {
    expect(await load({}, vaultDir, 'hotkeys.json')).toEqual({ 'tile:add': 'Ctrl+Shift+A' });
  });

  it('an absent file is still {}', async () => {
    expect(await load({}, vaultDir, 'viewports.json')).toEqual({});
  });

  it('an EBUSY stat returns { __loadFailed }, never {}', async () => {
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }));
    const res = await load({}, vaultDir, 'hotkeys.json');
    expect(res).toMatchObject({ __loadFailed: true });
    expect(res).not.toEqual({});
  });

  it('an inactive vault returns { __loadFailed }', async () => {
    vaultRegistry.setCurrentVault(null);
    expect(await load({}, vaultDir, 'hotkeys.json')).toMatchObject({ __loadFailed: true });
  });
});

describe('loadHotkeyOverrides — a failed read keeps overrides and stops hotkey writes', () => {
  const VAULT = '/vault';
  const noSleep = async (): Promise<void> => {};
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath(VAULT);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    restoreFiloDefault();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
  });

  it('retries a transient failure and applies the file once it reads', async () => {
    let calls = 0;
    installFiloMock((channel: string) => {
      if (channel !== 'config:load') return null;
      calls++;
      return calls < 3 ? { __loadFailed: true, error: 'EBUSY' } : { 'tile:add': 'Ctrl+Shift+A' };
    });
    await loadHotkeyOverrides(VAULT, noSleep);
    expect(calls).toBe(3);
    expect(Object.keys(getHotkeyOverrides())).toEqual(['tile:add']);
    expect(isConfigPathCorrupt('.filo/hotkeys.json')).toBe(false);
  });

  it('still locked after the retries → overrides untouched, and not marked corrupt (a lock passes)', async () => {
    setHotkeyOverrides({ 'tile:add': { key: 'a', ctrl: true, shift: true } });
    let calls = 0;
    installFiloMock((channel: string) => {
      if (channel !== 'config:load') return null;
      calls++;
      return { __loadFailed: true, error: 'EBUSY' };
    });
    await loadHotkeyOverrides(VAULT, noSleep);
    expect(calls).toBe(4);
    expect(Object.keys(getHotkeyOverrides())).toEqual(['tile:add']);
    // The next rebind reads the file again before it writes (below).
    expect(isConfigPathCorrupt('.filo/hotkeys.json')).toBe(false);
  });

  it('a rebind after a locked load reads the file first: kept for Retry while locked, then merged over what it holds', async () => {
    let locked = true;
    const saved: unknown[] = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'config:load') return locked ? { __loadFailed: true, error: 'EBUSY' } : { 'tile:add': 'Ctrl+Shift+A', 'tile:lock': 'Ctrl+L' };
      if (channel === 'config:save') {
        saved.push(args[2]);
        return { ok: true };
      }
      return null;
    });
    await loadHotkeyOverrides(VAULT, noSleep);
    setHotkeyOverride('tile:delete', { key: 'd', ctrl: true });
    saveHotkeyOverrides(VAULT);
    expect((await flushAllMisc()).failed).toEqual(['.filo/hotkeys.json']);
    expect(saved).toEqual([]);

    locked = false;
    expect((await retryAllFailedWrites()).failed).toEqual([]);
    expect(saved.map((p) => JSON.parse(String(p)))).toEqual([{ 'tile:add': 'Ctrl+Shift+A', 'tile:lock': 'Ctrl+L', 'tile:delete': 'Ctrl+D' }]);
    expect(Object.keys(getHotkeyOverrides()).sort()).toEqual(['tile:add', 'tile:delete', 'tile:lock']);
  });

  it('a corrupt file keeps the overrides and stops hotkey writes, which report failed rather than saved', async () => {
    setHotkeyOverrides({ 'tile:add': { key: 'a', ctrl: true, shift: true } });
    const saved: unknown[] = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'config:load') return { __corrupt: true, raw: '{', error: 'SyntaxError' };
      if (channel === 'config:save') saved.push(args[2]);
      return null;
    });
    await loadHotkeyOverrides(VAULT, noSleep);
    expect(Object.keys(getHotkeyOverrides())).toEqual(['tile:add']);
    expect(isConfigPathCorrupt('.filo/hotkeys.json')).toBe(true);

    setHotkeyOverride('tile:delete', { key: 'd', ctrl: true });
    saveHotkeyOverrides(VAULT);
    expect((await flushAllMisc()).failed).toEqual(['.filo/hotkeys.json']);
    expect(saved).toEqual([]);
    expect(hasFailedWrites()).toBe(true);
    // A retry can't fix an unreadable file, so nothing is kept for it.
    expect((await retryAllFailedWrites()).failed).toEqual([]);
    expect(saved).toEqual([]);
  });
});

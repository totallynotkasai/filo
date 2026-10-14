/**
 * General → Developer tools, main side: which keys open them, the switch kept
 * in `recent-vaults.json`, and the channels Settings uses. Main holds the
 * switch, so the page can't open the tools while it is off.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { OpenDevToolsOptions } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let userDataDir = '';
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => userDataDir },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler),
  },
}));

const { isDevToolsShortcut, loadDevToolsPreference, devToolsEnabled, toggleDevTools } = await import('../../main/services/devTools');
const { registerDevToolsHandlers } = await import('../../main/ipc/devTools.ipc');

interface FakeContents {
  open: boolean;
  isDestroyed: () => boolean;
  isDevToolsOpened: () => boolean;
  openDevTools: Mock<(options?: OpenDevToolsOptions) => void>;
  closeDevTools: Mock<() => void>;
}

function fakeContents(open = false): FakeContents {
  const c: FakeContents = {
    open,
    isDestroyed: () => false,
    isDevToolsOpened: () => c.open,
    openDevTools: vi.fn<(options?: OpenDevToolsOptions) => void>(() => { c.open = true; }),
    closeDevTools: vi.fn<() => void>(() => { c.open = false; }),
  };
  return c;
}

async function call(channel: string, sender: FakeContents, ...args: unknown[]): Promise<Record<string, unknown>> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} not registered`);
  return (await h({ sender }, ...args)) as Record<string, unknown>;
}

async function savedSwitch(): Promise<unknown> {
  const file = JSON.parse(await fs.readFile(join(userDataDir, 'recent-vaults.json'), 'utf-8')) as { preferences: { devToolsEnabled?: unknown } };
  return file.preferences.devToolsEnabled;
}

const key = (k: string, mods: Partial<{ control: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}, type: 'keyDown' | 'keyUp' = 'keyDown') =>
  ({ type, key: k, control: false, shift: false, alt: false, meta: false, ...mods });

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'filo-devtools-'));
  handlers.clear();
  registerDevToolsHandlers();
  await loadDevToolsPreference();
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

describe('isDevToolsShortcut', () => {
  it('takes Ctrl+Shift+I and F12 as they go down', () => {
    expect(isDevToolsShortcut(key('I', { control: true, shift: true }))).toBe(true);
    expect(isDevToolsShortcut(key('i', { control: true, shift: true }))).toBe(true);
    expect(isDevToolsShortcut(key('F12'))).toBe(true);
  });

  it('leaves every other key, a key coming up, and the keys with another modifier alone', () => {
    expect(isDevToolsShortcut(key('I', { control: true, shift: true }, 'keyUp'))).toBe(false);
    expect(isDevToolsShortcut(key('i', { control: true }))).toBe(false);
    expect(isDevToolsShortcut(key('I', { control: true, shift: true, alt: true }))).toBe(false);
    expect(isDevToolsShortcut(key('F12', { control: true }))).toBe(false);
    expect(isDevToolsShortcut(key('F11'))).toBe(false);
  });
});

describe('the Developer tools switch', () => {
  it('is off on a machine that never turned it on', async () => {
    expect(devToolsEnabled()).toBe(false);
    expect(await call('app:get-dev-tools', fakeContents())).toEqual({ enabled: false });
  });

  it('is saved for this machine and read back at the next start', async () => {
    expect(await call('app:set-dev-tools', fakeContents(), true)).toEqual({ success: true });
    expect(devToolsEnabled()).toBe(true);
    expect(await savedSwitch()).toBe(true);

    await loadDevToolsPreference();
    expect(devToolsEnabled()).toBe(true);
    expect(await call('app:get-dev-tools', fakeContents())).toEqual({ enabled: true });
  });

  it('turned off, closes developer tools left open', async () => {
    const contents = fakeContents();
    await call('app:set-dev-tools', contents, true);
    expect(await call('app:open-dev-tools', contents)).toEqual({ success: true });
    expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });

    expect(await call('app:set-dev-tools', contents, false)).toEqual({ success: true });
    expect(contents.closeDevTools).toHaveBeenCalledTimes(1);
    expect(contents.open).toBe(false);
    expect(await savedSwitch()).toBe(false);
  });

  it('while off, the page cannot open them', async () => {
    const contents = fakeContents();
    const result = await call('app:open-dev-tools', contents);
    expect(result.success).toBe(false);
    expect(result.code).toBe('FORBIDDEN');
    expect(contents.openDevTools).not.toHaveBeenCalled();
  });
});

describe('toggleDevTools', () => {
  it('opens them in a window of their own, and closes them when open', () => {
    const contents = fakeContents();
    toggleDevTools(contents);
    expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    toggleDevTools(contents);
    expect(contents.closeDevTools).toHaveBeenCalledTimes(1);
  });
});

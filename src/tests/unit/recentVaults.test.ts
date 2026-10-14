/**
 * The recent-vaults service: `recent-vaults.json` in userData, read before any
 * vault is open. Runs the real service over a temp userData folder so the
 * file on disk is what's asserted, not a mock's call log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => userDataDir,
  },
}));

const {
  loadRecentVaults,
  loadPreferences,
  setOpenLastVaultOnLaunch,
  setDevToolsEnabled,
  addRecentVault,
  removeRecentVault,
  pinRecentVault,
  clearRecentVaults,
} = await import('../../main/services/recentVaults');

interface SeedVault {
  path: string;
  name: string;
  lastOpened: number;
  pinned?: boolean;
  color?: string;
}

function filePath(): string {
  return join(userDataDir, 'recent-vaults.json');
}

async function seed(data: unknown): Promise<void> {
  await fs.writeFile(filePath(), typeof data === 'string' ? data : JSON.stringify(data));
}

async function onDisk(): Promise<{ vaults: SeedVault[]; preferences: { openLastVaultOnLaunch: boolean; devToolsEnabled?: boolean } }> {
  return JSON.parse(await fs.readFile(filePath(), 'utf-8'));
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'filo-recent-svc-'));
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  errSpy.mockRestore();
  vi.useRealTimers();
  await fs.rm(userDataDir, { recursive: true, force: true });
});

describe('reading recent-vaults.json', () => {
  it('a first launch (no file) reads as an empty list with the default preference, and logs nothing', async () => {
    expect(await loadRecentVaults()).toEqual([]);
    expect(await loadPreferences()).toEqual({ openLastVaultOnLaunch: true, devToolsEnabled: false });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('reads the older bare-array format as the vault list', async () => {
    await seed([{ path: '/a', name: 'A', lastOpened: 1 }]);
    expect(await loadRecentVaults()).toEqual([{ path: '/a', name: 'A', lastOpened: 1 }]);
    expect(await loadPreferences()).toEqual({ openLastVaultOnLaunch: true, devToolsEnabled: false });
  });

  it('merges stored preferences over the defaults', async () => {
    await seed({ vaults: [], preferences: { openLastVaultOnLaunch: false } });
    expect(await loadPreferences()).toEqual({ openLastVaultOnLaunch: false, devToolsEnabled: false });
    await seed({ vaults: [] });
    expect(await loadPreferences()).toEqual({ openLastVaultOnLaunch: true, devToolsEnabled: false });
  });

  it('treats a non-array `vaults` field as empty', async () => {
    await seed({ vaults: 'nope', preferences: {} });
    expect(await loadRecentVaults()).toEqual([]);
  });

  it('a corrupt file reads as empty and leaves a log line saying why', async () => {
    await seed('{ not json');
    expect(await loadRecentVaults()).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('recentVaults.parse');
  });

  it('a JSON scalar reads as empty', async () => {
    await seed('42');
    expect(await loadRecentVaults()).toEqual([]);
    expect(await loadPreferences()).toEqual({ openLastVaultOnLaunch: true, devToolsEnabled: false });
  });
});

describe('addRecentVault', () => {
  it('puts a new vault first, stamped now, and writes the file', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(5_000);
    await seed({ vaults: [{ path: '/old', name: 'Old', lastOpened: 1 }], preferences: { openLastVaultOnLaunch: false } });

    const list = await addRecentVault('/new', 'New');

    expect(list.map((v) => v.path)).toEqual(['/new', '/old']);
    expect(list[0]).toMatchObject({ path: '/new', name: 'New', lastOpened: 5_000 });
    const file = await onDisk();
    expect(file.vaults.map((v) => v.path)).toEqual(['/new', '/old']);
    // Adding a vault doesn't touch the launch preference.
    expect(file.preferences.openLastVaultOnLaunch).toBe(false);
  });

  it('re-adding a vault moves it to the front once, renamed, keeping its pin', async () => {
    await seed({
      vaults: [
        { path: '/a', name: 'A', lastOpened: 3 },
        { path: '/b', name: 'B', lastOpened: 2, pinned: true },
      ],
    });

    const list = await addRecentVault('/b', 'B renamed');

    expect(list.filter((v) => v.path === '/b')).toHaveLength(1);
    const b = list.find((v) => v.path === '/b');
    expect(b).toMatchObject({ name: 'B renamed', pinned: true });
    expect(b?.lastOpened).toBeGreaterThan(3);
  });

  it('keeps only the 10 most recently opened unpinned vaults, and every pin', async () => {
    const vaults: SeedVault[] = Array.from({ length: 12 }, (_, i) => ({ path: `/u${i}`, name: `U${i}`, lastOpened: 100 + i }));
    vaults.push({ path: '/pinned-old', name: 'P', lastOpened: 1, pinned: true });
    await seed({ vaults });

    const list = await addRecentVault('/fresh', 'Fresh');

    const unpinned = list.filter((v) => !v.pinned).map((v) => v.path);
    expect(unpinned).toHaveLength(10);
    expect(unpinned[0]).toBe('/fresh');
    // The newest nine seeded entries survive; the three oldest go.
    expect(unpinned).toContain('/u11');
    expect(unpinned).toContain('/u3');
    expect(unpinned).not.toContain('/u2');
    expect(unpinned).not.toContain('/u0');
    // An old pin is never pruned by the unpinned cap.
    expect(list.some((v) => v.path === '/pinned-old')).toBe(true);
    // Pins list before unpinned entries.
    expect(list[0].path).toBe('/pinned-old');
  });

  it('keeps the stored colour when none is given, and an empty string clears it', async () => {
    await seed({ vaults: [{ path: '/a', name: 'A', lastOpened: 1, color: '#123456' }] });

    let list = await addRecentVault('/a', 'A');
    expect(list[0].color).toBe('#123456');

    list = await addRecentVault('/a', 'A', '');
    expect(list[0].color).toBeUndefined();
    expect((await onDisk()).vaults[0]).not.toHaveProperty('color');
  });

  it('refuses a colour that is not #rgb / #rrggbb (it reaches an inline style)', async () => {
    const list = await addRecentVault('/a', 'A', 'red; background: url(x)');
    expect(list[0].color).toBeUndefined();
  });
});

describe('removeRecentVault / pinRecentVault / clearRecentVaults', () => {
  beforeEach(async () => {
    await seed({
      vaults: [
        { path: '/a', name: 'A', lastOpened: 3 },
        { path: '/b', name: 'B', lastOpened: 2, pinned: true },
        { path: '/c', name: 'C', lastOpened: 1 },
      ],
      preferences: { openLastVaultOnLaunch: true },
    });
  });

  it('remove drops the entry and writes the rest', async () => {
    const list = await removeRecentVault('/a');
    expect(list.map((v) => v.path)).toEqual(['/b', '/c']);
    expect((await onDisk()).vaults.map((v) => v.path)).toEqual(['/b', '/c']);
  });

  it('remove of an unknown path changes nothing', async () => {
    const list = await removeRecentVault('/zzz');
    expect(list.map((v) => v.path)).toEqual(['/a', '/b', '/c']);
  });

  it('pin marks the entry and lists pins first', async () => {
    const list = await pinRecentVault('/c', true);
    expect(list.map((v) => [v.path, v.pinned === true])).toEqual([
      ['/b', true],
      ['/c', true],
      ['/a', false],
    ]);
  });

  it('unpin puts the entry back among the recents by last opened', async () => {
    const list = await pinRecentVault('/b', false);
    expect(list.map((v) => v.path)).toEqual(['/a', '/b', '/c']);
    expect(list.find((v) => v.path === '/b')?.pinned).toBe(false);
  });

  it('clear keeps the pinned vaults only', async () => {
    const list = await clearRecentVaults();
    expect(list.map((v) => v.path)).toEqual(['/b']);
    expect((await onDisk()).vaults.map((v) => v.path)).toEqual(['/b']);
  });
});

describe('setOpenLastVaultOnLaunch', () => {
  it('saves the preference and keeps the vault list', async () => {
    await seed({ vaults: [{ path: '/a', name: 'A', lastOpened: 1 }] });

    await setOpenLastVaultOnLaunch(false);

    expect(await loadPreferences()).toEqual({ openLastVaultOnLaunch: false, devToolsEnabled: false });
    expect((await loadRecentVaults()).map((v) => v.path)).toEqual(['/a']);
  });

  it('creates the file on a first launch', async () => {
    await setOpenLastVaultOnLaunch(false);
    expect(await onDisk()).toEqual({ vaults: [], preferences: { openLastVaultOnLaunch: false, devToolsEnabled: false } });
  });

  it('writes atomically: no temp file is left beside it', async () => {
    await setOpenLastVaultOnLaunch(true);
    const names = await fs.readdir(userDataDir);
    expect(names).toEqual(['recent-vaults.json']);
  });
});

describe('setDevToolsEnabled', () => {
  it('is off until the user turns it on', async () => {
    expect((await loadPreferences()).devToolsEnabled).toBe(false);
    await seed({ vaults: [], preferences: { openLastVaultOnLaunch: true } });
    expect((await loadPreferences()).devToolsEnabled).toBe(false);
  });

  it('saves the switch and keeps the other preference and the vault list', async () => {
    await seed({ vaults: [{ path: '/a', name: 'A', lastOpened: 1 }], preferences: { openLastVaultOnLaunch: false } });

    await setDevToolsEnabled(true);

    expect(await onDisk()).toEqual({
      vaults: [{ path: '/a', name: 'A', lastOpened: 1 }],
      preferences: { openLastVaultOnLaunch: false, devToolsEnabled: true },
    });
    await setDevToolsEnabled(false);
    expect((await loadPreferences()).devToolsEnabled).toBe(false);
  });

  it('reads anything but a real true as off', async () => {
    for (const value of ['true', 1, 'yes', null]) {
      await seed({ vaults: [], preferences: { devToolsEnabled: value } });
      expect((await loadPreferences()).devToolsEnabled).toBe(false);
    }
  });
});

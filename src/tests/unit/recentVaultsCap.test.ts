import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Phase 8 / 8.5 — defensive caps on the recent-vaults list:
 *   (a) `vault:add-recent` / `vault:pin-recent` reject paths or names
 *       longer than 4096 chars or containing null bytes;
 *   (b) `recent-vaults.json` is capped at 50 entries — pins beyond that
 *       are pruned by lastOpened so the file never grows unbounded.
 *
 * The IPC handlers and the underlying service are exercised through
 * mocked Electron primitives so the cap behaviour is asserted end-to-end
 * (a buggy renderer that sends a 1 GB string really does get rejected
 * before `recent-vaults.json` is opened).
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => userDataDir,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
  },
  shell: {
    openExternal: async () => undefined,
    openPath: async () => '',
    showItemInFolder: () => undefined,
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
}));

// vault.ipc.ts pulls in a wide tree of helpers; we only need the
// vault:add-recent / pin-recent / remove-recent handlers, so the heavy
// imports run for real. The mock above keeps Electron itself stubbed.
const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');

describe('vault:add-recent / pin-recent caps (Phase 8 / 8.5)', () => {
  let addHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let pinHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let removeHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'filo-recents-'));
    handlers.clear();
    registerVaultHandlers();
    addHandler = handlers.get('vault:add-recent') as typeof addHandler;
    pinHandler = handlers.get('vault:pin-recent') as typeof pinHandler;
    removeHandler = handlers.get('vault:remove-recent') as typeof removeHandler;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    errSpy?.mockRestore();
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  describe('input validation', () => {
    it('accepts a normal vault path and name', async () => {
      // Sprint C / C21 — `vault:add-recent` now stat-checks the path
      // and rejects non-directories, so pass a real temp directory.
      const realVault = await fs.mkdtemp(join(tmpdir(), 'filo-recents-vault-'));
      try {
        const result = (await addHandler({}, realVault, 'MyVault')) as unknown[];
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
      } finally {
        await fs.rm(realVault, { recursive: true, force: true });
      }
    });

    it('rejects a path longer than 4096 characters (returns [])', async () => {
      const longPath = '/' + 'a'.repeat(4096);
      const result = (await addHandler({}, longPath, 'MyVault')) as unknown[];
      expect(result).toEqual([]);
      // recent-vaults.json should still not exist (no successful write).
      await expect(fs.stat(join(userDataDir, 'recent-vaults.json'))).rejects.toThrow();
    });

    it('rejects a path containing a null byte', async () => {
      const result = (await addHandler({}, '/vault\0evil', 'MyVault')) as unknown[];
      expect(result).toEqual([]);
    });

    it('rejects a name longer than 4096 characters', async () => {
      const longName = 'a'.repeat(4097);
      const result = (await addHandler({}, '/home/me/V', longName)) as unknown[];
      expect(result).toEqual([]);
    });

    it('rejects an empty path', async () => {
      const result = (await addHandler({}, '', 'V')) as unknown[];
      expect(result).toEqual([]);
    });

    it('vault:pin-recent also rejects oversize paths', async () => {
      const longPath = '/' + 'b'.repeat(4096);
      const result = (await pinHandler({}, longPath, true)) as unknown[];
      expect(result).toEqual([]);
    });

    it('vault:remove-recent also rejects null-byte paths', async () => {
      const result = (await removeHandler({}, '/vault\0evil')) as unknown[];
      expect(result).toEqual([]);
    });
  });

  describe('50-entry total cap', () => {
    it('caps the file at MAX_TOTAL entries even when pins push past the unpinned cap', async () => {
      // Pre-seed recent-vaults.json with 60 pinned entries; the cap should
      // trim down to 50 on the next write.
      const path = join(userDataDir, 'recent-vaults.json');
      const seeded = {
        vaults: Array.from({ length: 60 }, (_, i) => ({
          path: `/v/${i}`,
          name: `V${i}`,
          // lastOpened increases with i — i = 59 is most recently opened.
          lastOpened: 1_000_000 + i,
          pinned: true,
        })),
        preferences: { openLastVaultOnLaunch: true },
      };
      await fs.writeFile(path, JSON.stringify(seeded));

      // Sprint C / C21 — `vault:add-recent` now stat-checks the path
      // and rejects non-directories. Create a real temp dir for the
      // new entry; the pre-seeded entries are pre-existing and never
      // re-validated.
      const newVault = await fs.mkdtemp(join(tmpdir(), 'filo-recents-new-'));
      try {
        // Trigger a write via add-recent — the helper trims on every write.
        const result = (await addHandler({}, newVault, 'New')) as { path: string }[];
        // 50 entries max; the new unpinned entry is in there.
        expect(result.length).toBeLessThanOrEqual(50);
        expect(result.some((v) => v.path === newVault)).toBe(true);

        // The most-recently-opened pins (i = 59, 58, …) survive; the oldest
        // pins (i = 0, 1, …) were pruned.
        const survivors = new Set(result.map((v) => v.path));
        expect(survivors.has('/v/59')).toBe(true);
        expect(survivors.has('/v/0')).toBe(false);

        // File on disk reflects the trimmed list.
        const onDisk = JSON.parse(await fs.readFile(path, 'utf-8'));
        expect(onDisk.vaults.length).toBeLessThanOrEqual(50);
      } finally {
        await fs.rm(newVault, { recursive: true, force: true });
      }
    });
  });
});

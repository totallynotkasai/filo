import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * `vault:create-file-text` is CREATE-EXCLUSIVE. The seed paths
 * (new Kanban card / task / Task-List OS drop) used `vault:write-file-text`
 * (create-or-OVERWRITE) and silently replaced an existing off-board file with the
 * same name. Real temp dir, real handler.
 *
 * Bite: replace the `'wx'` open with a plain `atomicWriteFile` → the EEXIST case
 * goes red (the existing bytes are overwritten).
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
const failAtomic = vi.hoisted(() => ({ on: false }));

vi.mock('../../main/vault/filenameUtils', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../main/vault/filenameUtils')>();
  return {
    ...real,
    atomicWriteFile: async (...a: Parameters<typeof real.atomicWriteFile>) => {
      if (failAtomic.on) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return real.atomicWriteFile(...a);
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => '' },
}));

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

type Result = { success: boolean; code?: string; error?: string; path?: string };

describe('vault:create-file-text', () => {
  let vaultDir: string;
  let create: (root: string, rel: string, content: string) => Promise<Result>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerVaultHandlers();
    const h = handlers.get('vault:create-file-text');
    if (!h) throw new Error('vault:create-file-text handler not registered');
    create = (root, rel, content) => h({}, root, rel, content) as Promise<Result>;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-create-file-text-'));
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('creates a new file with exact bytes, mkdir-ing parents', async () => {
    const r = await create(vaultDir, 'Kanban/Board/New Card.md', '---\na: 1\n---\nbody\n');
    expect(r.success).toBe(true);
    expect(await fs.readFile(join(vaultDir, 'Kanban/Board/New Card.md'), 'utf-8')).toBe('---\na: 1\n---\nbody\n');
  });

  it('returns EEXIST and leaves an existing file byte-identical', async () => {
    const p = join(vaultDir, 'Notes.md');
    await fs.writeFile(p, 'precious user notes\n', 'utf-8');
    const before = await fs.stat(p);
    await new Promise((r) => setTimeout(r, 20));
    const r = await create(vaultDir, 'Notes.md', '');
    expect(r).toMatchObject({ success: false, code: 'EEXIST' });
    expect(await fs.readFile(p, 'utf-8')).toBe('precious user notes\n');
    expect((await fs.stat(p)).mtimeMs).toBe(before.mtimeMs);
  });

  it.skipIf(process.platform === 'linux')('treats a case-only collision as EEXIST on a case-insensitive FS', async () => {
    await fs.writeFile(join(vaultDir, 'Groceries.md'), 'milk\n', 'utf-8');
    const r = await create(vaultDir, 'groceries.md', '');
    expect(r).toMatchObject({ success: false, code: 'EEXIST' });
    expect(await fs.readFile(join(vaultDir, 'Groceries.md'), 'utf-8')).toBe('milk\n');
  });

  it('refuses .filo/ and reserved device names', async () => {
    expect((await create(vaultDir, '.filo/x.md', '')).code).toBe('FORBIDDEN');
    expect((await create(vaultDir, 'CON.md', '')).code).toBe('INVALID_FILENAME');
  });

  it('a write failure after the reserve removes the 0-byte placeholder', async () => {
    failAtomic.on = true;
    try {
      const r = await create(vaultDir, 'Fresh.md', 'content');
      expect(r.success).toBe(false);
    } finally {
      failAtomic.on = false;
    }
    await expect(fs.access(join(vaultDir, 'Fresh.md'))).rejects.toBeDefined();
    // The name is free again, so a retry succeeds.
    expect((await create(vaultDir, 'Fresh.md', 'content')).success).toBe(true);
  });

  it('accepts a name with an ellipsis', async () => {
    const r = await create(vaultDir, 'Ideas... later.md', 'x');
    expect(r.success).toBe(true);
  });
});

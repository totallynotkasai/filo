import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * A note that is a symbolic link is never replaced by a write. An atomic
 * write (tmp + rename) replaces the link itself with a regular file, so the
 * original it pointed at would silently stop getting the edits. The read
 * reports `link: true` (the renderer shows the note read-only) and both text
 * write channels refuse with NOTE_IS_LINK. Real temp dir, real handlers.
 *
 * Bite: drop the `isSymbolicLink` pre-checks and `refuseLink` in vault.ipc.ts
 * → the write cases go red (the link becomes a regular file).
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

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
const { atomicWriteFile, isSymbolicLink, LinkedFileError } = await import('../../main/vault/filenameUtils');

type Result = { success: boolean; code?: string; content?: string; link?: boolean; mtimeMs?: number; size?: number };

function call(channel: string, ...args: unknown[]): Promise<Result> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} handler not registered`);
  return h({}, ...args) as Promise<Result>;
}

/**
 * Whether this OS lets the test create a file symlink (Windows needs
 * Developer Mode or admin rights; without them `symlink` throws EPERM).
 */
const canSymlink = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'filo-symlink-probe-'));
  try {
    writeFileSync(join(dir, 'target.md'), 'x');
    symlinkSync(join(dir, 'target.md'), join(dir, 'link.md'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const ORIGINAL = '---\ntitle: Original\n---\nShared body\n';

describe.skipIf(!canSymlink)('vault text channels vs a symlinked note', () => {
  let vaultDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerVaultHandlers();
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-symlink-note-'));
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.mkdir(join(vaultDir, 'Notes'));
    await fs.writeFile(join(vaultDir, 'Notes', 'Original.md'), ORIGINAL, 'utf-8');
    await fs.symlink(join(vaultDir, 'Notes', 'Original.md'), join(vaultDir, 'Alias.md'), 'file');
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('the read reports the link; a regular note reports none', async () => {
    const linked = await call('vault:read-file-text', vaultDir, 'Alias.md');
    expect(linked).toMatchObject({ success: true, content: ORIGINAL, link: true });
    const plain = await call('vault:read-file-text', vaultDir, 'Notes/Original.md');
    expect(plain.success).toBe(true);
    expect(plain.link).toBeUndefined();
  });

  it('both text writes refuse with NOTE_IS_LINK and leave the link and the original alone', async () => {
    const read = await call('vault:read-file-text', vaultDir, 'Alias.md');
    const existing = await call('vault:write-existing-file-text', vaultDir, 'Alias.md', 'Replaced\n', {
      mtimeMs: read.mtimeMs,
      size: read.size,
    });
    expect(existing).toMatchObject({ success: false, code: 'NOTE_IS_LINK' });
    const plain = await call('vault:write-file-text', vaultDir, 'Alias.md', 'Replaced\n');
    expect(plain).toMatchObject({ success: false, code: 'NOTE_IS_LINK' });

    expect((await fs.lstat(join(vaultDir, 'Alias.md'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(join(vaultDir, 'Notes', 'Original.md'), 'utf-8')).toBe(ORIGINAL);
    // No stray temp file is left next to the link.
    expect((await fs.readdir(vaultDir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('the original itself still writes normally', async () => {
    const w = await call('vault:write-existing-file-text', vaultDir, 'Notes/Original.md', 'Edited\n');
    expect(w.success).toBe(true);
    expect(await fs.readFile(join(vaultDir, 'Alias.md'), 'utf-8')).toBe('Edited\n');
    expect((await fs.lstat(join(vaultDir, 'Alias.md'))).isSymbolicLink()).toBe(true);
  });

  it('atomicWriteFile with refuseLink throws LinkedFileError right before the rename', async () => {
    const link = join(vaultDir, 'Alias.md');
    expect(await isSymbolicLink(link)).toBe(true);
    await expect(atomicWriteFile(link, 'Replaced\n', { refuseLink: true })).rejects.toBeInstanceOf(LinkedFileError);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect((await fs.readdir(vaultDir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

/**
 * The same refusals where the OS won't let the test make a real link (Windows
 * without Developer Mode): `lstat` reports the note as a link.
 */
describe('vault text channels vs a note lstat reports as a link', () => {
  let vaultDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let lstatSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    if (!handlers.has('vault:read-file-text')) registerVaultHandlers();
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-fake-link-'));
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.writeFile(join(vaultDir, 'Alias.md'), ORIGINAL, 'utf-8');
    const realLstat = fs.lstat.bind(fs);
    lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (p: Parameters<typeof fs.lstat>[0]) => {
      const stats = await realLstat(p);
      if (String(p).endsWith('Alias.md')) stats.isSymbolicLink = (): boolean => true;
      return stats;
    });
  });

  afterEach(async () => {
    lstatSpy.mockRestore();
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('reads report the link and every write is refused, leaving the bytes', async () => {
    expect(await call('vault:read-file-text', vaultDir, 'Alias.md')).toMatchObject({ success: true, link: true });
    expect(await call('vault:write-existing-file-text', vaultDir, 'Alias.md', 'x\n')).toMatchObject({
      success: false,
      code: 'NOTE_IS_LINK',
    });
    expect(await call('vault:write-file-text', vaultDir, 'Alias.md', 'x\n')).toMatchObject({
      success: false,
      code: 'NOTE_IS_LINK',
    });
    await expect(atomicWriteFile(join(vaultDir, 'Alias.md'), 'x\n', { refuseLink: true })).rejects.toBeInstanceOf(
      LinkedFileError,
    );
    expect(await fs.readFile(join(vaultDir, 'Alias.md'), 'utf-8')).toBe(ORIGINAL);
    expect((await fs.readdir(vaultDir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('isSymbolicLink', () => {
  it('is false for a regular file and for a missing path', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'filo-symlink-plain-'));
    try {
      await fs.writeFile(join(dir, 'a.md'), 'x');
      expect(await isSymbolicLink(join(dir, 'a.md'))).toBe(false);
      expect(await isSymbolicLink(join(dir, 'missing.md'))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

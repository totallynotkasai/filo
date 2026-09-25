import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, openSync, closeSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * `.filo/trash` — main side. Every user-facing delete moves the item into the
 * trash; undo and Settings → Trash move it back. Purging hands items to the OS
 * Recycle Bin and never deletes on its own.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
const trashItem = vi.fn(async (_path: string): Promise<void> => {});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
    removeHandler: () => {},
  },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
    trashItem: (p: string) => trashItem(p),
  },
}));

const { registerVaultTrashHandlers } = await import('../../main/ipc/vaultTrash.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { __setMachineIdentityForTests } = await import('../../main/services/machineIdentity');
const trashOps = await import('../../main/vault/trashOps');
const { shouldIgnorePath } = await import('../../main/services/fileWatcherClassify');

type Handler = (...args: unknown[]) => Promise<Record<string, unknown>>;
const call = (channel: string, ...args: unknown[]): Promise<Record<string, unknown>> =>
  (handlers.get(channel) as Handler)({}, ...args);

const ME = 'aaaaaaaaaaaa';
let vault: string;

async function write(rel: string, data: string | Uint8Array): Promise<void> {
  const abs = join(vault, ...rel.split('/'));
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, data);
}
const read = (rel: string): Promise<Buffer> => fs.readFile(join(vault, ...rel.split('/')));
async function exists(rel: string): Promise<boolean> {
  try {
    await fs.lstat(join(vault, ...rel.split('/')));
    return true;
  } catch {
    return false;
  }
}
async function trashDirEntries(): Promise<string[]> {
  try {
    return await fs.readdir(join(vault, '.filo', 'trash'));
  } catch {
    return [];
  }
}

beforeAll(() => registerVaultTrashHandlers());

beforeEach(async () => {
  vault = await fs.mkdtemp(join(tmpdir(), 'filo-trash-'));
  vaultRegistry.setCurrentVault(vault);
  __setMachineIdentityForTests({ machineId: ME, hostname: 'this-pc' });
  trashItem.mockReset();
  // The Recycle Bin takes the item away.
  trashItem.mockImplementation(async (p: string) => { await fs.rm(p, { recursive: true, force: true }); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vaultRegistry.setCurrentVault(null);
  __setMachineIdentityForTests(null);
  await fs.rm(vault, { recursive: true, force: true });
});

describe('vault:trash-move and vault:trash-restore', () => {
  it('a file round-trips its bytes and the trash is left empty', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 13, 10, 255]);
    await write('Media/clip.mp4', bytes);
    const moved = await call('vault:trash-move', vault, 'Media/clip.mp4');
    expect(moved).toMatchObject({ success: true, kind: 'file' });
    expect(await exists('Media/clip.mp4')).toBe(false);
    const id = moved.trashId as string;
    expect(id).toMatch(trashOps.TRASH_ID_RE);
    const manifest = JSON.parse((await read(`.filo/trash/${id}/manifest.json`)).toString('utf-8'));
    expect(manifest).toMatchObject({ originalPath: 'Media/clip.mp4', machineId: ME, kind: 'file' });
    expect(Buffer.compare(await read(`.filo/trash/${id}/files/Media/clip.mp4`), Buffer.from(bytes))).toBe(0);

    const restored = await call('vault:trash-restore', vault, id);
    expect(restored).toMatchObject({ success: true, restoredPath: 'Media/clip.mp4', alongside: false });
    expect(Buffer.compare(await read('Media/clip.mp4'), Buffer.from(bytes))).toBe(0);
    expect(await trashDirEntries()).toEqual([]);
  });

  it('a folder moves and restores whole, including its sub-folders', async () => {
    await write('Projects/A.md', '# A\n');
    await write('Projects/deep/B.board.json', '{"version":8}');
    const moved = await call('vault:trash-move', vault, 'Projects');
    expect(moved).toMatchObject({ success: true, kind: 'folder' });
    expect(await exists('Projects')).toBe(false);
    await call('vault:trash-restore', vault, moved.trashId);
    expect((await read('Projects/A.md')).toString()).toBe('# A\n');
    expect((await read('Projects/deep/B.board.json')).toString()).toBe('{"version":8}');
  });

  it('restores a file whose folder was deleted since, recreating the folder', async () => {
    await write('Old/Note.md', 'text');
    const moved = await call('vault:trash-move', vault, 'Old/Note.md');
    await fs.rm(join(vault, 'Old'), { recursive: true });
    await call('vault:trash-restore', vault, moved.trashId);
    expect((await read('Old/Note.md')).toString()).toBe('text');
  });

  it('restoring onto a path that is taken again goes beside it', async () => {
    await write('Plan.md', 'original');
    await write('Plan.board.json', '{}');
    const first = await call('vault:trash-move', vault, 'Plan.md');
    const board = await call('vault:trash-move', vault, 'Plan.board.json');
    await write('Plan.md', 'new one');
    await write('Plan.board.json', '{"new":true}');

    const restored = await call('vault:trash-restore', vault, first.trashId);
    expect(restored).toMatchObject({ success: true, restoredPath: 'Plan (restored).md', alongside: true, originalPath: 'Plan.md' });
    expect((await read('Plan.md')).toString()).toBe('new one');
    expect((await read('Plan (restored).md')).toString()).toBe('original');

    const b = await call('vault:trash-restore', vault, board.trashId);
    expect(b.restoredPath).toBe('Plan (restored).board.json');
  });

  it('a second restore of the same item reports it missing', async () => {
    await write('X.md', 'x');
    const moved = await call('vault:trash-move', vault, 'X.md');
    await call('vault:trash-restore', vault, moved.trashId);
    expect(await call('vault:trash-restore', vault, moved.trashId)).toMatchObject({
      success: false,
      code: 'TRASH_ITEM_MISSING',
    });
  });

  it('a failed move (a locked child) moves nothing and leaves no trash entry', async () => {
    await write('Busy/a.md', 'a');
    await write('Busy/b.md', 'b');
    const locked = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    vi.spyOn(fs, 'rename').mockRejectedValue(locked);
    const result = await call('vault:trash-move', vault, 'Busy');
    expect(result).toMatchObject({ success: false });
    vi.mocked(fs.rename).mockRestore();
    expect((await read('Busy/a.md')).toString()).toBe('a');
    expect((await read('Busy/b.md')).toString()).toBe('b');
    expect(await trashDirEntries()).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('Windows: a folder with an open child file does not move at all', async () => {
    await write('Open/held.md', 'held');
    await write('Open/free.md', 'free');
    const fd = openSync(join(vault, 'Open', 'held.md'), 'r');
    try {
      const result = await call('vault:trash-move', vault, 'Open');
      if (result.success) {
        // Some Windows builds allow renaming a folder around an open handle;
        // then the move is still whole.
        expect(await exists('Open')).toBe(false);
      } else {
        expect(await exists('Open/held.md')).toBe(true);
        expect(await exists('Open/free.md')).toBe(true);
        expect(await trashDirEntries()).toEqual([]);
      }
    } finally {
      closeSync(fd);
    }
  });

  it('refuses paths inside .filo, and escapes', async () => {
    await write('.filo/tags.json', '{}');
    expect(await call('vault:trash-move', vault, '.filo/tags.json')).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await call('vault:trash-move', vault, '.FILO')).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await exists('.filo/tags.json')).toBe(true);
    expect(await call('vault:trash-move', vault, '../outside.md')).toMatchObject({ success: false });
    expect(await call('vault:trash-restore', vault, '../../etc')).toMatchObject({ success: false, code: 'FORBIDDEN' });
  });

  it('a tampered manifest that points outside the vault is never listed or restored', async () => {
    await write('Z.md', 'z');
    const moved = await call('vault:trash-move', vault, 'Z.md');
    const id = moved.trashId as string;
    const manifestPath = `.filo/trash/${id}/manifest.json`;
    const manifest = JSON.parse((await read(manifestPath)).toString());
    await write(manifestPath, JSON.stringify({ ...manifest, originalPath: '../escaped.md' }));
    const listed = await call('vault:trash-list', vault);
    expect(listed.entries).toEqual([]);
    expect(await call('vault:trash-restore', vault, id)).toMatchObject({ success: false, code: 'TRASH_ITEM_MISSING' });
  });

  it('the watcher ignores everything under .filo/trash', () => {
    expect(shouldIgnorePath('.filo/trash/20260925T101500Z-a1b2c3/files/Notes/A.md')).toBe(true);
    expect(shouldIgnorePath('Notes/trash/A.md')).toBe(false);
  });
});

describe('vault:trash-list', () => {
  it('lists entries newest first with their original paths', async () => {
    await write('a.md', 'a');
    await write('b.md', 'b');
    await trashOps.moveToTrash(vault, 'a.md', ME, new Date('2026-09-01T00:00:00Z'));
    await trashOps.moveToTrash(vault, 'b.md', ME, new Date('2026-09-02T00:00:00Z'));
    const listed = await call('vault:trash-list', vault);
    expect(listed.machineId).toBe(ME);
    expect((listed.entries as Array<{ originalPath: string; present: boolean }>).map((e) => [e.originalPath, e.present])).toEqual([
      ['b.md', true],
      ['a.md', true],
    ]);
  });
});

describe('vault:trash-purge', () => {
  it('sends items to the Recycle Bin and clears their bookkeeping', async () => {
    await write('Gone.md', 'bye');
    const moved = await call('vault:trash-move', vault, 'Gone.md');
    const result = await call('vault:trash-purge', vault, [moved.trashId]);
    expect(result).toEqual({ success: true, purged: [moved.trashId] });
    expect(trashItem).toHaveBeenCalledTimes(1);
    expect(trashItem.mock.calls[0][0].replace(/\\/g, '/')).toMatch(/\.filo\/trash\/[^/]+\/files\/Gone\.md$/);
    expect(await trashDirEntries()).toEqual([]);
  });

  it('when the Recycle Bin refuses, reports TRASH_FAILED with the list and deletes nothing', async () => {
    await write('Keep.md', 'keep');
    await write('Also.md', 'also');
    const a = await call('vault:trash-move', vault, 'Keep.md');
    const b = await call('vault:trash-move', vault, 'Also.md');
    trashItem.mockRejectedValue(new Error('Recycle Bin unavailable on this volume'));
    const result = await call('vault:trash-purge', vault, [a.trashId, b.trashId]);
    expect(result).toMatchObject({ success: false, code: 'TRASH_FAILED', purged: [] });
    expect((result.failed as Array<{ originalPath: string }>).map((f) => f.originalPath).sort()).toEqual(['Also.md', 'Keep.md']);
    expect((await read(`.filo/trash/${a.trashId as string}/files/Keep.md`)).toString()).toBe('keep');
    expect((await read(`.filo/trash/${b.trashId as string}/files/Also.md`)).toString()).toBe('also');
  });

  it('the 30-day sweep only takes this machine\'s items past the retention period', async () => {
    await write('old-mine.md', '1');
    await write('old-theirs.md', '2');
    await write('new-mine.md', '3');
    const longAgo = new Date(Date.now() - trashOps.TRASH_RETENTION_MS - 60_000);
    const mine = await trashOps.moveToTrash(vault, 'old-mine.md', ME, longAgo);
    await trashOps.moveToTrash(vault, 'old-theirs.md', 'bbbbbbbbbbbb', longAgo);
    await trashOps.moveToTrash(vault, 'new-mine.md', ME);
    const result = await call('vault:trash-purge', vault, 'olderThan30d');
    expect(result).toEqual({ success: true, purged: [mine.trashId] });
    const left = (await call('vault:trash-list', vault)).entries as Array<{ originalPath: string }>;
    expect(left.map((e) => e.originalPath).sort()).toEqual(['new-mine.md', 'old-theirs.md']);
  });

  it('never deletes anything itself: no fs.rm / unlink of user content', async () => {
    await write('Safe.md', 'safe');
    const moved = await call('vault:trash-move', vault, 'Safe.md');
    trashItem.mockRejectedValue(new Error('refused'));
    const rm = vi.spyOn(fs, 'rm');
    await call('vault:trash-purge', vault, [moved.trashId]);
    expect(rm).not.toHaveBeenCalled();
    expect((await read(`.filo/trash/${moved.trashId as string}/files/Safe.md`)).toString()).toBe('safe');
  });
});

describe('vault:trash-delete-permanently', () => {
  it('removes the named entries for good', async () => {
    await write('Bye.md', 'bye');
    const moved = await call('vault:trash-move', vault, 'Bye.md');
    expect(await call('vault:trash-delete-permanently', vault, [moved.trashId])).toEqual({
      success: true,
      deleted: [moved.trashId],
    });
    expect(await trashDirEntries()).toEqual([]);
  });

  it('refuses anything that is not a trash id', async () => {
    await write('Notes/A.md', 'a');
    expect(await call('vault:trash-delete-permanently', vault, ['../Notes'])).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
    });
    expect(await exists('Notes/A.md')).toBe(true);
  });
});

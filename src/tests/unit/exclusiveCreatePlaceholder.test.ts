import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * An exclusive create reserves the name with a 0-byte placeholder (`'wx'`),
 * then writes the real bytes over it. Two hazards:
 * - the placeholder's own create event must not reach the renderer as an
 *   external change (a 0-byte note), so the watcher is told about the write
 *   before the placeholder exists;
 * - when the write fails, only the placeholder Filo made may be removed. A file
 *   another program (a sync client, an editor) put at that name meanwhile is
 *   theirs and stays, and Filo's write must not land over it either.
 *
 * Real temp dir, real handler; `atomicWriteFile` is wrapped so a test can fail
 * it, or have "another program" replace the placeholder first.
 */

type AtomicMode = 'real' | 'fail' | 'replaceThenFail' | 'replaceEmptyThenFail' | 'replaceThenReal';
const atomic = vi.hoisted(() => ({ mode: 'real' as string }));

/** Puts a different file at `path` the way an atomic-saving program does (new inode). */
async function replaceFromOutside(path: string, content: string): Promise<void> {
  const side = `${path}.outside`;
  await fs.writeFile(side, content, 'utf-8');
  await fs.rename(side, path);
}

vi.mock('../../main/vault/filenameUtils', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../main/vault/filenameUtils')>();
  return {
    ...real,
    atomicWriteFile: async (...a: Parameters<typeof real.atomicWriteFile>) => {
      const [path] = a;
      switch (atomic.mode) {
        case 'fail':
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        case 'replaceThenFail':
          await replaceFromOutside(path, 'their text\n');
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        case 'replaceEmptyThenFail':
          await replaceFromOutside(path, '');
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        case 'replaceThenReal':
          await replaceFromOutside(path, 'their text\n');
          return real.atomicWriteFile(...a);
        default:
          return real.atomicWriteFile(...a);
      }
    },
  };
});

interface SuppressCall {
  rel: string;
  content: string | Buffer | undefined;
  fileExisted: boolean;
}
const watcherLog = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock('../../main/services/fileWatcher', async () => {
  const { existsSync: exists } = await import('fs');
  const { join: joinPath } = await import('path');
  class FakeFileWatcher {
    constructor(private readonly root: string) {}
    start(): void {}
    async stop(): Promise<void> {}
    suppress(): void {}
    suppressTree(): void {}
    recordOwnWrite(): void {}
    suppressWrite(rel: string, _ms: number, content?: string | Buffer): void {
      watcherLog.calls.push({ rel, content, fileExisted: exists(joinPath(this.root, rel)) });
    }
  }
  return { FileWatcher: FakeFileWatcher };
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

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>());

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { saveConfig } = await import('../../main/vault/configOps');

type Result = { success: boolean; code?: string; error?: string; path?: string };

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} handler not registered`);
  return async (...args: unknown[]) => h({}, ...args);
}

function setMode(mode: AtomicMode): void {
  atomic.mode = mode;
}

describe('exclusive create: the 0-byte placeholder', () => {
  let vaultDir: string;
  let create: (rel: string, content: string) => Promise<Result>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerVaultHandlers();
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-create-placeholder-'));
    vaultRegistry.setCurrentVault(vaultDir);
    await handler('vault:watch')(vaultDir);
    const h = handler('vault:create-file-text');
    create = async (rel, content) => (await h(vaultDir, rel, content)) as Result;
    watcherLog.calls.length = 0;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    setMode('real');
    errSpy.mockRestore();
    await handler('vault:close')();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  describe('vault:create-file-text', () => {
    it('tells the watcher about the write before the placeholder exists', async () => {
      const r = await create('Fresh.md', 'hello\n');
      expect(r.success).toBe(true);
      const calls = watcherLog.calls as SuppressCall[];
      const first = calls.find((c) => c.rel === 'Fresh.md');
      expect(first).toBeDefined();
      expect(first?.fileExisted).toBe(false);
      // The placeholder's own echo (0 bytes) and the written bytes both count as Filo's.
      const announced = calls.filter((c) => c.rel === 'Fresh.md' && !c.fileExisted).map((c) => String(c.content));
      expect(announced).toContain('');
      expect(announced).toContain('hello\n');
      expect(await fs.readFile(join(vaultDir, 'Fresh.md'), 'utf-8')).toBe('hello\n');
    });

    it('a failed write removes the placeholder that is still ours', async () => {
      setMode('fail');
      const r = await create('Fresh.md', 'hello\n');
      expect(r.success).toBe(false);
      expect(existsSync(join(vaultDir, 'Fresh.md'))).toBe(false);
    });

    it("a failed write keeps a file another program put over the placeholder", async () => {
      setMode('replaceThenFail');
      const r = await create('Fresh.md', 'hello\n');
      expect(r.success).toBe(false);
      expect(await fs.readFile(join(vaultDir, 'Fresh.md'), 'utf-8')).toBe('their text\n');
    });

    it('a failed write keeps an empty file another program put there (a different file)', async () => {
      setMode('replaceEmptyThenFail');
      const r = await create('Fresh.md', 'hello\n');
      expect(r.success).toBe(false);
      expect(existsSync(join(vaultDir, 'Fresh.md'))).toBe(true);
    });

    it('never writes over a file another program put at the reserved name; the name counts as taken', async () => {
      setMode('replaceThenReal');
      const r = await create('Fresh.md', 'hello\n');
      expect(r).toMatchObject({ success: false, code: 'EEXIST' });
      expect(await fs.readFile(join(vaultDir, 'Fresh.md'), 'utf-8')).toBe('their text\n');
    });
  });

  describe('config:save { createOnly }', () => {
    const cfg = (): string => join(vaultDir, '.filo', 'defaults.json');

    it('a failed write removes the placeholder that is still ours', async () => {
      setMode('fail');
      await expect(saveConfig(vaultDir, 'defaults.json', '{}', { createOnly: true })).rejects.toBeDefined();
      expect(existsSync(cfg())).toBe(false);
    });

    it('a failed write keeps a copy another program put back', async () => {
      setMode('replaceThenFail');
      await expect(saveConfig(vaultDir, 'defaults.json', '{}', { createOnly: true })).rejects.toBeDefined();
      expect(await fs.readFile(cfg(), 'utf-8')).toBe('their text\n');
    });

    it('never writes over a copy put back at the reserved name, and says EEXIST', async () => {
      setMode('replaceThenReal');
      await expect(saveConfig(vaultDir, 'defaults.json', '{}', { createOnly: true })).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await fs.readFile(cfg(), 'utf-8')).toBe('their text\n');
    });

    it('creates the file when nothing interferes', async () => {
      await saveConfig(vaultDir, 'defaults.json', '{"a":1}', { createOnly: true });
      expect(await fs.readFile(cfg(), 'utf-8')).toBe('{"a":1}');
    });
  });
});

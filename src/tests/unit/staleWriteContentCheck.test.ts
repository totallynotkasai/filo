/**
 * A write over a note names the version it read, and that holds on a coarse
 * timestamp too:
 *  - with the read's content hash, a same-size save by another program that
 *    left the modification time as it was is still refused (STALE);
 *  - "Convert to UTF-8" backs up exactly the bytes it converted and refuses to
 *    write over a version another program saved after its read.
 * Real temp folder, real handlers.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
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

/** Runs just before the convert handler's backup: another program saving meanwhile. */
let beforeSnapshot: (() => Promise<void>) | null = null;

vi.mock('../../main/services/recoverySnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/services/recoverySnapshot')>();
  return {
    ...actual,
    snapshotForRecovery: async (...args: Parameters<typeof actual.snapshotForRecovery>) => {
      await beforeSnapshot?.();
      return actual.snapshotForRecovery(...args);
    },
  };
});

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { registerVaultEncodingHandlers } = await import('../../main/ipc/vaultEncoding.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { __resetNonUtf8RegistryForTests } = await import('../../main/services/nonUtf8Registry');
const { atomicWriteFile, STALE_HASH_MAX_BYTES } = await import('../../main/vault/filenameUtils');
const { fnv1a32 } = await import('../../main/services/fileWatcherHash');

type Result = { success: boolean; code?: string };

function call(channel: string, ...args: unknown[]): Promise<Result> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} handler not registered`);
  return h({}, ...args) as Promise<Result>;
}

const hashOf = (bytes: Buffer): string => fnv1a32(bytes).toString(16).padStart(8, '0');

/** Puts `bytes` in `file` with the modification time a coarse file system would keep: `at`, whole seconds. */
async function saveAt(file: string, bytes: Buffer | string, at: Date): Promise<{ mtimeMs: number; size: number }> {
  await fs.writeFile(file, bytes);
  await fs.utimes(file, at, at);
  const st = await fs.stat(file);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

/** "Réunion — café\n" as Windows-1252. */
const CP1252 = Buffer.from([0x52, 0xe9, 0x75, 0x6e, 0x69, 0x6f, 0x6e, 0x20, 0x97, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]);

let dir: string;
const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));

beforeAll(() => {
  registerVaultHandlers();
  registerVaultEncodingHandlers();
});

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'filo-stale-hash-'));
  vaultRegistry.setCurrentVault(dir);
  __resetNonUtf8RegistryForTests();
  beforeSnapshot = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vaultRegistry.setCurrentVault(null);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the content hash on a write over a note', () => {
  it('refuses a same-size save that kept the stat, and writes over the version it read', async () => {
    const file = join(dir, 'Note.md');
    const read = await saveAt(file, 'version A\n', at);
    const readHash = hashOf(Buffer.from('version A\n'));
    const other = await saveAt(file, 'version B\n', at);
    expect(other).toEqual(read);

    await expect(atomicWriteFile(file, 'mine\n', { expectStat: { ...read, hash: readHash } })).rejects.toMatchObject({ code: 'STALE' });
    expect(await fs.readFile(file, 'utf-8')).toBe('version B\n');

    await atomicWriteFile(file, 'mine\n', { expectStat: { ...other, hash: hashOf(Buffer.from('version B\n')) } });
    expect(await fs.readFile(file, 'utf-8')).toBe('mine\n');
  });

  it('holds for a large note, up to the size limit; past it the stat alone is checked', async () => {
    const file = join(dir, 'Large.md');
    const large = (fill: string): Buffer => Buffer.alloc(10 * 1024 * 1024, fill);
    const read = await saveAt(file, large('a'), at);
    await saveAt(file, large('b'), at);
    await expect(atomicWriteFile(file, 'mine\n', { expectStat: { ...read, hash: hashOf(large('a')) } })).rejects.toMatchObject({ code: 'STALE' });
    expect((await fs.readFile(file)).subarray(0, 1).toString()).toBe('b');

    const huge = (fill: string): Buffer => Buffer.alloc(STALE_HASH_MAX_BYTES + 1, fill);
    const hugeRead = await saveAt(file, huge('a'), at);
    await saveAt(file, huge('b'), at);
    await atomicWriteFile(file, 'mine\n', { expectStat: { ...hugeRead, hash: hashOf(huge('a')) } });
    expect(await fs.readFile(file, 'utf-8')).toBe('mine\n');
  });

  it('the note write channel carries it through', async () => {
    const file = join(dir, 'Note.md');
    const read = await saveAt(file, 'version A\n', at);
    await saveAt(file, 'version B\n', at);
    const r = await call('vault:write-existing-file-text', dir, 'Note.md', 'mine\n', { ...read, hash: hashOf(Buffer.from('version A\n')) });
    expect(r).toMatchObject({ success: false, code: 'STALE' });
    expect(await fs.readFile(file, 'utf-8')).toBe('version B\n');
  });
});

describe('Convert to UTF-8', () => {
  it('backs up the bytes it read and leaves a version saved after its read alone', async () => {
    const file = join(dir, 'Legacy.md');
    await saveAt(file, CP1252, at);
    // Another program saves a same-size version between the read and the backup.
    const theirs = Buffer.from(CP1252);
    theirs[0] = 0x4c;
    beforeSnapshot = async () => {
      await saveAt(file, theirs, at);
    };

    const r = await call('vault:convert-to-utf8', dir, 'Legacy.md');
    expect(r).toMatchObject({ success: false, code: 'STALE' });
    expect(Buffer.compare(await fs.readFile(file), theirs)).toBe(0);

    const root = join(dir, '.filo', 'recovery');
    const [snapDir] = await fs.readdir(root);
    const [copy] = await fs.readdir(join(root, snapDir ?? ''));
    expect(Buffer.compare(await fs.readFile(join(root, snapDir ?? '', copy ?? '')), CP1252)).toBe(0);
  });
});

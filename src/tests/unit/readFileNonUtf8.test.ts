import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Audit-19 ERR-7 — non-UTF-8 notes are detected, never overwritten, and only
 * rewritten by the explicit convert action (after a backup).
 *
 * `fs.readFile(p, 'utf-8')` used to replace every invalid byte with U+FFFD, and
 * the first write of any kind persisted the damage. Real temp dir, real
 * handlers.
 *
 * Bite: make `readFileWithCoherentStat` report 'utf-8' unconditionally → the
 * encoding + both write-refusal cases go red (the 1252 bytes are overwritten).
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
const { registerVaultEncodingHandlers } = await import('../../main/ipc/vaultEncoding.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { __resetNonUtf8RegistryForTests } = await import('../../main/services/nonUtf8Registry');
const { readFileWithCoherentStat } = await import('../../main/vault/fileOps');

type Result = { success: boolean; code?: string; content?: string; encoding?: string; converted?: boolean };

/** "Réunion — café\n" encoded as Windows-1252 (0xE9 = é, 0x97 = em dash). */
const CP1252_BYTES = Buffer.from([
  0x52, 0xe9, 0x75, 0x6e, 0x69, 0x6f, 0x6e, 0x20, 0x97, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a,
]);

function call(channel: string, ...args: unknown[]): Promise<Result> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} handler not registered`);
  return h({}, ...args) as Promise<Result>;
}

async function listRecoveryFiles(vaultDir: string): Promise<string[]> {
  const root = join(vaultDir, '.filo', 'recovery');
  const out: string[] = [];
  for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
    const abs = join(root, dir);
    if ((await fs.stat(abs)).isDirectory()) {
      for (const f of await fs.readdir(abs)) out.push(join(abs, f));
    }
  }
  return out;
}

describe('readFileWithCoherentStat encoding (Audit-19 ERR-7)', () => {
  it('reports invalid-utf-8 for Windows-1252 bytes and utf-8 for valid text', async () => {
    const stat = async () => ({ mtimeMs: 1, size: CP1252_BYTES.length });
    const bad = await readFileWithCoherentStat('/v/a.md', 1_000_000, { stat, readFile: async () => CP1252_BYTES });
    const good = await readFileWithCoherentStat('/v/b.md', 1_000_000, {
      stat,
      readFile: async () => Buffer.from('Réunion\n', 'utf-8'),
    });
    if ('tooLarge' in bad || 'tooLarge' in good) throw new Error('unexpected tooLarge');
    expect(bad.encoding).toBe('invalid-utf-8');
    expect(good.encoding).toBe('utf-8');
    expect(good.content).toBe('Réunion\n');
  });
});

describe('vault text channels vs a non-UTF-8 note (Audit-19 ERR-7)', () => {
  let vaultDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerVaultHandlers();
    registerVaultEncodingHandlers();
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-non-utf8-'));
    vaultRegistry.setCurrentVault(vaultDir);
    __resetNonUtf8RegistryForTests();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.writeFile(join(vaultDir, 'Legacy.md'), CP1252_BYTES);
  });

  afterEach(async () => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    __resetNonUtf8RegistryForTests();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('read reports the encoding; both text writes refuse with NOT_UTF8 and leave the bytes alone', async () => {
    const read = await call('vault:read-file-text', vaultDir, 'Legacy.md');
    expect(read.success).toBe(true);
    expect(read.encoding).toBe('invalid-utf-8');
    // The decoded text carries U+FFFD — exactly what a write would persist.
    expect(read.content).toContain('�');

    const existing = await call('vault:write-existing-file-text', vaultDir, 'Legacy.md', read.content);
    expect(existing).toMatchObject({ success: false, code: 'NOT_UTF8' });
    const plain = await call('vault:write-file-text', vaultDir, 'Legacy.md', read.content);
    expect(plain).toMatchObject({ success: false, code: 'NOT_UTF8' });

    expect(Buffer.compare(await fs.readFile(join(vaultDir, 'Legacy.md')), CP1252_BYTES)).toBe(0);
  });

  it('a valid UTF-8 note reads as utf-8 and still writes normally', async () => {
    await fs.writeFile(join(vaultDir, 'Fine.md'), 'Réunion\n', 'utf-8');
    const read = await call('vault:read-file-text', vaultDir, 'Fine.md');
    expect(read.encoding).toBe('utf-8');
    const w = await call('vault:write-existing-file-text', vaultDir, 'Fine.md', 'Réunion — edited\n');
    expect(w.success).toBe(true);
    expect(await fs.readFile(join(vaultDir, 'Fine.md'), 'utf-8')).toBe('Réunion — edited\n');
  });

  it('convert decodes Windows-1252, backs up the original, and unblocks writes', async () => {
    await call('vault:read-file-text', vaultDir, 'Legacy.md');
    const r = await call('vault:convert-to-utf8', vaultDir, 'Legacy.md');
    expect(r).toMatchObject({ success: true, converted: true });
    expect(await fs.readFile(join(vaultDir, 'Legacy.md'), 'utf-8')).toBe('Réunion — café\n');

    const backups = await listRecoveryFiles(vaultDir);
    expect(backups).toHaveLength(1);
    expect(Buffer.compare(await fs.readFile(backups[0]), CP1252_BYTES)).toBe(0);

    const w = await call('vault:write-existing-file-text', vaultDir, 'Legacy.md', 'Réunion — edited\n');
    expect(w.success).toBe(true);
  });

  it('refuses to convert UTF-16 (it would come out as garbage)', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hi\n', 'utf16le')]);
    await fs.writeFile(join(vaultDir, 'Wide.md'), utf16);
    const r = await call('vault:convert-to-utf8', vaultDir, 'Wide.md');
    expect(r).toMatchObject({ success: false, code: 'UTF16' });
    expect(Buffer.compare(await fs.readFile(join(vaultDir, 'Wide.md')), utf16)).toBe(0);
    expect(await listRecoveryFiles(vaultDir)).toHaveLength(0);
  });

  it('an already-valid file is left untouched by convert', async () => {
    await fs.writeFile(join(vaultDir, 'Fine.md'), 'plain\n', 'utf-8');
    const r = await call('vault:convert-to-utf8', vaultDir, 'Fine.md');
    expect(r).toMatchObject({ success: true, converted: false });
    expect(await listRecoveryFiles(vaultDir)).toHaveLength(0);
  });
});

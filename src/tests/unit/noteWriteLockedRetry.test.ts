/**
 * A note write that meets a lock (EBUSY: a sync client, antivirus) must reach
 * the note writer as a lock, so the change is kept and Retry writes it. The
 * note write channels used to fold every errno into IO_ERROR, which the note
 * writer doesn't keep: Retry did nothing and the change stayed failed.
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
    removeHandler: () => {},
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => '' },
}));

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { __setMachineIdentityForTests } = await import('../../main/services/machineIdentity');
const { vaultPath } = await import('@shared/vaultPath');
const { createNoteWriter } = await import('../../renderer/lib/notes/noteWriter');
const { readNoteText, snapshotOf } = await import('../../renderer/lib/notes/noteFile');
const { beginVaultGeneration, __resetVaultIdentityForTests } = await import('../../renderer/lib/vault/vaultIdentity');
const { __resetDirtyTrackingForTests, retryAllFailedWrites, unsavedWork, isUnsavedWorkEmpty } = await import(
  '../../renderer/lib/boards/writeStateTracking'
);
const { installMemoryVault } = await import('../helpers/memoryVault');
const { restoreFiloDefault } = await import('../helpers/filoBridge');

type Result = { success: boolean; code?: string };

function call(channel: string, ...args: unknown[]): Promise<Result> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} handler not registered`);
  return h({}, ...args) as Promise<Result>;
}

const ebusy = (): Error => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });

describe('note write channels keep the errno', () => {
  let vaultDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => registerVaultHandlers());

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-note-lock-'));
    vaultRegistry.setCurrentVault(vaultDir);
    await fs.writeFile(join(vaultDir, 'A.md'), 'One\n', 'utf-8');
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    __setMachineIdentityForTests(null);
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('a locked file answers EBUSY, not IO_ERROR', async () => {
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(ebusy());
    expect(await call('vault:write-existing-file-text', vaultDir, 'A.md', 'Two\n')).toMatchObject({ success: false, code: 'EBUSY' });
    // The blind channel writes only this machine's sentinels; its errno passes through too.
    __setMachineIdentityForTests({ machineId: 'aaaaaaaaaaaa', hostname: 'A' });
    vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(ebusy());
    expect(await call('vault:write-file-text', vaultDir, '.filo/.dirty.aaaaaaaaaaaa', 'x')).toMatchObject({ success: false, code: 'EBUSY' });
  });

  it('a file already gone still answers ENOENT, and a taken name EEXIST', async () => {
    expect(await call('vault:write-existing-file-text', vaultDir, 'Gone.md', 'x')).toMatchObject({ success: false, code: 'ENOENT' });
    expect(await call('vault:create-file-text', vaultDir, 'A.md', 'x')).toMatchObject({ success: false, code: 'EEXIST' });
  });
});

describe('the note writer keeps a locked write for Retry', () => {
  afterEach(() => {
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('Retry writes the change once the lock is gone', async () => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    beginVaultGeneration('/vault');
    const vault = installMemoryVault({ 'A.md': '---\ntitle: A\n---\nOne\n' });
    const bases = new Map([[vaultPath('A.md'), snapshotOf(readNoteText(vault.read('A.md') ?? ''))]]);
    const writer = createNoteWriter({
      vaultRoot: () => vault.root,
      baseOf: (p) => bases.get(p),
      hadFrontmatter: () => true,
      canWriteBody: () => true,
      onBodyConflict: () => undefined,
      onTargetMissing: () => undefined,
      onWritten: (p, _rel, _text, snapshot) => {
        bases.set(p, snapshot);
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let locked = true;
    const invoke = window.filo.invoke as (c: string, ...a: unknown[]) => Promise<unknown>;
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:write-existing-file-text' && locked) return { success: false, code: 'EBUSY', error: 'locked' };
      return invoke(channel, ...args);
    }) as typeof window.filo.invoke;

    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(false);
    expect(unsavedWork().failed).toEqual(['a.md']);

    locked = false;
    expect((await retryAllFailedWrites()).failed).toEqual([]);
    expect(vault.read('A.md')).toContain('status: open');
    expect(isUnsavedWorkEmpty(unsavedWork())).toBe(true);
    writer.reset();
  });
});

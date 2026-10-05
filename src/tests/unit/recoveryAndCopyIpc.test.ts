/**
 * Main's side of rescue copies and Settings → Recovery:
 *
 * - `vault:copy-file` copies a file the user dragged or picked out of
 *   `.filo/recovery` or `.filo/trash` back into the vault, and nothing else
 *   from `.filo/`;
 * - `recovery:keep-unsaved` checks and writes each item on its own, so one
 *   bad name doesn't cost every other rescue copy;
 * - `recovery:open` and `recovery:delete` reach only copies in
 *   `.filo/recovery`; a delete goes to the Recycle Bin, and for good only
 *   when asked;
 * - `releaseActiveVault` lets the vault go, as a crash Reload needs.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
const opened: string[] = [];
const recycled: string[] = [];
const shellState = { openResult: '', recycleRefuses: false };

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
  shell: {
    openExternal: async () => {},
    openPath: async (p: string) => {
      opened.push(p);
      return shellState.openResult;
    },
    trashItem: async (p: string) => {
      if (shellState.recycleRefuses) throw new Error('The Recycle Bin is not available here');
      recycled.push(p);
      fs.rmSync(p, { force: true });
    },
  },
}));

const { registerVaultHandlers, releaseActiveVault } = await import('../../main/ipc/vault.ipc');
const { registerVaultCopyHandlers } = await import('../../main/ipc/vaultCopy.ipc');
const { registerRecoveryHandlers } = await import('../../main/ipc/recovery.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { registerApprovedSource, __resetApprovedSourcesForTests } = await import('../../main/services/approvedSources');

type Result = { ok?: boolean; success?: boolean; code?: string; [k: string]: unknown };
function call(channel: string, ...args: unknown[]): Promise<Result> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} not registered`);
  return h({}, ...args) as Promise<Result>;
}

let vault: string;
let errSpy: ReturnType<typeof vi.spyOn>;

function put(rel: string, text: string): string {
  const abs = path.join(vault, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

beforeAll(() => {
  registerVaultHandlers();
  registerVaultCopyHandlers();
  registerRecoveryHandlers();
});

beforeEach(() => {
  vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'filo-recovery-ipc-')));
  vaultRegistry.setCurrentVault(vault);
  __resetApprovedSourcesForTests();
  opened.length = 0;
  recycled.length = 0;
  shellState.openResult = '';
  shellState.recycleRefuses = false;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vaultRegistry.setCurrentVault(null);
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('vault:copy-file from .filo', () => {
  it('copies a rescue copy the user dragged out of .filo/recovery into the vault', async () => {
    const src = put('.filo/recovery/2026-10-01T10-00-00.000-unsaved/Notes__Draft.md', 'Recovered\n');
    registerApprovedSource(src);
    const res = await call('vault:copy-file', src, vault, '');
    expect(res).toMatchObject({ success: true, relativePath: 'Notes__Draft.md' });
    expect(fs.readFileSync(path.join(vault, 'Notes__Draft.md'), 'utf-8')).toBe('Recovered\n');
  });

  it('copies a trashed note the user picked out of .filo/trash', async () => {
    const src = put('.filo/trash/abc/files/Old.md', 'Old\n');
    registerApprovedSource(src);
    expect(await call('vault:copy-file', src, vault, 'Board')).toMatchObject({ success: true, relativePath: 'Board/Old.md' });
  });

  it('refuses the same copy when the user never chose it (the renderer named it)', async () => {
    const src = put('.filo/recovery/2026-10-01T10-00-00.000-unsaved/Notes__Draft.md', 'Recovered\n');
    expect(await call('vault:copy-file', src, vault, '')).toMatchObject({ success: false, code: 'FORBIDDEN' });
  });

  it("refuses Filo's own state even when the user dragged it", async () => {
    const src = put('.filo/app.json', '{}');
    registerApprovedSource(src);
    expect(await call('vault:copy-file', src, vault, '')).toMatchObject({ success: false, code: 'FORBIDDEN' });
  });
});

describe('recovery:keep-unsaved, item by item', () => {
  it('a name the check refuses fails alone; a note shown from inside .filo is kept under a _filo__ name', async () => {
    const res = await call('recovery:keep-unsaved', vault, [
      { relPath: 'Chapter.md', text: 'typed in Chapter' },
      { relPath: '../outside.md', text: 'never written' },
      { relPath: '.filo/recovery/2026-10-01T10-00-00.000-unsaved/Notes__Draft.md', text: 'typed in the rescue copy' },
    ]);
    expect(res.ok).toBe(true);
    expect(res.kept).toEqual(['Chapter.md', '.filo/recovery/2026-10-01T10-00-00.000-unsaved/Notes__Draft.md']);
    expect(res.failed).toEqual(['../outside.md']);
    const dir = path.join(vault, ...(res.dir as string).split('/'));
    expect(fs.readdirSync(dir).sort()).toEqual(['Chapter.md', '_filo__recovery__2026-10-01T10-00-00.000-unsaved__Notes__Draft.md']);
    expect(fs.existsSync(path.join(vault, '..', 'outside.md'))).toBe(false);
  });
});

describe('Settings → Recovery: recovery:open and recovery:delete', () => {
  const COPY = '.filo/recovery/2026-10-02T09-30-00.000-keep/Journal.md';

  it('opens a copy in the system app, and says when there is none', async () => {
    const abs = put(COPY, 'kept\n');
    expect(await call('recovery:open', vault, COPY)).toEqual({ ok: true });
    expect(opened).toEqual([abs]);
    shellState.openResult = 'No application is associated with the specified file';
    expect(await call('recovery:open', vault, COPY)).toMatchObject({ ok: false, code: 'NO_APP' });
  });

  it('opens nothing outside .filo/recovery', async () => {
    put('Note.md', 'note\n');
    put('.filo/app.json', '{}');
    for (const rel of ['Note.md', '.filo/app.json', '.filo/recovery/../app.json', '.filo/recovery/x']) {
      expect(await call('recovery:open', vault, rel)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    expect(opened).toEqual([]);
  });

  it('deletes a copy to the Recycle Bin, and its folder once empty', async () => {
    const abs = put(COPY, 'kept\n');
    const other = put('.filo/recovery/2026-10-01T10-00-00.000-unsaved/A.md', 'a\n');
    put('.filo/recovery/2026-10-01T10-00-00.000-unsaved/B.md', 'b\n');
    const res = await call('recovery:delete', vault, [COPY, '.filo/recovery/2026-10-01T10-00-00.000-unsaved/A.md']);
    expect(res).toMatchObject({ ok: true, refused: [], failed: [] });
    expect(recycled).toEqual([abs, other]);
    expect(fs.existsSync(path.dirname(abs))).toBe(false);
    // B is still in its folder, so the folder stays.
    expect(fs.readdirSync(path.dirname(other))).toEqual(['B.md']);
    expect(fs.existsSync(path.join(vault, '.filo', 'recovery'))).toBe(true);
  });

  it('a copy the Recycle Bin refuses stays, until the user asks to delete it for good', async () => {
    const abs = put(COPY, 'kept\n');
    shellState.recycleRefuses = true;
    expect(await call('recovery:delete', vault, [COPY])).toMatchObject({ ok: true, deleted: [], refused: [COPY] });
    expect(fs.existsSync(abs)).toBe(true);
    expect(await call('recovery:delete', vault, [COPY], true)).toMatchObject({ ok: true, deleted: [COPY] });
    expect(fs.existsSync(abs)).toBe(false);
  });

  it('deletes nothing when any path lies outside .filo/recovery', async () => {
    const abs = put(COPY, 'kept\n');
    put('Note.md', 'note\n');
    expect(await call('recovery:delete', vault, [COPY, 'Note.md'])).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.existsSync(path.join(vault, 'Note.md'))).toBe(true);
  });
});

describe('releaseActiveVault', () => {
  it('lets the vault go and stops its watcher, so another vault can open', async () => {
    expect(await call('vault:watch', vault)).toMatchObject({ success: true });
    await releaseActiveVault();
    expect(vaultRegistry.currentVaultPath).toBeNull();
    expect(await call('vault:reconcile')).toMatchObject({ success: false });
  });
});

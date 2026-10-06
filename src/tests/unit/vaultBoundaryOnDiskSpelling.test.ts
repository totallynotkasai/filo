import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The vault boundary decided on the path as the disk names it, not only as
 * the renderer spelled it. Both holes need hostile code in the renderer:
 *  - `.filo` reached under another name: its 8.3 short name (`FILO~1`, on a
 *    volume that keeps short names) or a junction inside the vault leading
 *    into it. A check on the path as written reads either as an ordinary
 *    folder, so delete, overwrite, rename and trash went through.
 *  - `vault:copy-file` and a junction inside the vault leading out of it: as
 *    the destination it wrote outside the vault (the containment check came
 *    after the copy); as the source it read an outside file in.
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
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => '', trashItem: async () => {} },
}));

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { registerVaultTrashHandlers } = await import('../../main/ipc/vaultTrash.ipc');
const { registerVaultCopyHandlers } = await import('../../main/ipc/vaultCopy.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { registerApprovedSource, __resetApprovedSourcesForTests } = await import('../../main/services/approvedSources');
const { resolveServableMediaPath } = await import('../../main/protocol/mediaPathGuard');

type Result = { success: boolean; code?: string; error?: string };
const call = async (channel: string, ...args: unknown[]): Promise<Result> => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} not registered`);
  return (await h({}, ...args)) as Result;
};

/** Whether this volume gives `.filo` the short name `FILO~1` (Windows with 8.3 names on). */
const shortNamesOn = ((): boolean => {
  if (process.platform !== 'win32') return false;
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-83-probe-'));
  try {
    fs.mkdirSync(path.join(probe, '.filo'));
    return fs.existsSync(path.join(probe, 'FILO~1'));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

const APP_JSON = '{"name":"V"}';
let base: string;
let vault: string;
let outside: string;
let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  registerVaultHandlers();
  registerVaultTrashHandlers();
  registerVaultCopyHandlers();
});

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'filo-boundary-')));
  vault = path.join(base, 'Vault');
  outside = path.join(base, 'Outside');
  fs.mkdirSync(path.join(vault, '.filo'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(vault, '.filo', 'app.json'), APP_JSON);
  fs.writeFileSync(path.join(vault, '.filo', 'cover.png'), 'png bytes');
  fs.writeFileSync(path.join(vault, 'Note.md'), 'my note');
  fs.writeFileSync(path.join(vault, 'evil.bat'), 'echo hi');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  // A junction needs no privileges on Windows; elsewhere it is a folder symlink.
  fs.symlinkSync(path.join(vault, '.filo'), path.join(vault, 'alias'), 'junction');
  fs.symlinkSync(outside, path.join(vault, 'out'), 'junction');
  vaultRegistry.setCurrentVault(vault);
  __resetApprovedSourcesForTests();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  warnSpy.mockRestore();
  vaultRegistry.setCurrentVault(null);
  __resetApprovedSourcesForTests();
  fs.rmSync(base, { recursive: true, force: true });
});

const appJson = (): string => fs.readFileSync(path.join(vault, '.filo', 'app.json'), 'utf8');

describe.each([
  { name: "its 8.3 short name (FILO~1)", alias: 'FILO~1', runs: shortNamesOn },
  { name: 'a junction inside the vault leading into it', alias: 'alias', runs: true },
])('.filo reached through $name', ({ alias, runs }) => {
  it.skipIf(!runs)('vault:delete refuses its app.json', async () => {
    const result = await call('vault:delete', vault, path.join(vault, alias, 'app.json'));
    expect(result.success).toBe(false);
    expect(appJson()).toBe(APP_JSON);
  });

  it.skipIf(!runs)('vault:write-existing-file-text refuses to overwrite it', async () => {
    const result = await call('vault:write-existing-file-text', vault, `${alias}/app.json`, 'clobbered');
    expect(result.success).toBe(false);
    expect(appJson()).toBe(APP_JSON);
  });

  it.skipIf(!runs)('vault:create-file-text refuses a new file in it', async () => {
    const result = await call('vault:create-file-text', vault, `${alias}/new.json`, '{}');
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(vault, '.filo', 'new.json'))).toBe(false);
  });

  it.skipIf(!runs)('vault:rename refuses to move a note into it', async () => {
    const result = await call('vault:rename', vault, path.join(vault, 'Note.md'), path.join(vault, alias, 'Note.md'));
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(vault, '.filo', 'Note.md'))).toBe(false);
    expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('my note');
  });

  it.skipIf(!runs)('vault:trash-move refuses to trash it', async () => {
    const result = await call('vault:trash-move', vault, `${alias}/app.json`);
    expect(result.success).toBe(false);
    expect(appJson()).toBe(APP_JSON);
  });

  it.skipIf(!runs)('filo:// refuses to serve a file from it', () => {
    expect(() => resolveServableMediaPath(vault, `${alias}/cover.png`)).toThrow(/FORBIDDEN/);
  });
});

describe('the ordinary spellings still work', () => {
  it('a note in an ordinary folder is written, and one named like a short name is too', async () => {
    fs.mkdirSync(path.join(vault, 'NOTES~1'));
    fs.writeFileSync(path.join(vault, 'NOTES~1', 'Plan.md'), 'old');
    const created = await call('vault:create-file-text', vault, 'NOTES~1/New.md', 'new note');
    expect(created.success).toBe(true);
    expect(fs.readFileSync(path.join(vault, 'NOTES~1', 'New.md'), 'utf8')).toBe('new note');
    const deleted = await call('vault:delete', vault, path.join(vault, 'NOTES~1', 'Plan.md'));
    expect(deleted.success).toBe(true);
  });
});

describe('vault:copy-file and a junction inside the vault leading out of it', () => {
  it('never writes outside the vault through a junction destination', async () => {
    const result = await call('vault:copy-file', path.join(vault, 'evil.bat'), vault, 'out');
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(outside, 'evil.bat'))).toBe(false);
  });

  it('never copies an outside file in through a junction source', async () => {
    const result = await call('vault:copy-file', path.join(vault, 'out', 'secret.txt'), vault);
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(vault, 'secret.txt'))).toBe(false);
  });

  it('copies the same file when the user chose it (a drop or the file dialog)', async () => {
    registerApprovedSource(path.join(vault, 'out', 'secret.txt'));
    const result = await call('vault:copy-file', path.join(vault, 'out', 'secret.txt'), vault);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(vault, 'secret.txt'), 'utf8')).toBe('outside secret');
  });

  it('copies an ordinary vault file into an ordinary folder', async () => {
    const result = await call('vault:copy-file', path.join(vault, 'evil.bat'), vault, 'attachments');
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(vault, 'attachments', 'evil.bat'), 'utf8')).toBe('echo hi');
  });
});

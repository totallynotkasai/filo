import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Main registers the vault root canonical, and `assertWithinVault` accepts a
 * target spelled another way (an 8.3 short name, a junction) when the
 * canonical forms match. The `.filo/` guards then need a vault-relative path:
 * taken lexically from the canonical root and the other spelling, it comes
 * out as `../../link/Vault/.filo/…`, which reads as outside `.filo/`. Each
 * handler must compute it from the pair containment was decided on. A
 * junction stands in for the 8.3 alias (both are the same folder spelled
 * another way, and a junction needs no admin rights).
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
const { registerVaultCopyHandlers } = await import('../../main/ipc/vaultCopy.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { registerApprovedSource, __resetApprovedSourcesForTests } = await import('../../main/services/approvedSources');
const { vaultRelativeWithin } = await import('../../main/utils/pathSecurity');

type Handler = (...args: unknown[]) => Promise<{ success: boolean; code?: string; error?: string }>;
function handler(channel: string): Handler {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} not registered`);
  return h as Handler;
}

let base: string;
let realVault: string;
let viaLink: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  registerVaultHandlers();
  registerVaultCopyHandlers();
});

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'filo-filo-guard-')));
  fs.mkdirSync(path.join(base, 'real', 'Vault', '.filo'), { recursive: true });
  fs.writeFileSync(path.join(base, 'real', 'Vault', '.filo', 'app.json'), '{"name":"V"}');
  fs.writeFileSync(path.join(base, 'real', 'Vault', 'Note.md'), 'note');
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'), 'junction');
  realVault = path.join(base, 'real', 'Vault');
  viaLink = path.join(base, 'link', 'Vault');
  vaultRegistry.setCurrentVault(realVault);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vaultRegistry.setCurrentVault(null);
  __resetApprovedSourcesForTests();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the .filo/ guards see through another spelling of the vault', () => {
  it('vault:rename refuses to move a .filo/ file named through the other spelling', async () => {
    const result = await handler('vault:rename')({}, realVault, path.join(viaLink, '.filo', 'app.json'), path.join(realVault, 'app.json'));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/FORBIDDEN/);
    expect(fs.existsSync(path.join(realVault, '.filo', 'app.json'))).toBe(true);
    expect(fs.existsSync(path.join(realVault, 'app.json'))).toBe(false);
  });

  it('vault:rename refuses to move a note into .filo/ through the other spelling', async () => {
    const result = await handler('vault:rename')({}, realVault, path.join(realVault, 'Note.md'), path.join(viaLink, '.filo', 'app.json'));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/FORBIDDEN/);
    expect(fs.readFileSync(path.join(realVault, '.filo', 'app.json'), 'utf8')).toBe('{"name":"V"}');
  });

  it('vault:delete refuses a .filo/ file named through the other spelling', async () => {
    const result = await handler('vault:delete')({}, realVault, path.join(viaLink, '.filo', 'app.json'));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/FORBIDDEN/);
    expect(fs.existsSync(path.join(realVault, '.filo', 'app.json'))).toBe(true);
  });

  it('vault:copy-file refuses a picked source inside .filo/ named through the other spelling', async () => {
    const source = path.join(viaLink, '.filo', 'app.json');
    registerApprovedSource(source);

    const result = await handler('vault:copy-file')({}, source, realVault, 'Imports');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/FORBIDDEN/);
    expect(fs.existsSync(path.join(realVault, 'Imports'))).toBe(false);
  });

  it('a rename between two ordinary names still works through the other spelling', async () => {
    const result = await handler('vault:rename')({}, realVault, path.join(viaLink, 'Note.md'), path.join(realVault, 'Renamed.md'));

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(realVault, 'Renamed.md'), 'utf8')).toBe('note');
  });
});

describe('vaultRelativeWithin', () => {
  it('gives the path inside the vault whichever spelling each side uses', () => {
    expect(vaultRelativeWithin(realVault, path.join(viaLink, '.filo', 'app.json'))).toBe('.filo/app.json');
    expect(vaultRelativeWithin(viaLink, path.join(realVault, 'Sub', 'New.md'))).toBe('Sub/New.md');
    expect(vaultRelativeWithin(realVault, realVault)).toBe('');
  });

  it('refuses a path outside the vault', () => {
    expect(() => vaultRelativeWithin(realVault, path.join(base, 'elsewhere.md'))).toThrow(/outside vault/);
    expect(() => vaultRelativeWithin(realVault, path.join(viaLink, '..', 'x.md'))).toThrow(/outside vault/);
  });
});

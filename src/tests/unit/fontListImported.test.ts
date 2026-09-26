import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * `font:list-imported` hands the renderer the bytes of every font in the
 * active vault's `.filo/fonts/`, so the fonts can be registered again on
 * each vault open (a `FontFace` doesn't outlive the page).
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

let activeVault: string | null = null;
vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
  getVaultRoot: () => activeVault,
}));

const { registerFontHandlers } = await import('../../main/ipc/fonts.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

const TTF_MAGIC = Buffer.from([0x00, 0x01, 0x00, 0x00]);

interface ListResult {
  success: boolean;
  fonts: { name: string; path: string; dataBase64: string }[];
  error?: string;
}

describe('font:list-imported', () => {
  let vaultDir: string;
  let list: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerFontHandlers();
    const h = handlers.get('font:list-imported');
    if (!h) throw new Error('font:list-imported handler not registered');
    list = h;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-fontlist-'));
    vaultRegistry.setCurrentVault(vaultDir);
    activeVault = vaultDir;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vaultRegistry.setCurrentVault(null);
    activeVault = null;
    errSpy?.mockRestore();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('returns each font file with its name and bytes', async () => {
    const fontsDir = join(vaultDir, '.filo', 'fonts');
    await fs.mkdir(fontsDir, { recursive: true });
    const bytes = Buffer.concat([TTF_MAGIC, Buffer.from('rest of the font')]);
    await fs.writeFile(join(fontsDir, 'My Font.ttf'), bytes);

    const result = (await list({}, vaultDir)) as ListResult;
    expect(result.success).toBe(true);
    expect(result.fonts.map((f) => f.name)).toEqual(['My Font']);
    expect(Buffer.from(result.fonts[0].dataBase64, 'base64').equals(bytes)).toBe(true);
  });

  it('skips files that are not fonts, by extension or by content', async () => {
    const fontsDir = join(vaultDir, '.filo', 'fonts');
    await fs.mkdir(fontsDir, { recursive: true });
    await fs.writeFile(join(fontsDir, 'notes.txt'), TTF_MAGIC);
    await fs.writeFile(join(fontsDir, 'Renamed.ttf'), 'plain text, not a font');
    await fs.writeFile(join(fontsDir, 'Real.otf'), Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(8)]));

    const result = (await list({}, vaultDir)) as ListResult;
    expect(result.fonts.map((f) => f.name)).toEqual(['Real']);
  });

  it('answers an empty list when the vault has no fonts folder', async () => {
    const result = (await list({}, vaultDir)) as ListResult;
    expect(result).toEqual({ success: true, fonts: [] });
  });

  it('refuses a vault that is not the open one', async () => {
    const result = (await list({}, join(vaultDir, 'elsewhere'))) as ListResult;
    expect(result.success).toBe(false);
    expect(result.fonts).toEqual([]);
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Phase 4 / 4.3 — `font:import` must use `atomicWriteFile` AND a
 * collision-suffix loop. Pre-fix, the handler called `fs.copyFile`
 * directly which (a) was not crash-safe (a power loss mid-copy could
 * leave a torn font file that the OS would refuse to load) and (b)
 * silently overwrote any existing font of the same filename.
 *
 * The fix routes the copy through `uniqueFilePath` (collision suffix —
 * `My Font.otf` → `My Font (2).otf`) and `atomicWriteFile` (tmp-then-
 * rename pipeline) to make the import path safe across both axes.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

// Generate a minimal TTF magic-byte buffer to satisfy the font:import
// magic-check (the handler rejects anything whose first 4 bytes don't
// match a recognised font format).
function ttfMagicBuffer(extraBytes: number = 0): Buffer {
  const head = Buffer.from([0x00, 0x01, 0x00, 0x00]); // TTF magic
  return Buffer.concat([head, Buffer.alloc(extraBytes)]);
}

let dialogPickedPaths: string[] = [];

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
  },
  dialog: {
    showOpenDialog: async () => ({
      canceled: dialogPickedPaths.length === 0,
      filePaths: dialogPickedPaths,
    }),
  },
}));

let activeVault: string | null = null;
vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
  getVaultRoot: () => activeVault,
}));

const { registerFontHandlers } = await import('../../main/ipc/fonts.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('font:import — collision suffix + atomic write (Phase 4 / 4.3)', () => {
  let vaultDir: string;
  let sourceDir: string;
  let importHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerFontHandlers();
    const h = handlers.get('font:import');
    if (!h) throw new Error('font:import handler not registered');
    importHandler = h;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-fonts-'));
    sourceDir = await fs.mkdtemp(join(tmpdir(), 'filo-fontsrc-'));
    vaultRegistry.setCurrentVault(vaultDir);
    activeVault = vaultDir;
    dialogPickedPaths = [];
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vaultRegistry.setCurrentVault(null);
    activeVault = null;
    errSpy?.mockRestore();
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  it('appends a (2) suffix when a font with the same filename already exists', async () => {
    const srcA = join(sourceDir, 'MyFont.ttf');
    await fs.writeFile(srcA, ttfMagicBuffer(64));

    // First import — lands as MyFont.ttf.
    dialogPickedPaths = [srcA];
    const first = (await importHandler({}, vaultDir)) as { success: boolean };
    expect(first.success).toBe(true);

    // Second import of a different source file with the same filename
    // — the handler must rename to MyFont (2).ttf, not overwrite.
    const srcB = join(sourceDir, 'MyFont.ttf'); // same path, new content
    await fs.writeFile(srcB, ttfMagicBuffer(128)); // different size payload
    dialogPickedPaths = [srcB];
    const second = (await importHandler({}, vaultDir)) as {
      success: boolean;
      fonts: { name: string; path: string }[];
    };
    expect(second.success).toBe(true);
    expect(second.fonts).toHaveLength(1);
    expect(second.fonts[0].path.endsWith('MyFont (2).ttf')).toBe(true);

    // Both files now exist in the fonts dir, with their respective contents.
    const fontsDir = join(vaultDir, '.filo', 'fonts');
    const entries = await fs.readdir(fontsDir);
    expect(entries).toContain('MyFont.ttf');
    expect(entries).toContain('MyFont (2).ttf');

    const firstSize = (await fs.stat(join(fontsDir, 'MyFont.ttf'))).size;
    const secondSize = (await fs.stat(join(fontsDir, 'MyFont (2).ttf'))).size;
    expect(firstSize).not.toBe(secondSize);
  });

  it('leaves no .tmp sibling after a successful import (atomic-write contract)', async () => {
    const src = join(sourceDir, 'OneShot.ttf');
    await fs.writeFile(src, ttfMagicBuffer(64));

    dialogPickedPaths = [src];
    const result = (await importHandler({}, vaultDir)) as { success: boolean };
    expect(result.success).toBe(true);

    const fontsDir = join(vaultDir, '.filo', 'fonts');
    const entries = await fs.readdir(fontsDir);
    expect(entries).toContain('OneShot.ttf');
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});

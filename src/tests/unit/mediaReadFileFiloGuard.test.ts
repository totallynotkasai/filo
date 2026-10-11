import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * `media:read-file` was the only vault READ channel taking a
 * renderer-supplied relative path that omitted `assertNotInFiloDir`, so a
 * renderer could call `media:read-file('.filo/themes/x.svg')`. Not currently
 * exploitable (every sensitive `.filo/` file is JSON/font → octet-stream →
 * refused by the MIME allowlist), but the channel must enforce its OWN
 * containment instead of leaning on an adjacent control. The fix mirrors
 * `media:save-audio`.
 *
 * Bite-verify: an SVG is a READABLE MIME type (`image/svg+xml`), so the MIME
 * allowlist does NOT refuse it — the ONLY thing that can is the `.filo/` guard.
 * Remove `assertNotInFiloDir` from the handler → the first spec goes green-
 * through (the `.filo/` SVG read succeeds).
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
  },
  shell: { openExternal: async () => {}, openPath: async () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
  getVaultRoot: () => null,
}));

const { registerMediaHandlers } = await import('../../main/ipc/media.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('media:read-file — .filo/ read guard', () => {
  let vaultDir: string;
  let readHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerMediaHandlers();
    const h = handlers.get('media:read-file');
    if (!h) throw new Error('media:read-file handler not registered');
    readHandler = h;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-media-read-filo-'));
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    vi.restoreAllMocks();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('refuses to read a readable media type (SVG) from inside .filo/', async () => {
    await fs.mkdir(join(vaultDir, '.filo', 'themes'), { recursive: true });
    await fs.writeFile(join(vaultDir, '.filo', 'themes', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const result = (await readHandler({}, vaultDir, '.filo/themes/x.svg')) as {
      success: boolean;
      error?: string;
      data?: string;
    };
    expect(result.success).toBe(false);
    expect(String(result.error ?? '')).toMatch(/FORBIDDEN|\.filo/i);
    // The bytes are never returned.
    expect(result.data).toBeUndefined();
  });

  it('refuses a nested .filo/ path too', async () => {
    const result = (await readHandler({}, vaultDir, '.filo/recovery/snap/x.png')) as {
      success: boolean;
    };
    expect(result.success).toBe(false);
  });

  it('still reads a normal media file outside .filo/', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(join(vaultDir, 'pic.png'), png);

    const result = (await readHandler({}, vaultDir, 'pic.png')) as {
      success: boolean;
      data?: string;
      mimeType?: string;
    };
    expect(result.success).toBe(true);
    expect(result.mimeType).toMatch(/image\/png/i);
    expect(result.data).toBe(png.toString('base64'));
  });

  it('still reads a media file in a normal subfolder named like .filo is not', async () => {
    // `.filofake` must NOT be treated as `.filo` (first-segment exact match).
    await fs.mkdir(join(vaultDir, '.filofake'), { recursive: true });
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    await fs.writeFile(join(vaultDir, '.filofake', 'a.gif'), gif);

    const result = (await readHandler({}, vaultDir, '.filofake/a.gif')) as {
      success: boolean;
      mimeType?: string;
    };
    expect(result.success).toBe(true);
    expect(result.mimeType).toMatch(/image\/gif/i);
  });
});

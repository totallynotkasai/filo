import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * 1.4 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — `media:save-audio` was the only
 * vault-writing IPC handler without `assertNotInFiloDir`, so a buggy renderer
 * passing `destFolder: '.filo'` could drop arbitrary bytes into the config dir
 * (`.filo` itself passes `assertSafeRelativePath` — the stem before the dot is
 * empty — so nothing else stopped it). The fix mirrors `vault:write-file-binary`.
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

describe('media:save-audio — .filo/ write guard (1.4)', () => {
  let vaultDir: string;
  let saveHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const audioB64 = Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64');

  beforeAll(() => {
    registerMediaHandlers();
    const h = handlers.get('media:save-audio');
    if (!h) throw new Error('media:save-audio handler not registered');
    saveHandler = h;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-save-audio-'));
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    vi.restoreAllMocks();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('rejects a write whose destFolder is .filo and writes nothing there', async () => {
    const result = (await saveHandler({}, vaultDir, audioB64, 'app.json', '.filo')) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(String(result.error ?? '')).toMatch(/FORBIDDEN|\.filo/i);

    const wrote = await fs
      .access(join(vaultDir, '.filo', 'app.json'))
      .then(() => true)
      .catch(() => false);
    expect(wrote).toBe(false);
  });

  it('rejects a nested .filo destination', async () => {
    const result = (await saveHandler({}, vaultDir, audioB64, 'x.json', '.filo/sub')) as {
      success: boolean;
    };
    expect(result.success).toBe(false);
  });

  it('still allows a normal vault subfolder', async () => {
    const result = (await saveHandler({}, vaultDir, audioB64, 'rec.wav', 'audio')) as {
      success: boolean;
      path?: string;
    };
    expect(result.success).toBe(true);
    expect(result.path).toBe('audio/rec.wav');
    const bytes = await fs.readFile(join(vaultDir, 'audio', 'rec.wav'));
    expect(bytes.equals(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBe(true);
  });
});

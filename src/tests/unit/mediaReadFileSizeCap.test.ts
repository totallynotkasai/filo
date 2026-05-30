import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * IMPL_PLAN_2026-05-23_v2 P1.4 — `media:read-file` payload cap.
 *
 * Pre-fix, the handler called `fs.promises.readFile(fullPath)` unconditionally
 * and base64-encoded the buffer for return to the renderer. A multi-GB asset
 * (an accidental drag-drop of a raw 4K capture) would balloon to ~1.33×
 * its on-disk size in memory and crash the main process before the renderer
 * ever saw the failure.
 *
 * The fix stats the file first and short-circuits with
 * `{ success: false, code: 'FILE_TOO_LARGE' }` when the on-disk size
 * exceeds `PAYLOAD_LIMITS.MEDIA_READ_INLINE` (25 MB after Sprint C / C20;
 * previously the wider 200 MB MEDIA cap). The buffer is never allocated.
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
  shell: {
    openExternal: async () => {},
    openPath: async () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
  getVaultRoot: () => null,
}));

const { registerMediaHandlers } = await import('../../main/ipc/media.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { PAYLOAD_LIMITS } = await import('../../main/utils/payloadLimits');

describe('media:read-file — payload cap (P1.4)', () => {
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
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-media-read-'));
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    vi.restoreAllMocks();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('returns FILE_TOO_LARGE when the file exceeds the MEDIA_READ_INLINE cap without buffering', async () => {
    // Write a small real file so the path check + mimeType lookup succeeds,
    // then stub the stat to claim the file is over the cap.
    const relPath = 'image.png';
    await fs.writeFile(join(vaultDir, relPath), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const oversizeBytes = PAYLOAD_LIMITS.MEDIA_READ_INLINE + 1024 * 1024; // 1 MB over the cap
    const statSpy = vi
      .spyOn(fs, 'stat')
      .mockImplementation(async () => ({ size: oversizeBytes, isFile: () => true }) as unknown as Awaited<ReturnType<typeof fs.stat>>);

    // Also spy on readFile so we can assert it was never reached.
    const readSpy = vi.spyOn(fs, 'readFile');

    const result = (await readHandler({}, vaultDir, relPath)) as {
      success: boolean;
      code?: string;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.code).toBe('FILE_TOO_LARGE');
    expect(String(result.error ?? '')).toContain(String(oversizeBytes));
    // No allocation of the oversize buffer.
    expect(readSpy).not.toHaveBeenCalled();

    statSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('reads the file when under the cap', async () => {
    const relPath = 'image.png';
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(join(vaultDir, relPath), payload);

    const result = (await readHandler({}, vaultDir, relPath)) as {
      success: boolean;
      data?: string;
      mimeType?: string;
    };

    expect(result.success).toBe(true);
    expect(result.mimeType).toMatch(/image\/png/i);
    expect(result.data).toBe(payload.toString('base64'));
  });
});

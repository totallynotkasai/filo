import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Phase 8 / 8.2 — `export:save` must:
 *   (a) cap the incoming `data` payload at `PAYLOAD_LIMITS.MEDIA` so a
 *       buggy renderer can't ship multi-GB strings through IPC;
 *   (b) refuse to write any export into `<vault>/.filo/` regardless of
 *       what the OS save dialog returns (defence-in-depth — the dialog
 *       is the only point at which the destination becomes concrete).
 *
 * Both checks run *before* the disk write. The test drives the registered
 * handler directly with mocked electron primitives — no Electron, no
 * BrowserWindow, no real native dialog.
 *
 * `PAYLOAD_LIMITS.MEDIA` is mocked down to 64 bytes so the cap test
 * doesn't have to allocate the production 200 MB ceiling on every run.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

let dialogPickedPath: string | null = null;
let dialogCanceled = false;

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
    showSaveDialog: async () => ({
      canceled: dialogCanceled,
      filePath: dialogPickedPath,
    }),
  },
}));

let activeVault: string | null = null;
vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
  getVaultRoot: () => activeVault,
}));

// Mock down to 64 bytes so the over-cap test can use a small payload.
vi.mock('../../main/utils/payloadLimits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../main/utils/payloadLimits')>();
  return {
    ...original,
    PAYLOAD_LIMITS: { ...original.PAYLOAD_LIMITS, MEDIA: 64 },
  };
});

const { registerExportHandlers } = await import('../../main/ipc/export.ipc');

describe('export:save — payload cap + .filo guard (Phase 8 / 8.2)', () => {
  let vaultDir: string;
  let outDir: string;
  let exportHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerExportHandlers();
    const h = handlers.get('export:save');
    if (!h) throw new Error('export:save handler not registered');
    exportHandler = h;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-export-'));
    outDir = await fs.mkdtemp(join(tmpdir(), 'filo-export-out-'));
    activeVault = vaultDir;
    dialogPickedPath = null;
    dialogCanceled = false;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    activeVault = null;
    errSpy?.mockRestore();
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('rejects a payload larger than PAYLOAD_LIMITS.MEDIA before opening the dialog', async () => {
    // 65 bytes > mocked cap of 64. dialogPickedPath stays null so if the
    // cap check fails to fire, no file lands on disk either way.
    const oversize = 'a'.repeat(65);
    dialogPickedPath = join(outDir, 'should-not-be-written.md');

    const result = (await exportHandler({}, 'md', oversize, 'big')) as {
      success: boolean;
      code?: string;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.code).toBe('FILE_TOO_LARGE');
    expect(result.error).toMatch(/cap|too large/i);
    // Confirm the file never landed on disk — the cap fires before the dialog.
    const dirEntries = await fs.readdir(outDir);
    expect(dirEntries).toHaveLength(0);
  });

  it('refuses to write into <vault>/.filo/ even when the dialog returns such a path', async () => {
    // Simulate a buggy renderer that somehow drove the dialog to a path
    // inside .filo (or that the OS dialog returned one).
    const filoTarget = join(vaultDir, '.filo', 'evil.md');
    dialogPickedPath = filoTarget;

    const result = (await exportHandler({}, 'md', 'hello', 'note')) as {
      success: boolean;
      code?: string;
    };

    expect(result.success).toBe(false);
    expect(result.code).toBe('FORBIDDEN');
    // The file must not exist on disk.
    await expect(fs.stat(filoTarget)).rejects.toThrow();
  });

  it('happy path: writes a normal-sized export into a normal destination', async () => {
    const target = join(outDir, 'note.md');
    dialogPickedPath = target;

    const result = (await exportHandler({}, 'md', '# hello', 'note')) as {
      success: boolean;
      path?: string;
    };

    expect(result.success).toBe(true);
    expect(result.path).toBe(target);
    const written = await fs.readFile(target, 'utf-8');
    expect(written).toBe('# hello');
  });

  it('returns canceled (success: false, canceled: true, no error) when the user dismisses the dialog', async () => {
    dialogCanceled = true;
    dialogPickedPath = null;
    const result = (await exportHandler({}, 'md', 'hi', 'note')) as {
      success: boolean;
      canceled?: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    // Audit-18 4.4 — the cancel discriminator lets the renderer treat a
    // dismissed dialog as a no-op instead of toasting "Export failed".
    expect(result.canceled).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('a real write failure stays { success: false } with NO canceled flag', async () => {
    // Point at a path whose parent directory does not exist → fs.writeFile
    // rejects → the catch returns { success: false, error } but NOT canceled,
    // so the renderer DOES surface the error toast (Audit-18 4.4 counter-case).
    dialogCanceled = false;
    dialogPickedPath = join(outDir, 'no-such-subdir', 'note.md');
    const result = (await exportHandler({}, 'md', 'hi', 'note')) as {
      success: boolean;
      canceled?: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.canceled).toBeUndefined();
    expect(typeof result.error).toBe('string');
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Audit-10 B3 — `media:open-external` launcher-blocklist bypass.
 *
 * The local-path branch refuses to hand OS-launcher / scripting / HTML
 * extensions to `shell.openPath`. The original check used
 * `path.extname(target)`, which Win32 / NTFS filename normalisation
 * defeats:
 *
 *   - `evil.exe.`        → `path.extname` = `'.'`          (not blocklisted)
 *   - `evil.exe ` (space)→ `path.extname` = `'.exe '`      (not blocklisted)
 *   - `evil.exe::$DATA`  → `path.extname` = `'.exe::$DATA'` (not blocklisted)
 *
 * The OS strips the trailing dot/space and resolves the ADS suffix, so
 * `shell.openPath` would launch `evil.exe`. `assertWithinVault` realpaths
 * past these (they resolve to the in-vault file) and this channel does NOT
 * run `assertSafeFilename`, so the in-handler blocklist is the only line
 * of defence.
 *
 * The fix routes extension extraction through `launcherExtension` (shared
 * with the renderer slice) and adds a defence-in-depth rejection of any
 * basename with a trailing dot/space or an embedded `:` (NTFS ADS).
 *
 * The test drives the registered handler directly with mocked electron
 * primitives — `shell.openPath` / `shell.openExternal` are recorded so we
 * can assert the dangerous target is NEVER handed to the OS shell.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

const openPathCalls: string[] = [];
const openExternalCalls: string[] = [];

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
    openPath: async (p: string) => {
      openPathCalls.push(p);
      return '';
    },
    openExternal: async (u: string) => {
      openExternalCalls.push(u);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

let activeVault: string | null = null;
vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
  getVaultRoot: () => activeVault,
}));

const { registerMediaHandlers } = await import('../../main/ipc/media.ipc');

describe('media:open-external — launcher-extension blocklist (Audit-10 B3)', () => {
  let vaultDir: string;
  let openExternalHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  /** Build an absolute, POSIX-slashed vault path — mirrors the renderer's
   *  `${normalizePath(vaultRoot)}/${tile.filePath}` so the malicious bytes
   *  reach the handler verbatim. */
  const vaultPath = (name: string): string => `${vaultDir.replace(/\\/g, '/')}/${name}`;

  const callOpen = async (target: string): Promise<{ success: boolean; error?: string }> =>
    (await openExternalHandler({}, target)) as { success: boolean; error?: string };

  beforeAll(() => {
    registerMediaHandlers();
    const h = handlers.get('media:open-external');
    if (!h) throw new Error('media:open-external handler not registered');
    openExternalHandler = h;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-openext-'));
    activeVault = vaultDir;
    openPathCalls.length = 0;
    openExternalCalls.length = 0;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    activeVault = null;
    vi.restoreAllMocks();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  // ── B3 bypasses: were openable under the old path.extname check ──────────

  it('blocks a Win32 trailing-dot executable (evil.exe.)', async () => {
    const result = await callOpen(vaultPath('evil.exe.'));
    expect(result.success).toBe(false);
    expect(openPathCalls).toEqual([]);
  });

  it('blocks a Win32 trailing-space executable (evil.exe )', async () => {
    const result = await callOpen(vaultPath('evil.exe '));
    expect(result.success).toBe(false);
    expect(openPathCalls).toEqual([]);
  });

  it('blocks an NTFS Alternate-Data-Stream executable (evil.exe::$DATA)', async () => {
    const result = await callOpen(vaultPath('evil.exe::$DATA'));
    expect(result.success).toBe(false);
    expect(openPathCalls).toEqual([]);
  });

  it('blocks an HTML-renderable file with a trailing dot (page.html.)', async () => {
    const result = await callOpen(vaultPath('page.html.'));
    expect(result.success).toBe(false);
    expect(openPathCalls).toEqual([]);
  });

  it('blocks an ADS suffix that disguises a safe extension (report.pdf:evil)', async () => {
    // `launcherExtension` reads `.pdf` (safe) here — the basename `:`
    // (ADS) guard is what catches it. Without the guard the OS would open
    // the `evil` data stream of report.pdf.
    const result = await callOpen(vaultPath('report.pdf:evil'));
    expect(result.success).toBe(false);
    expect(openPathCalls).toEqual([]);
  });

  // ── Pre-existing protections must still hold (regression guards) ─────────

  it('still blocks a disguised double extension (report.pdf.exe)', async () => {
    const result = await callOpen(vaultPath('report.pdf.exe'));
    expect(result.success).toBe(false);
    expect(openPathCalls).toEqual([]);
  });

  it('still blocks a case-varied executable (EVIL.EXE)', async () => {
    const result = await callOpen(vaultPath('EVIL.EXE'));
    expect(result.success).toBe(false);
    expect(openPathCalls).toEqual([]);
  });

  it('still blocks plain HTML-renderable files (note.svg)', async () => {
    const result = await callOpen(vaultPath('note.svg'));
    expect(result.success).toBe(false);
    expect(openPathCalls).toEqual([]);
  });

  // ── Safe files still open (positive controls — proves we didn't over-block) ─

  it('opens an ordinary document (report.pdf)', async () => {
    const target = vaultPath('report.pdf');
    const result = await callOpen(target);
    expect(result.success).toBe(true);
    expect(openPathCalls).toEqual([target]);
  });

  it('opens a markdown file (note.md)', async () => {
    const target = vaultPath('subfolder/note.md');
    const result = await callOpen(target);
    expect(result.success).toBe(true);
    expect(openPathCalls).toEqual([target]);
  });

  it('opens an extensionless file (README)', async () => {
    const target = vaultPath('README');
    const result = await callOpen(target);
    expect(result.success).toBe(true);
    expect(openPathCalls).toEqual([target]);
  });

  // ── URL branch is unaffected — sanity that we only touched local paths ───

  it('still routes an https URL through shell.openExternal, not openPath', async () => {
    const result = await callOpen('https://example.com/page');
    expect(result.success).toBe(true);
    expect(openExternalCalls).toEqual(['https://example.com/page']);
    expect(openPathCalls).toEqual([]);
  });
});

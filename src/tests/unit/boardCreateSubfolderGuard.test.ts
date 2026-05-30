import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * IMPL_PLAN_2026-05-23_v2 P0.3 — defence-in-depth for `board:create`.
 *
 * Pre-fix, `createBoardFile` joined the renderer-provided `subfolder` onto
 * `vaultRoot` and ran `atomicWriteFile` BEFORE `assertWithinVault` ran. A
 * renderer-side bug (or compromise) sending `subfolder = '../escape'` would
 * write the JSON outside the vault on disk before the prefix check fires.
 *
 * The fix adds `if (subfolder) assertSafeRelativePath(subfolder)` after
 * `assertActiveVault`. That guard short-circuits on `..`, absolute paths,
 * NUL bytes, and Windows reserved names — no file ever lands on disk.
 */

// ── Mock electron ──
//
// `ipcMain.handle` is captured into a registry so the test can invoke the
// registered handler with synthetic arguments. No real Electron lifecycle
// runs.
const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

// ── Mock vault.ipc watcher ──
//
// board:create reads `getActiveWatcher()` to suppress write echoes; we
// don't exercise that path here.
vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
}));

// Import the handler module under test AFTER the mocks. Use the real
// vaultRegistry — it's just a tiny mutable singleton.
const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('board:create — subfolder path-traversal guard', () => {
  let vaultDir: string;
  let createHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerBoardHandlers();
    const h = handlers.get('board:create');
    if (!h) throw new Error('board:create handler not registered');
    createHandler = h;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-board-create-'));
    vaultRegistry.setCurrentVault(vaultDir);
    // The IPC handler calls `logMainError` on its way to returning
    // `{ ok: false, error }`. That's expected behavior for the failure-path
    // assertions below — but it pollutes the test runner stderr. Swallow
    // it so the test output stays scannable.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('rejects subfolder containing ".." traversal', async () => {
    const result = (await createHandler(
      {} /* _event */,
      vaultDir,
      'EvilBoard',
      { tiles: [], placements: [] },
      '../escape',
    )) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    // Acceptable wordings from the pathSecurity helpers: "traversal denied"
    // (assertWithinVault), "Unsafe filename rejected" (assertSafeFilename
    // catching the `..` segment), or the literal `..` echoed in either.
    expect(String(result.error ?? '')).toMatch(/traversal|denied|unsafe|\.\./i);
  });

  it('does NOT write any file outside the vault when traversal is attempted', async () => {
    // Read the *parent* directory listing before and after the call. Any
    // new entry would mean the write landed outside the vault before the
    // assertion fired — exactly the regression we're guarding against.
    const parent = join(vaultDir, '..');
    const before = new Set(await fs.readdir(parent));
    await createHandler(
      {},
      vaultDir,
      'EvilBoard',
      { tiles: [], placements: [] },
      '../escape',
    );
    const after = await fs.readdir(parent);
    // `parent` is the shared OS temp dir, so OTHER test files running in
    // parallel vitest workers create their own `filo-*` temp vaults in the
    // same window — those are noise, not a traversal escape. Filter them out
    // and assert that no NON-`filo-`-prefixed entry (e.g. the `escape`
    // directory the `../escape` traversal targets) ever lands on disk.
    const added = after.filter((entry) => !before.has(entry) && !entry.startsWith('filo-'));
    expect(added).toEqual([]);
  });

  it('accepts a safe subfolder', async () => {
    // Happy path — pin that the guard doesn't false-positive on a normal
    // nested folder. Asserts the call succeeds and the file lands inside
    // the vault.
    const result = (await createHandler(
      {},
      vaultDir,
      'Project Plan',
      { tiles: [], placements: [] },
      'boards/projects',
    )) as { ok: boolean; path?: string; error?: string };
    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/^boards\/projects\//);
    const created = await fs.stat(join(vaultDir, result.path!));
    expect(created.isFile()).toBe(true);
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * IMPL_PLAN_2026-05-23_v3 Phase B / B.1 — `board:create` must reject Windows
 * reserved DOS device names (CON, NUL, LPT1, etc.) before `createBoardFile`
 * calls `atomicWriteFile`. On Windows, `CON.board.json` opens a console
 * device handle instead of a real file — the write either silently no-ops or
 * hangs the IPC handler. Phase 27 added the same gate to `vault:rename`
 * (Phase 31 A3.6); this fills the gap on the create entry point.
 *
 * Strategy: capture `ipcMain.handle` into a registry mock, invoke the
 * `board:create` handler with reserved names, assert `{ ok: false }`.
 */

// ── Mock electron ──
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

// `board:create` reads `getActiveWatcher()` to suppress write echoes; we
// don't exercise that path here.
vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
}));

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('board:create — Windows reserved name guard', () => {
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
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-board-create-reserved-'));
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it.each([
    ['CON'],
    ['NUL'],
    ['PRN'],
    ['AUX'],
    ['COM1'],
    ['COM9'],
    ['LPT1'],
    ['LPT9'],
    ['con'],   // case-insensitive
    ['nul'],
  ])('rejects reserved DOS name "%s"', async (name) => {
    const result = (await createHandler(
      {} /* _event */,
      vaultDir,
      name,
      { tiles: [], placements: [] },
    )) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(String(result.error ?? '')).toMatch(/unsafe filename|reserved/i);
  });

  it('does NOT write the .board.json file when the name is reserved', async () => {
    await createHandler(
      {},
      vaultDir,
      'CON',
      { tiles: [], placements: [] },
    );
    const entries = await fs.readdir(vaultDir);
    expect(entries).toEqual([]);
  });

  it('accepts a normal board name (regression guard)', async () => {
    const result = (await createHandler(
      {},
      vaultDir,
      'Project Plan',
      { tiles: [], placements: [] },
    )) as { ok: boolean; path?: string; error?: string };
    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/^Project Plan\.board\.json$/);
    const created = await fs.stat(join(vaultDir, result.path!));
    expect(created.isFile()).toBe(true);
  });

  it('accepts names that merely contain a reserved substring', async () => {
    // `controller` contains `CON` as a substring but the stem-before-first-dot
    // is `controller`, not CON — must NOT be rejected.
    const result = (await createHandler(
      {},
      vaultDir,
      'controller',
      { tiles: [], placements: [] },
    )) as { ok: boolean; path?: string };
    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/^controller\.board\.json$/);
  });
});

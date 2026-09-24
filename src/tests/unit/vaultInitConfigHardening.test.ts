import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * IMPL_PLAN_2026-05-25 Phase 1 / 1.2 — vault:init-config hardening.
 *
 * The bootstrap call that anchors the main-process vault registry must
 * refuse three malformed inputs before mutating `vaultRegistry`:
 *
 *   1. An empty (or non-string) `vaultRoot` — would otherwise let a
 *      buggy renderer anchor the registry to "" and every later
 *      `assertActiveVault` would compare against an empty string.
 *   2. A path that isn't a directory — pointing at a missing path or a
 *      file would leave the registry anchored to a phantom vault,
 *      passing every later containment check but with disk writes
 *      landing in an unrelated tree.
 *   3. Re-registration when a different vault is already active — the
 *      close-vault flow must clear the registry first; silent swap
 *      mid-session would let in-flight writes leak to the new vault.
 */

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

vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
}));

const { registerBoardHandlers } = await import('../../main/ipc/board.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('vault:init-config — input hardening', () => {
  let vaultDir: string;
  let otherDir: string;
  let initHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerBoardHandlers();
    const h = handlers.get('vault:init-config');
    if (!h) throw new Error('vault:init-config handler not registered');
    initHandler = h;
  });

  beforeEach(async () => {
    // The registry stores the canonical path, and on Windows tmpdir() can be a
    // short 8.3 name (`RUNNER~1` on the CI runner), so compare against the
    // resolved one.
    vaultDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'filo-init-')));
    otherDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'filo-init-other-')));
    vaultRegistry.setCurrentVault(null);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(otherDir, { recursive: true, force: true });
  });

  it('rejects an empty vaultRoot string', async () => {
    const result = (await initHandler({} /* _event */, '')) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(vaultRegistry.currentVaultPath).toBeNull();
  });

  it('rejects a path that resolves to a file rather than a directory', async () => {
    const filePath = join(vaultDir, 'not-a-dir.txt');
    await fs.writeFile(filePath, 'hello', 'utf-8');
    const result = (await initHandler({}, filePath)) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(String(result.error ?? '')).toMatch(/not a directory/i);
    // Registry must NOT have been mutated.
    expect(vaultRegistry.currentVaultPath).toBeNull();
  });

  it('rejects a path that does not exist', async () => {
    const ghost = join(vaultDir, 'does-not-exist');
    const result = (await initHandler({}, ghost)) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(vaultRegistry.currentVaultPath).toBeNull();
  });

  it('accepts a valid vault directory and anchors the registry', async () => {
    const result = (await initHandler({}, vaultDir)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(vaultRegistry.currentVaultPath).toBe(vaultDir);
  });

  it('refuses to re-anchor when a different vault is already active', async () => {
    // Seed the registry with the first vault — analogous to a normal
    // open-vault bootstrap.
    vaultRegistry.setCurrentVault(vaultDir);
    const result = (await initHandler({}, otherDir)) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(String(result.error ?? '')).toMatch(/different vault|already active/i);
    // Registry stays anchored to the ORIGINAL vault.
    expect(vaultRegistry.currentVaultPath).toBe(vaultDir);
  });

  it('allows re-init of the SAME vault (idempotent bootstrap)', async () => {
    vaultRegistry.setCurrentVault(vaultDir);
    const result = (await initHandler({}, vaultDir)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(vaultRegistry.currentVaultPath).toBe(vaultDir);
  });
});

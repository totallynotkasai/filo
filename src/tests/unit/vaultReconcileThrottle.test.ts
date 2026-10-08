import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Phase 3 / 3.5 — `vault:reconcile`'s per-process throttle (`5 s`) must reset
 * on vault swap. Without the reset, the renderer's focus-driven reconcile
 * fired immediately after opening a new vault is silently dropped if the
 * OLD vault's last reconcile fell inside the 5 s window — and any drift on
 * the new vault stays invisible until the periodic 30s timer fires.
 *
 * The test exercises the throttle directly via the registered handler:
 *   1. vault:reconcile (first call after watch) → runs, lastReconcileAt set.
 *   2. vault:reconcile immediately again → skipped (throttled).
 *   3. vault:watch with the (same) vault → throttle reset by Phase 3 / 3.5.
 *   4. vault:reconcile immediately → runs again, NOT skipped.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
  },
}));

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('vault:reconcile — throttle resets on vault swap (Phase 3 / 3.5)', () => {
  let vaultDir: string;
  let watchHandler: (...args: unknown[]) => Promise<unknown>;
  let reconcileHandler: (...args: unknown[]) => Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerVaultHandlers();
    const w = handlers.get('vault:watch');
    const r = handlers.get('vault:reconcile');
    if (!w) throw new Error('vault:watch handler not registered');
    if (!r) throw new Error('vault:reconcile handler not registered');
    watchHandler = w as (...args: unknown[]) => Promise<unknown>;
    reconcileHandler = r as (...args: unknown[]) => Promise<unknown>;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-reconcile-throttle-'));
    // M3 — `vault:watch` now requires the open-vault handshake: the vault
    // must already be registered (in the real app by `vault:init-config`)
    // before the watch call. Register it here so `assertActiveVault` passes.
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('second back-to-back reconcile is throttled', async () => {
    await watchHandler({} /* _event */, vaultDir);

    const first = (await reconcileHandler({})) as { success: boolean; skipped?: boolean };
    expect(first.success).toBe(true);
    expect(first.skipped).toBeUndefined();

    const second = (await reconcileHandler({})) as { success: boolean; skipped?: boolean };
    expect(second.success).toBe(true);
    expect(second.skipped).toBe(true);
  });

  it('vault:watch resets the throttle so the next reconcile is NOT skipped', async () => {
    await watchHandler({}, vaultDir);

    await reconcileHandler({});
    const throttled = (await reconcileHandler({})) as { success: boolean; skipped?: boolean };
    expect(throttled.skipped).toBe(true);

    // Simulate a vault swap. In the real app a re-open runs the handshake
    // (`vault:init-config`) again, re-registering the vault before the
    // fresh `vault:watch`. We re-register here so `assertActiveVault`
    // passes — what's important for THIS test is whether the throttle was
    // reset by the second watch call.
    vaultRegistry.setCurrentVault(vaultDir);
    await watchHandler({}, vaultDir);

    const afterSwap = (await reconcileHandler({})) as {
      success: boolean;
      skipped?: boolean;
    };
    expect(afterSwap.success).toBe(true);
    expect(afterSwap.skipped).toBeUndefined();
  });

  it('a walk asked for now (a note whose file went missing) runs inside the throttle window', async () => {
    await watchHandler({}, vaultDir);
    await reconcileHandler({});
    const now = (await reconcileHandler({}, { now: true })) as { success: boolean; skipped?: boolean };
    expect(now.success).toBe(true);
    expect(now.skipped).toBeUndefined();
    // And it counts as the last walk: a focus walk right after is throttled.
    const focus = (await reconcileHandler({})) as { success: boolean; skipped?: boolean };
    expect(focus.skipped).toBe(true);
  });
});

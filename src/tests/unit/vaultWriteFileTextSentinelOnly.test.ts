import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * `vault:write-file-text` overwrites with no stale check and can create
 * folders, so main lets it write only this machine's crash-recovery
 * sentinels. A note has to go through the note writer's stale-checked or
 * exclusive channels, whatever the renderer sends (D28). Real temp dir, real
 * handler.
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
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => '' },
}));

const { registerVaultHandlers } = await import('../../main/ipc/vault.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');
const { __setMachineIdentityForTests } = await import('../../main/services/machineIdentity');

type Result = { success: boolean; code?: string };

function write(root: string, rel: string, content: string): Promise<Result> {
  const h = handlers.get('vault:write-file-text');
  if (!h) throw new Error('vault:write-file-text handler not registered');
  return h({}, root, rel, content) as Promise<Result>;
}

const ME = 'aaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbb';

describe('vault:write-file-text writes only crash-recovery sentinels', () => {
  let vaultDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    if (!handlers.has('vault:write-file-text')) registerVaultHandlers();
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-sentinel-only-'));
    vaultRegistry.setCurrentVault(vaultDir);
    __setMachineIdentityForTests({ machineId: ME, hostname: 'A' });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    __setMachineIdentityForTests(null);
    vaultRegistry.setCurrentVault(null);
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('refuses an existing note and leaves its bytes', async () => {
    await fs.writeFile(join(vaultDir, 'Plan.md'), 'Mine\n', 'utf-8');
    expect(await write(vaultDir, 'Plan.md', 'Blind\n')).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await fs.readFile(join(vaultDir, 'Plan.md'), 'utf-8')).toBe('Mine\n');
  });

  it('creates no note, no .markdown note and no folder', async () => {
    expect(await write(vaultDir, 'New.md', 'x')).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await write(vaultDir, 'Sub/Deep.markdown', 'x')).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await write(vaultDir, 'Notes.txt', 'x')).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await fs.readdir(vaultDir)).toEqual([]);
  });

  it("refuses Filo's own state and another machine's sentinel", async () => {
    expect(await write(vaultDir, '.filo/app.json', '{}')).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await write(vaultDir, `.filo/.dirty.${OTHER}`, '1')).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await write(vaultDir, '.filo/.dirty', '1')).toMatchObject({ success: false, code: 'FORBIDDEN' });
  });

  it("writes this machine's sentinels", async () => {
    for (const rel of [
      `.filo/.dirty.${ME}`,
      `.filo/rename-cascade-pending.${ME}.json`,
      `.filo/tag-rewrite-pending.${ME}.json`,
    ]) {
      expect(await write(vaultDir, rel, '{}')).toMatchObject({ success: true });
      expect(await fs.readFile(join(vaultDir, rel), 'utf-8')).toBe('{}');
    }
  });
});

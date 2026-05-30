import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Phase 4 / 4.3 — `templates:layout:write` must use `atomicWriteFile`
 * so a crash mid-write doesn't leave the template file as half-written
 * JSON. The previous implementation called `fs.promises.writeFile`
 * directly, which is not crash-safe.
 *
 * Smoke test: drive the IPC handler against a tmp vault and confirm:
 *   1. After a successful write, the file's content exactly matches
 *      the payload (round-trip).
 *   2. No `.tmp` sibling lingers after the write resolves (the rename
 *      hop is part of the atomic pipeline).
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
}));

vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
}));

const { registerTemplateHandlers } = await import('../../main/ipc/templates.ipc');
const { vaultRegistry } = await import('../../main/services/vaultRegistry');

describe('templates:layout:write — atomic write (Phase 4 / 4.3)', () => {
  let vaultDir: string;
  let writeHandler: (...args: unknown[]) => unknown | Promise<unknown>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    registerTemplateHandlers();
    const h = handlers.get('templates:layout:write');
    if (!h) throw new Error('templates:layout:write handler not registered');
    writeHandler = h;
  });

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(join(tmpdir(), 'filo-templates-'));
    vaultRegistry.setCurrentVault(vaultDir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vaultRegistry.setCurrentVault(null);
    errSpy?.mockRestore();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('writes the template content with full JSON fidelity', async () => {
    const filename = 'my-layout.template.json';
    const content = { name: 'My Layout', frames: [{ id: 'f1', x: 100, y: 200 }] };

    const result = (await writeHandler({}, vaultDir, filename, content)) as {
      success: boolean;
      filename?: string;
    };
    expect(result.success).toBe(true);
    expect(result.filename).toBe(filename);

    const onDisk = await fs.readFile(
      join(vaultDir, '.filo', 'templates', filename),
      'utf-8',
    );
    expect(JSON.parse(onDisk)).toEqual(content);
  });

  it('leaves no .tmp sibling after a successful write', async () => {
    const filename = 'clean-up.template.json';
    const content = { ok: true };

    await writeHandler({}, vaultDir, filename, content);

    const entries = await fs.readdir(join(vaultDir, '.filo', 'templates'));
    expect(entries).toContain(filename);
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});

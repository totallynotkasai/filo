import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The sidebar's shown / hidden state (Hide Vault) is kept per machine in
 * `sidebar-state.json`, so a hidden sidebar stays hidden after a restart.
 * A file from before the field existed reads as shown.
 */

let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userDataDir : tmpdir()),
  },
}));

async function freshModule(): Promise<typeof import('../../main/services/sidebarState')> {
  vi.resetModules();
  return import('../../main/services/sidebarState');
}

describe('sidebar-state.json: open', () => {
  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'filo-sidebar-open-'));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it('defaults to shown on first launch', async () => {
    const { loadSidebarState } = await freshModule();
    expect((await loadSidebarState()).open).toBe(true);
  });

  it('a hidden sidebar is still hidden after a restart, with the rest kept', async () => {
    const first = await freshModule();
    await first.loadSidebarState();
    await first.updateSidebarState({ width: 300, floating: true });
    await first.updateSidebarState({ open: false });
    await first.flushSidebarStateNow();

    const second = await freshModule();
    const state = await second.loadSidebarState();
    expect(state).toMatchObject({ open: false, width: 300, floating: true });
  });

  it('a file without the field reads as shown', async () => {
    await fs.writeFile(join(userDataDir, 'sidebar-state.json'), JSON.stringify({ width: 260, floating: false }));
    const { loadSidebarState } = await freshModule();
    expect(await loadSidebarState()).toMatchObject({ open: true, width: 260 });
  });

  it('the IPC patch schema accepts open and still refuses unknown keys', async () => {
    const { SidebarPatchSchema } = await freshModule();
    expect(SidebarPatchSchema.safeParse({ open: false }).success).toBe(true);
    expect(SidebarPatchSchema.safeParse({ open: 'no' }).success).toBe(false);
    expect(SidebarPatchSchema.safeParse({ hidden: true }).success).toBe(false);
  });
});

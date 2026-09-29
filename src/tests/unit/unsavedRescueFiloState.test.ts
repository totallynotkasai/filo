/**
 * Leaving a vault anyway keeps a rescue copy of Filo's own `.filo/` state too:
 * the tag registry (the only copy of attachment tags), settings and layout.
 * The copies are named `_filo__<name>.json`, outside `.filo/`, so the rescue
 * channel accepts them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { keepRescueCopies, filoRescueName } from '@renderer/stores/unsavedRescue';
import { scheduleMiscWrite } from '@renderer/lib/boards/miscWriteScheduler';
import { scheduleConfigWrite, seedConfigSnapshots } from '@renderer/lib/boards/configWriteScheduler';
import { unsavedWork, __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { ProjectSettings } from '@renderer/schema/index';

const VAULT = '/vault';

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met');
}

describe('rescue copies of .filo/ state', () => {
  let rescued: Array<{ relPath: string; text: string }> = [];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    setActiveVaultPath(VAULT);
    rescued = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'recovery:keep-unsaved') {
        rescued = args[1] as Array<{ relPath: string; text: string }>;
        return { ok: true, dir: '.filo/recovery/t-unsaved', kept: rescued.map((i) => i.relPath), failed: [] };
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') return { ok: false, code: 'EBUSY', error: 'locked' };
      if (channel === 'vault:stat') return { ok: false, code: 'ENOENT', error: 'none' };
      return undefined;
    });
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    setActiveVaultPath('');
    restoreFiloDefault();
  });

  it('names a .filo/ file outside .filo/', () => {
    expect(filoRescueName('.filo/tags.json')).toBe('_filo__tags.json');
    expect(filoRescueName('.filo/workspace.json')).toBe('_filo__workspace.json');
  });

  it('a tags.json write that failed is kept as _filo__tags.json', async () => {
    const tags = JSON.stringify({ version: 1, tags: { project: {} }, fileTags: { 'photo.png': ['project'] } }, null, 2);
    scheduleMiscWrite('tags', () => ({
      vaultRoot: VAULT,
      path: '.filo/tags.json',
      json: tags,
      write: async () => {
        throw Object.assign(new Error('tags.json on disk is from a newer Filo'), { code: 'CONFIG_CORRUPT' });
      },
    }));
    await waitFor(() => unsavedWork().failed.length === 1);

    const result = await keepRescueCopies();
    expect(rescued).toContainEqual({ relPath: '_filo__tags.json', text: `${tags}\n` });
    expect(result.notKept).toEqual([]);
  });

  it('settings that could not be saved are kept, only the files that changed', async () => {
    const before = { general: { globalFont: 'Old' }, mindmap: {}, kanban: {}, tasklist: {}, document: {} } as ProjectSettings;
    const after = { ...before, general: { globalFont: 'New' } } as ProjectSettings;
    const workspace = { openTabs: [], activeTabId: '' };
    const layout = { paneTree: null, activePaneId: null, boardToolbars: {} };
    seedConfigSnapshots(before, 'light', workspace, layout);
    scheduleConfigWrite(() => ({ vaultRoot: VAULT, settings: after, theme: 'light', workspace, layout }));
    await waitFor(() => unsavedWork().failed.length === 1);

    const result = await keepRescueCopies();
    const names = rescued.map((i) => i.relPath).sort();
    // app.json and appearance.json carry the font; defaults and layout didn't change.
    expect(names).toEqual(['_filo__app.json', '_filo__appearance.json']);
    expect(rescued.find((i) => i.relPath === '_filo__app.json')?.text).toContain('"globalFont": "New"');
    expect(result.notKept).toEqual([]);
  });
});

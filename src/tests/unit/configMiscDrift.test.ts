import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeConfigs, seedConfigSnapshots, markCorruptConfigTarget, isConfigPathCorrupt } from '@renderer/lib/boards/configWriteScheduler';
import { setConfigExternalHandlers, type ConfigDriftChoice } from '@renderer/lib/boards/configDrift';
import {
  noteBaseline,
  getBaseline,
  isBaselineUnverified,
  markBaselineUnverified,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { seedConfigBaselines, statConfigsBeforeRead } from '@renderer/lib/vault/configBaselineSeed';
import { flushAllMisc } from '@renderer/lib/boards/miscWriteScheduler';
import { __configDriftSettledForTests, isConfigDriftHeld } from '@renderer/lib/boards/configDriftHold';
import { seedViewportsCache, setViewport, getViewportFromCache } from '@renderer/lib/boards/viewportCache';
import { __resetDirtyTrackingForTests, unsavedWork, hasFailedWrites } from '@renderer/lib/boards/writeStateTracking';
import { sidebarOrderStore } from '@renderer/stores/sidebarOrder.svelte';
import {
  getHotkeyOverrides,
  saveHotkeyOverrides,
  setHotkeyOverride,
  setHotkeyOverrides,
  _resetForTests as resetHotkeys,
} from '@renderer/core/hotkeys';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';

/**
 * `.filo/` configs are pinned by a stat taken on both sides of their read, and
 * the three files the misc writer saves whole (view state, shortcuts) are
 * checked for another version before a write: view state merges it, shortcuts
 * ask. A view state file Filo can't read never counts as unsaved work.
 */

const VAULT = '/vault';

interface Disk {
  /** File → its JSON object, or '__corrupt' for bytes that aren't JSON. */
  files: Record<string, Record<string, unknown> | '__corrupt'>;
  stats: Record<string, { mtimeMs: number; size: number }>;
  saves: Array<{ file: string; json: string }>;
  snapshots: string[];
  /** Runs once, inside the next `config:load-all`. */
  duringLoad?: () => void;
}

function mockDisk(disk: Disk): void {
  let clock = 5000;
  installFiloMock((channel: string, ...args: unknown[]) => {
    if (channel === 'vault:stat') {
      const file = String(args[1]).replace('.filo/', '');
      const stat = disk.stats[file];
      return stat ? { ok: true, ...stat } : { ok: false, code: 'ENOENT', error: 'gone' };
    }
    if (channel === 'config:load') {
      const v = disk.files[String(args[1])];
      if (v === '__corrupt') return { __corrupt: true, raw: '{', error: 'SyntaxError' };
      return v ?? {};
    }
    if (channel === 'config:load-all') {
      disk.duringLoad?.();
      disk.duringLoad = undefined;
      return {};
    }
    if (channel === 'recovery:snapshot') {
      disk.snapshots.push(String(args[1]));
      return { ok: true, path: `${VAULT}/.filo/recovery/x-keep/y` };
    }
    if (channel === 'config:save' || channel === 'config:save-workspace') {
      const file = channel === 'config:save' ? String(args[1]) : 'workspace.json';
      const json = String(channel === 'config:save' ? args[2] : args[1]);
      disk.saves.push({ file, json });
      disk.files[file] = JSON.parse(json) as Record<string, unknown>;
      disk.stats[file] = { mtimeMs: ++clock, size: new TextEncoder().encode(json).length };
      return { ok: true };
    }
    return undefined;
  });
}

function newDisk(): Disk {
  return { files: {}, stats: {}, saves: [], snapshots: [] };
}

function handlers(choice: ConfigDriftChoice): { prompts: string[] } {
  const log = { prompts: [] as string[] };
  setConfigExternalHandlers({
    prompt: async (file) => {
      log.prompts.push(file);
      return choice;
    },
    reload: () => true,
    notice: () => {},
  });
  return log;
}

beforeEach(() => {
  __resetBaselinesForTests();
  __resetDirtyTrackingForTests();
  resetHotkeys();
});
afterEach(() => {
  setConfigExternalHandlers(null);
  restoreFiloDefault();
  __resetBaselinesForTests();
  __resetDirtyTrackingForTests();
});

describe('config baselines at open are pinned by a stat on both sides of the read', () => {
  it('a file that changed while it was read is left unstamped and unverified; an unchanged one is stamped', async () => {
    const disk = newDisk();
    disk.stats['app.json'] = { mtimeMs: 1000, size: 50 };
    disk.stats['defaults.json'] = { mtimeMs: 1000, size: 50 };
    mockDisk(disk);
    const before = await statConfigsBeforeRead(VAULT, ['.filo/app.json', '.filo/defaults.json', '.filo/viewports.json']);
    // A sync client writes app.json between the read and the stamp.
    disk.stats['app.json'] = { mtimeMs: 2000, size: 61 };
    const seeded = await seedConfigBaselines(VAULT, before);

    expect(seeded).toEqual(['.filo/defaults.json']);
    expect(getBaseline('.filo/defaults.json')).toEqual({ mtimeMs: 1000, size: 50 });
    expect(getBaseline('.filo/app.json')).toBeUndefined();
    expect(isBaselineUnverified('.filo/app.json')).toBe(true);
    // A file that isn't there is neither.
    expect(isBaselineUnverified('.filo/viewports.json')).toBe(false);
  });

  it("an unverified settings file is read before its first write: another program's version asks, Keep local copies it first", async () => {
    const workspace: WorkspaceState = { openTabs: [], activeTabId: '' };
    const settings = (x: number): ProjectSettings =>
      ({ general: { globalFont: 'fixed' }, mindmap: { x }, kanban: {}, tasklist: {}, document: {} } as unknown as ProjectSettings);
    seedConfigSnapshots(settings(1), 'light', workspace);
    const disk = newDisk();
    disk.stats['defaults.json'] = { mtimeMs: 2000, size: 61 };
    disk.files['defaults.json'] = { mindmap: { x: 9 }, kanban: {}, tasklist: {}, document: {} };
    mockDisk(disk);
    markBaselineUnverified('.filo/defaults.json');
    const log = handlers('keep-local');

    // Held and asked; nothing written over it until the answer.
    const result = await writeConfigs(VAULT, settings(2), 'light', workspace);
    expect(result.failed).toEqual(['defaults.json']);
    expect(disk.saves.map((s) => s.file)).not.toContain('defaults.json');
    await __configDriftSettledForTests();
    expect(isConfigDriftHeld('defaults.json')).toBe(false);
    expect(log.prompts).toEqual(['defaults.json']);
    expect(disk.snapshots).toEqual(['.filo/defaults.json']);
    expect(isBaselineUnverified('.filo/defaults.json')).toBe(false);

    const again = await writeConfigs(VAULT, settings(2), 'light', workspace);
    expect(again.failed).toEqual([]);
    expect(disk.saves.map((s) => s.file)).toContain('defaults.json');
  });
});

describe('view state files merge another version before they write', () => {
  it('sidebar order: an outside change for folder B and a local reorder of A both survive', async () => {
    const disk = newDisk();
    disk.stats['sidebar-order.json'] = { mtimeMs: 1000, size: 50 };
    mockDisk(disk);
    noteBaseline('.filo/sidebar-order.json', 1000, 50);
    sidebarOrderStore.seed({ A: ['A/1', 'A/2'], B: ['B/1', 'B/2'] });
    // Another machine reordered B.
    disk.files['sidebar-order.json'] = { A: ['A/1', 'A/2'], B: ['B/2', 'B/1'] };
    disk.stats['sidebar-order.json'] = { mtimeMs: 2000, size: 52 };

    sidebarOrderStore.set(VAULT, 'A', ['A/2', 'A/1']);
    expect((await flushAllMisc()).failed).toEqual([]);

    const saved = JSON.parse(disk.saves.at(-1)!.json) as Record<string, string[]>;
    expect(saved).toEqual({ A: ['A/2', 'A/1'], B: ['B/2', 'B/1'] });
    expect(sidebarOrderStore.order.B).toEqual(['B/2', 'B/1']);
  });

  it('viewports: per board, the camera saved last wins, and boards only on disk are kept', async () => {
    const disk = newDisk();
    disk.stats['viewports.json'] = { mtimeMs: 1000, size: 50 };
    mockDisk(disk);
    noteBaseline('.filo/viewports.json', 1000, 50);
    seedViewportsCache(VAULT, { b1: { x: 0, y: 0, scale: 1, updatedAt: 1 } });
    disk.files['viewports.json'] = {
      b1: { x: 5, y: 5, scale: 2, updatedAt: 2 },
      b2: { x: 7, y: 7, scale: 1, updatedAt: 2 },
    };
    disk.stats['viewports.json'] = { mtimeMs: 2000, size: 90 };

    setViewport('b1', { x: 1, y: 1, scale: 1 });
    expect((await flushAllMisc()).failed).toEqual([]);

    const saved = JSON.parse(disk.saves.at(-1)!.json) as Record<string, { x: number }>;
    expect(saved.b1?.x).toBe(1);
    expect(saved.b2?.x).toBe(7);
    expect(getViewportFromCache('b2')?.x).toBe(7);
  });

  it('a viewports.json that is unreadable: a pan is dropped with a notice, never counted as unsaved; once it reads, it saves again', async () => {
    const disk = newDisk();
    disk.stats['viewports.json'] = { mtimeMs: 1000, size: 1 };
    disk.files['viewports.json'] = '__corrupt';
    mockDisk(disk);
    const notices: string[] = [];
    setConfigExternalHandlers({ prompt: async () => 'defer', reload: () => false, notice: (_k, t) => notices.push(t) });
    markCorruptConfigTarget('viewports.json');
    seedViewportsCache(VAULT, {});

    setViewport('b1', { x: 3, y: 3, scale: 1 });
    expect((await flushAllMisc()).failed).toEqual([]);
    expect(disk.saves).toEqual([]);
    expect(unsavedWork().failed).toEqual([]);
    expect(hasFailedWrites()).toBe(false);
    expect(notices).toHaveLength(1);

    // Fixed by hand: the next change reads it, merges and saves.
    disk.files['viewports.json'] = { b9: { x: 9, y: 9, scale: 1, updatedAt: 1 } };
    setViewport('b1', { x: 4, y: 4, scale: 1 });
    expect((await flushAllMisc()).failed).toEqual([]);
    expect(isConfigPathCorrupt('.filo/viewports.json')).toBe(false);
    const saved = JSON.parse(disk.saves.at(-1)!.json) as Record<string, { x: number }>;
    expect(saved.b1?.x).toBe(4);
    expect(saved.b9?.x).toBe(9);
  });
});

describe('hotkeys.json changed outside Filo asks Reload / Keep local', () => {
  function changedOnDisk(): Disk {
    const disk = newDisk();
    disk.stats['hotkeys.json'] = { mtimeMs: 2000, size: 40 };
    disk.files['hotkeys.json'] = { 'tile:lock': 'Ctrl+L' };
    mockDisk(disk);
    noteBaseline('.filo/hotkeys.json', 1000, 30);
    setHotkeyOverrides({});
    return disk;
  }

  it('Keep local copies the other version first, then writes Filo\'s shortcuts', async () => {
    const disk = changedOnDisk();
    const log = handlers('keep-local');
    setHotkeyOverride('tile:add', { key: 'a', ctrl: true, shift: true });
    saveHotkeyOverrides(VAULT);
    // The write doesn't wait for the answer: it is held and refused at once.
    expect((await flushAllMisc()).failed).toEqual(['.filo/hotkeys.json']);
    expect(disk.saves).toEqual([]);
    await __configDriftSettledForTests();
    expect(isConfigDriftHeld('hotkeys.json')).toBe(false);
    expect(log.prompts).toEqual(['hotkeys.json']);
    expect(disk.snapshots).toEqual(['.filo/hotkeys.json']);
    // Keep local re-fires the held write.
    expect((await flushAllMisc()).failed).toEqual([]);
    expect(JSON.parse(disk.saves.at(-1)!.json)).toEqual({ 'tile:add': 'Ctrl+Shift+A' });
    expect(unsavedWork().failed).toEqual([]);
  });

  it('Reload takes the file\'s shortcuts and writes nothing', async () => {
    const disk = changedOnDisk();
    handlers('reload');
    setHotkeyOverride('tile:add', { key: 'a', ctrl: true, shift: true });
    saveHotkeyOverrides(VAULT);
    expect((await flushAllMisc()).failed).toEqual(['.filo/hotkeys.json']);
    await __configDriftSettledForTests();
    expect(isConfigDriftHeld('hotkeys.json')).toBe(false);
    expect((await flushAllMisc()).failed).toEqual([]);
    expect(disk.saves).toEqual([]);
    expect(Object.keys(getHotkeyOverrides())).toEqual(['tile:lock']);
    expect(unsavedWork().failed).toEqual([]);
  });

  it('no answer yet: nothing is written over the file', async () => {
    const disk = changedOnDisk();
    handlers('defer');
    setHotkeyOverride('tile:add', { key: 'a', ctrl: true, shift: true });
    saveHotkeyOverrides(VAULT);
    expect((await flushAllMisc()).failed).toEqual(['.filo/hotkeys.json']);
    expect(disk.saves).toEqual([]);
  });
});

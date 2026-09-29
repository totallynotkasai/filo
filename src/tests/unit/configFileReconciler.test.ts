import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const project = vi.hoisted(() => ({
  name: 'Old Name',
  theme: 'light',
  settings: {
    general: { globalFont: '' } as Record<string, unknown>,
    mindmap: {},
    kanban: {},
    tasklist: {},
    document: {},
  },
}));

vi.mock('@renderer/stores/vault.svelte', () => ({
  vaultStore: {
    path: '/vault',
    project,
  },
}));

import { reconcileConfigFileChange } from '@renderer/stores/configFileReconciler';
import { configExternalHandlers } from '@renderer/stores/configDriftPrompt';
import {
  writeConfigs,
  seedConfigSnapshots,
  markCorruptConfigTarget,
  isConfigPathCorrupt,
  isConfigTargetCorrupt,
} from '@renderer/lib/boards/configWriteScheduler';
import { setConfigExternalHandlers } from '@renderer/lib/boards/configDrift';
import { __configDriftSettledForTests, isConfigDriftHeld } from '@renderer/lib/boards/configDriftHold';
import { noteBaseline, isBaselineUnverified, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { seedViewportsCache, getViewportFromCache } from '@renderer/lib/boards/viewportCache';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { getHotkeyOverrides, setHotkeyOverrides, _resetForTests as resetHotkeys } from '@renderer/core/hotkeys';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';

/**
 * The watcher's `config` events: an outside change to a view state or
 * shortcuts file is taken into memory when nothing of Filo's waits to be
 * saved, and a file Filo stopped saving because it was unreadable is saved
 * again once it reads. A settings file reloaded from disk brings the vault
 * name with it.
 */

const VAULT = '/vault';

function mockConfigs(files: Record<string, unknown>, saves: Array<{ file: string; json: string }> = []): void {
  installFiloMock((channel: string, ...args: unknown[]) => {
    if (channel === 'vault:stat') return { ok: true, mtimeMs: 2000, size: 99 };
    if (channel === 'config:load') return files[String(args[1])] ?? {};
    if (channel === 'config:save') {
      saves.push({ file: String(args[1]), json: String(args[2]) });
      return { ok: true };
    }
    return undefined;
  });
}

const event = (file: string) => ({ kind: 'config' as const, filename: `.filo/${file}`, eventType: 'change' });

beforeEach(() => {
  __resetBaselinesForTests();
  __resetDirtyTrackingForTests();
  resetHotkeys();
  project.name = 'Old Name';
  setActiveVaultPath(VAULT);
});
afterEach(() => {
  setConfigExternalHandlers(null);
  restoreFiloDefault();
});

describe('reconcileConfigFileChange', () => {
  it('an outside viewports.json change is merged into memory', async () => {
    seedViewportsCache(VAULT, { b1: { x: 0, y: 0, scale: 1, updatedAt: 5 } });
    noteBaseline('.filo/viewports.json', 1000, 50);
    mockConfigs({ 'viewports.json': { b2: { x: 7, y: 7, scale: 1, updatedAt: 1 } } });
    await reconcileConfigFileChange(event('viewports.json'));
    expect(getViewportFromCache('b2')?.x).toBe(7);
    expect(getViewportFromCache('b1')?.x).toBe(0);
  });

  it('an outside hotkeys.json change is taken when no shortcut change is waiting', async () => {
    setHotkeyOverrides({});
    noteBaseline('.filo/hotkeys.json', 1000, 50);
    mockConfigs({ 'hotkeys.json': { 'tile:lock': 'Ctrl+L' } });
    await reconcileConfigFileChange(event('hotkeys.json'));
    expect(Object.keys(getHotkeyOverrides())).toEqual(['tile:lock']);
  });

  it('a settings file that reads again is un-paused, and checked before its next write', async () => {
    markCorruptConfigTarget('app.json');
    mockConfigs({ 'app.json': { globalFont: 'Serif' } });
    await reconcileConfigFileChange(event('app.json'));
    expect(isConfigTargetCorrupt('app.json')).toBe(false);
    expect(isBaselineUnverified('.filo/app.json')).toBe(true);
  });

  it('a settings file still unreadable stays paused', async () => {
    markCorruptConfigTarget('config:save-workspace');
    mockConfigs({ 'workspace.json': { __corrupt: true, raw: '{', error: 'SyntaxError' } });
    await reconcileConfigFileChange(event('workspace.json'));
    expect(isConfigTargetCorrupt('config:save-workspace')).toBe(true);
  });

  it('an unreadable hotkeys.json that reads again is taken in and saved again', async () => {
    setHotkeyOverrides({});
    markCorruptConfigTarget('hotkeys.json');
    mockConfigs({ 'hotkeys.json': { 'tile:add': 'Ctrl+Shift+A' } });
    await reconcileConfigFileChange(event('hotkeys.json'));
    expect(isConfigPathCorrupt('.filo/hotkeys.json')).toBe(false);
    expect(Object.keys(getHotkeyOverrides())).toEqual(['tile:add']);
  });
});

describe('Reload of an app.json changed outside Filo', () => {
  it('takes its vault name, and the next save keeps the new name', async () => {
    const workspace: WorkspaceState = { openTabs: [], activeTabId: '' };
    const ok = configExternalHandlers.reload('app.json', { name: 'New Name', globalFont: 'Serif' });
    expect(ok).toBe(true);
    expect(project.name).toBe('New Name');

    const saves: Array<{ file: string; json: string }> = [];
    mockConfigs({}, saves);
    const settings = project.settings as unknown as ProjectSettings;
    seedConfigSnapshots(settings, 'light', workspace, undefined, 'Old Name');
    await writeConfigs(VAULT, settings, 'light', workspace, undefined, project.name);
    const app = saves.find((s) => s.file === 'app.json');
    expect(JSON.parse(app!.json).name).toBe('New Name');
  });

  it('a Reload takes the file into memory; the next save writes the others from it and leaves the reloaded file alone', async () => {
    const workspace: WorkspaceState = { openTabs: [], activeTabId: '' };
    let settings = { general: { globalFont: 'A' }, mindmap: { x: 1 }, kanban: {}, tasklist: {}, document: {} } as unknown as ProjectSettings;
    seedConfigSnapshots(settings, 'light', workspace, undefined, 'Vault');
    const saves: Array<{ file: string; json: string }> = [];
    // defaults.json was changed outside Filo; Reload takes a new font along with it.
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:stat') return String(args[1]) === '.filo/defaults.json' ? { ok: true, mtimeMs: 2000, size: 60 } : { ok: true, mtimeMs: 1000, size: 50 };
      if (channel === 'config:load') return String(args[1]) === 'defaults.json' ? { mindmap: { x: 9 }, kanban: {}, tasklist: {}, document: {} } : {};
      if (channel === 'config:save') {
        saves.push({ file: String(args[1]), json: String(args[2]) });
        return { ok: true };
      }
      return { ok: true };
    });
    for (const f of ['app.json', 'defaults.json', 'appearance.json', 'workspace.json']) noteBaseline(`.filo/${f}`, 1000, 50);
    setConfigExternalHandlers({
      prompt: async () => 'reload',
      reload: () => {
        settings = { ...settings, general: { globalFont: 'B' }, mindmap: { x: 9 } } as unknown as ProjectSettings;
        return true;
      },
      notice: () => {},
    });
    const edited = { ...settings, mindmap: { x: 2 }, general: { globalFont: 'A2' } } as unknown as ProjectSettings;
    const first = await writeConfigs(VAULT, edited, 'light', workspace, undefined, 'Vault');
    // defaults.json is held for the answer; the rest of the bundle is written.
    expect(first.failed).toEqual(['defaults.json']);
    expect(saves.map((s) => s.file)).toContain('app.json');
    expect(saves.map((s) => s.file)).not.toContain('defaults.json');
    await __configDriftSettledForTests();
    expect(isConfigDriftHeld('defaults.json')).toBe(false);

    saves.length = 0;
    await writeConfigs(VAULT, settings, 'light', workspace, undefined, 'Vault');
    const app = saves.find((s) => s.file === 'app.json');
    expect(JSON.parse(app!.json).globalFont).toBe('B');
    expect(saves.map((s) => s.file)).not.toContain('defaults.json');
  });
});

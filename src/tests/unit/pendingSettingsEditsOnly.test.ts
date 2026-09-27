import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pendingSettingsStore, settingsBoard } from '@renderer/stores/pendingSettings.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Project } from '@renderer/schema/index';
import { ProjectSettingsSchema } from '@renderer/schema/settings';

/**
 * The Settings dialog holds a copy of the Global Defaults and of the current
 * board's settings. What counts as an edit, and what Apply writes, is the
 * difference between the copy and the values it was copied from:
 *   - a live change made while the dialog is open (a theme's colour reset, a
 *     Mind Map toggle on the board) is not an edit, so closing doesn't ask
 *     "Discard settings changes?" for nothing;
 *   - Apply writes only the fields the user edited, so that live change isn't
 *     put back to the value it had when the dialog opened.
 * The Current Board tab edits no board while a note's Document tab shows,
 * though that pane still holds the board it showed before.
 */
function fixture(): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { backgroundColor: '', semanticZoom: true, snapToGrid: false, connectionsVisible: true, labelsVisible: true },
      viewport: { x: 0, y: 0, scale: 1 },
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

let project: Project;

beforeEach(() => {
  (window as unknown as Record<string, unknown>).filo = { invoke: async () => null, on: () => () => {}, send: () => {} };
  vi.useFakeTimers();
  boardCacheStore.clear();
  boardStore.clearBoard();
  tabStore.closeAll();
  pendingSettingsStore.cancel();
  vaultStore.setPath('/vault');
  const f = fixture();
  project = {
    vaultPath: '/vault',
    name: 'Vault',
    theme: 'light',
    settings: ProjectSettingsSchema.parse({}),
    boards: [f.board],
    connections: {},
    frames: [],
    workspace: { openTabs: [], activeTabId: '' },
    createdAt: 0,
    updatedAt: 0,
  } as Project;
  vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(project);
  boardCacheStore.hydrate({ mm: f }, { mm: 'map.board.json' });
  boardStore.setBoard(f.board, {}, {}, []);
});
afterEach(() => {
  pendingSettingsStore.cancel();
  boardCacheStore.clear();
  boardStore.clearBoard();
  tabStore.closeAll();
  vaultStore.setPath('');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const cachedSettings = (): Record<string, unknown> =>
  boardCacheStore.cache.mm?.board.settings as Record<string, unknown>;

describe('Global Defaults', () => {
  it('a live change while the dialog is open is not an edit', () => {
    pendingSettingsStore.startGlobal();
    project.settings.mindmap.tile.headerColor = '#abcdef';
    expect(pendingSettingsStore.hasGlobalChanges()).toBe(false);
    expect(pendingSettingsStore.hasUnsavedChanges()).toBe(false);
  });

  it('Apply writes the edit and keeps a live change to another field', () => {
    pendingSettingsStore.startGlobal();
    project.settings = { ...project.settings, kanban: { ...project.settings.kanban, accentColor: '#00ff00' } };
    pendingSettingsStore.update('mindmap.tile.borderWidth', 6);
    expect(pendingSettingsStore.applyGlobal()).toEqual({ ok: true, changed: true });
    expect(project.settings.mindmap.tile.borderWidth).toBe(6);
    expect(project.settings.kanban.accentColor).toBe('#00ff00');
  });
});

describe('Current Board', () => {
  it('a live change to the board while the dialog is open is not an edit', () => {
    pendingSettingsStore.startBoard();
    boardCacheStore.updateBoardSettings('mm', { ...cachedSettings(), snapToGrid: true });
    expect(pendingSettingsStore.hasBoardChanges()).toBe(false);
  });

  it('Apply writes only the edited fields over the board\'s live settings', () => {
    pendingSettingsStore.startBoard();
    boardCacheStore.updateBoardSettings('mm', { ...cachedSettings(), snapToGrid: true });
    pendingSettingsStore.updateBoard('defaults.tile.headerColor', '#d32f2f');
    expect(pendingSettingsStore.applyBoard()).toEqual({ ok: true, changed: true });
    const after = cachedSettings();
    expect(after.snapToGrid).toBe(true);
    expect((after.defaults as { tile: { headerColor: string } }).tile.headerColor).toBe('#d32f2f');
  });

  it('clearing a field back to Inherit removes it on Apply', () => {
    boardCacheStore.updateBoardSettings('mm', { ...cachedSettings(), defaults: { tile: { borderWidth: 4 } } });
    pendingSettingsStore.startBoard();
    pendingSettingsStore.updateBoard('defaults.tile.borderWidth', undefined);
    pendingSettingsStore.applyBoard();
    expect(cachedSettings().defaults).toBeUndefined();
  });

  it('edits no board while a note\'s Document tab is active', () => {
    expect(settingsBoard()?.id).toBe('mm');
    tabStore.openNote('Plan.md', 'Plan');
    expect(settingsBoard()).toBeNull();
    pendingSettingsStore.startBoard();
    expect(pendingSettingsStore.pendingBoardId).toBeNull();
    expect(pendingSettingsStore.effectiveBoardSettings).toBeNull();
  });
});

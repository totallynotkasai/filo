/**
 * The Settings dialog's pending copies must only write what their tab edits.
 *
 * Global Defaults holds the per-board-type style defaults only, so an Apply
 * can't put back a General tab change, a theme's colour reset or a recent
 * colour made while the dialog was open. Both tabs refuse to write values
 * their schema would reject on the next load, and an override cleared back
 * to Inherit doesn't count as a change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pendingSettingsStore } from '@renderer/stores/pendingSettings.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { ProjectSettingsSchema } from '@renderer/schema/settings';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Project } from '@renderer/schema/index';

function makeProject(): Project {
  return {
    version: 7,
    vaultPath: '/vault',
    name: 'Vault',
    theme: 'light',
    settings: ProjectSettingsSchema.parse({}),
    boards: [],
    connections: {},
    frames: [],
    tags: [],
    workspace: { openTabs: [], activeTabId: '' },
    createdAt: 0,
    updatedAt: 0,
  } as Project;
}

function installFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function seedMindMapBoard(): void {
  const fixture: BoardFileData = {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {
        backgroundColor: '',
        backgroundPattern: 'grid',
        defaultFolder: '',
        semanticZoom: true,
        snapToGrid: false,
        connectionsVisible: true,
        labelsVisible: true,
      },
      viewport: { x: 0, y: 0, scale: 1 },
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  boardStore.setBoard(fixture.board);
}

describe('Global Defaults Apply writes only the style defaults', () => {
  let project: Project;

  beforeEach(() => {
    vaultStore.setPath('/vault');
    project = makeProject();
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(project);
    vi.spyOn(vaultStore, 'markMetaDirty').mockImplementation(() => {});
  });
  afterEach(() => {
    vaultStore.setPath('');
    pendingSettingsStore.cancel();
    vi.restoreAllMocks();
  });

  it('keeps a General tab change made after the dialog opened', () => {
    pendingSettingsStore.startGlobal();
    project.settings.general.globalFontSize = 17;
    pendingSettingsStore.update('kanban.backgroundPattern', 'dots');

    const result = pendingSettingsStore.applyGlobal();

    expect(result).toEqual({ ok: true, changed: true });
    expect(project.settings.general.globalFontSize).toBe(17);
    expect(project.settings.kanban.backgroundPattern).toBe('dots');
  });

  it('keeps a recent colour picked after the dialog opened', () => {
    pendingSettingsStore.startGlobal();
    project.settings.general.recentColors = ['#123456'];
    pendingSettingsStore.update('mindmap.tile.borderWidth', 3);

    pendingSettingsStore.applyGlobal();

    expect(project.settings.general.recentColors).toEqual(['#123456']);
  });

  it("keeps a theme's colour reset once the copy is re-armed after it", () => {
    project.settings.mindmap.backgroundColor = '#ff0000';
    pendingSettingsStore.startGlobal();
    // A theme pick resets the colours live, then re-arms the copy.
    project.settings.mindmap.backgroundColor = '';
    pendingSettingsStore.startGlobal();
    pendingSettingsStore.update('mindmap.tile.borderWidth', 2);

    pendingSettingsStore.applyGlobal();

    expect(project.settings.mindmap.backgroundColor).toBe('');
    expect(project.settings.mindmap.tile.borderWidth).toBe(2);
  });

  it('shows no unsaved changes after an unrelated General change', () => {
    pendingSettingsStore.startGlobal();
    project.settings.general.globalFontSize = 18;
    project.settings.general.recentColors = ['#abcdef'];
    expect(pendingSettingsStore.hasGlobalChanges()).toBe(false);
    expect(pendingSettingsStore.hasUnsavedChanges()).toBe(false);
  });

  it('lays the pending style defaults over the live settings in `effective`', () => {
    pendingSettingsStore.startGlobal();
    project.settings.general.globalFontSize = 15;
    pendingSettingsStore.update('document.accentColor', '#00aa00');
    const effective = pendingSettingsStore.effective;
    expect(effective?.general.globalFontSize).toBe(15);
    expect(effective?.document.accentColor).toBe('#00aa00');
  });

  it('does nothing when there is nothing to apply', () => {
    const before = project.settings;
    pendingSettingsStore.startGlobal();
    const result = pendingSettingsStore.applyGlobal();
    expect(result).toEqual({ ok: true, changed: false });
    expect(project.settings).toBe(before);
    expect(vaultStore.markMetaDirty).not.toHaveBeenCalled();
  });

  it('refuses a value the schema would reject, and keeps the edit', () => {
    pendingSettingsStore.startGlobal();
    pendingSettingsStore.update('mindmap.tile.borderWidth', Number.NaN);

    const result = pendingSettingsStore.applyGlobal();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('mindmap.tile.borderWidth');
    expect(project.settings.mindmap.tile.borderWidth).toBe(1);
    expect(pendingSettingsStore.pending).not.toBeNull();
  });

  it('ignores a path outside the style defaults', () => {
    pendingSettingsStore.startGlobal();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pendingSettingsStore.update('general.globalFontSize', 19);
    expect(spy).toHaveBeenCalled();
    expect(pendingSettingsStore.hasGlobalChanges()).toBe(false);
  });
});

describe('Current Board Apply', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardStore.clearBoard();
    pendingSettingsStore.cancel();
    vi.useFakeTimers();
    seedMindMapBoard();
  });
  afterEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    pendingSettingsStore.cancel();
    vi.useRealTimers();
  });

  it('refuses a value that would make the board unloadable', () => {
    pendingSettingsStore.startBoard();
    pendingSettingsStore.updateBoard('defaults.tile.borderWidth', 50);

    const result = pendingSettingsStore.applyBoard();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('defaults.tile.borderWidth');
    const settings = boardCacheStore.cache.mm?.board.settings as Record<string, unknown>;
    expect(settings.defaults).toBeUndefined();
    expect(pendingSettingsStore.pendingBoardSettings).not.toBeNull();
  });

  it('treats an override cleared back to Inherit as no change', () => {
    pendingSettingsStore.startBoard();
    pendingSettingsStore.updateBoard('defaults.tile.borderWidth', 4);
    expect(pendingSettingsStore.hasBoardChanges()).toBe(true);

    pendingSettingsStore.updateBoard('defaults.tile.borderWidth', undefined);

    expect(pendingSettingsStore.pendingBoardSettings?.defaults).toBeUndefined();
    expect(pendingSettingsStore.hasBoardChanges()).toBe(false);
    expect(pendingSettingsStore.hasUnsavedChanges()).toBe(false);
  });

  it('keeps a sibling override when one is cleared', () => {
    pendingSettingsStore.startBoard();
    pendingSettingsStore.updateBoard('defaults.tile.borderWidth', 4);
    pendingSettingsStore.updateBoard('defaults.tile.headerColor', '#111111');
    pendingSettingsStore.updateBoard('defaults.tile.borderWidth', undefined);
    expect(pendingSettingsStore.pendingBoardSettings?.defaults).toEqual({ tile: { headerColor: '#111111' } });
  });

  it('does nothing when there is nothing to apply', () => {
    pendingSettingsStore.startBoard();
    const before = boardCacheStore.cache.mm;
    expect(pendingSettingsStore.applyBoard()).toEqual({ ok: true, changed: false });
    expect(boardCacheStore.cache.mm).toBe(before);
  });

  it('records the board type it was started on', () => {
    pendingSettingsStore.startBoard();
    expect(pendingSettingsStore.pendingBoardType).toBe('mindmap');
  });
});

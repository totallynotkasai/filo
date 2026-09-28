/**
 * "Apply … Defaults to all Boards" overwrites only each board's style
 * settings. Saved views, the default folder, Mind Map toggles and Task List
 * group / sort stay. Boards not yet in the cache are loaded first, and any
 * that can't be are named rather than silently skipped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mergeBoardStyleSettings, buildBoardSettingsFromGlobal } from '@renderer/lib/styles/buildBoardDefaults';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { ProjectSettingsSchema } from '@renderer/schema/settings';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Board, Project } from '@renderer/schema/index';

function board(id: string, type: Board['type'], settings: Record<string, unknown>): BoardFileData {
  return {
    board: {
      id,
      type,
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings,
      viewport: { x: 0, y: 0, scale: 1 },
      placements: {},
      inlineTiles: {},
      waypoints: [],
      columns: [],
      sections: [],
    } as unknown as Board,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('mergeBoardStyleSettings', () => {
  it('replaces style keys and keeps everything else', () => {
    const existing = {
      backgroundColor: '#111',
      defaultFolder: 'Notes',
      savedViews: [{ id: 'v1', name: 'Mine' }],
      snapToGrid: true,
      semanticZoom: false,
      defaults: { tile: { borderWidth: 5 } },
    };
    const built = buildBoardSettingsFromGlobal('mindmap', ProjectSettingsSchema.parse({}));
    const next = mergeBoardStyleSettings(existing, built);
    expect(next.backgroundColor).toBe('');
    expect(next.defaults).toEqual(built.defaults);
    expect(next.defaultFolder).toBe('Notes');
    expect(next.savedViews).toEqual([{ id: 'v1', name: 'Mine' }]);
    expect(next.snapToGrid).toBe(true);
    expect(next.semanticZoom).toBe(false);
  });

  it('keeps Task List group and sort', () => {
    const next = mergeBoardStyleSettings(
      { groupBy: 'tag', sortBy: 'manual', accentColor: '#f00' },
      buildBoardSettingsFromGlobal('tasklist', ProjectSettingsSchema.parse({})),
    );
    expect(next.groupBy).toBe('tag');
    expect(next.sortBy).toBe('manual');
    expect(next.accentColor).toBe('');
  });
});

describe('boardStore.applyGlobalDefaultsToAllBoards', () => {
  let project: Project;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async () => null,
      on: () => () => {},
      send: () => {},
    };
    vi.useFakeTimers();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
    const settings = ProjectSettingsSchema.parse({});
    settings.kanban.accentColor = '#00ff00';
    const kb = board('kb', 'kanban', { accentColor: '#123', savedViews: [{ id: 'v', name: 'V' }], defaultFolder: 'Cards' });
    project = {
      version: 7,
      vaultPath: '/vault',
      name: 'Vault',
      theme: 'light',
      settings,
      boards: [kb.board, board('gone', 'mindmap', {}).board],
      connections: {},
      frames: [],
      tags: [],
      workspace: { openTabs: [], activeTabId: '' },
      createdAt: 0,
      updatedAt: 0,
    } as Project;
    vi.spyOn(vaultStore, 'project', 'get').mockReturnValue(project);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });
  });
  afterEach(() => {
    boardCacheStore.clear();
    vaultStore.setPath('');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears cached boards\' own style and names boards it could not load', async () => {
    const ensure = vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue([]);

    const result = await boardStore.applyGlobalDefaultsToAllBoards();

    expect(ensure).toHaveBeenCalled();
    expect(result).toEqual({ updated: 1, skipped: ['gone'] });
    const settings = boardCacheStore.cache.kb?.board.settings as Record<string, unknown>;
    // Blank: the board follows the Global Defaults accent (#00ff00) live.
    expect(settings.accentColor).toBe('');
    expect(settings.savedViews).toEqual([{ id: 'v', name: 'V' }]);
    expect(settings.defaultFolder).toBe('Cards');
  });
});

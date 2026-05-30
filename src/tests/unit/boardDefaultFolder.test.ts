import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { BoardSchema } from '@renderer/schema/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Per-board "Default Folder" pin — schema round-trip + boardStore toggle/cleanup
 * coverage. Mirrors `vaultStore.activeRootFolder`'s vault-wide pin tests but for
 * the board-scoped equivalent introduced by the per-board-default plan.
 */

function makeFixture(boardId: string, defaultFolder = ''): V7BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: `Board ${boardId}`,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {
        backgroundColor: '',
        backgroundPattern: 'grid',
        defaultFolder,
      },
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('BoardSchema.defaultFolder', () => {
  it('parses to the empty-string default when missing', () => {
    const parsed = BoardSchema.parse({
      id: 'b1',
      type: 'mindmap',
      name: 'B1',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    });
    expect((parsed.settings as { defaultFolder?: string }).defaultFolder).toBe('');
  });

  it('round-trips a non-empty defaultFolder via passthrough', () => {
    const parsed = BoardSchema.parse({
      id: 'b1',
      type: 'tasklist',
      name: 'B1',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { defaultFolder: 'Notes/Daily' },
      tasks: [],
    });
    expect((parsed.settings as { defaultFolder?: string }).defaultFolder).toBe('Notes/Daily');
  });
});

describe('boardStore.setBoardDefaultFolder', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vi.spyOn(boardStore, 'recomputeBrokenRefs').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('no-ops when there is no active board', () => {
    boardStore.setBoardDefaultFolder('/vault/Folder A');
    // Nothing to assert beyond "did not throw" — no active board means no
    // settings to mutate. The guard at the top of the method is the contract.
    expect(boardStore.current).toBeNull();
  });

  it('sets the per-board pin from an absolute path', () => {
    const fixture = makeFixture('b1');
    boardCacheStore.hydrate({ b1: fixture }, { b1: 'b1.board.json' });
    boardStore.setBoard(fixture.board, {}, {}, []);

    boardStore.setBoardDefaultFolder('/vault/Folder A');
    const settings = boardStore.current?.settings as { defaultFolder?: string };
    expect(settings.defaultFolder).toBe('Folder A');
  });

  it('toggles off when the same path is passed twice', () => {
    const fixture = makeFixture('b1', 'Folder A');
    boardCacheStore.hydrate({ b1: fixture }, { b1: 'b1.board.json' });
    boardStore.setBoard(fixture.board, {}, {}, []);

    boardStore.setBoardDefaultFolder('/vault/Folder A');
    const settings = boardStore.current?.settings as { defaultFolder?: string };
    expect(settings.defaultFolder).toBe('');
  });
});

describe('boardStore.clearBoardDefaultFolderIfMatches', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('clears the pin on a non-active board whose defaultFolder matches', () => {
    boardCacheStore.hydrate(
      {
        b1: makeFixture('b1', 'Folder A'),
        b2: makeFixture('b2', 'Folder B'),
      },
      { b1: 'b1.board.json', b2: 'b2.board.json' },
    );

    const touched = boardStore.clearBoardDefaultFolderIfMatches('/vault/Folder A');
    expect(touched).toEqual(['b1']);
    expect(
      (boardStore.cache.b1.board as { settings: { defaultFolder: string } }).settings.defaultFolder,
    ).toBe('');
    // Untouched board keeps its pin.
    expect(
      (boardStore.cache.b2.board as { settings: { defaultFolder: string } }).settings.defaultFolder,
    ).toBe('Folder B');
  });

  it('clears descendants of the deleted folder, not unrelated paths', () => {
    boardCacheStore.hydrate(
      {
        b1: makeFixture('b1', 'Folder A/Sub'),
        b2: makeFixture('b2', 'Folder B'),
      },
      { b1: 'b1.board.json', b2: 'b2.board.json' },
    );
    const touched = boardStore.clearBoardDefaultFolderIfMatches('/vault/Folder A');
    expect(touched).toEqual(['b1']);
  });

  it('rewrites the prefix when newPath is provided (rename propagation)', () => {
    boardCacheStore.hydrate(
      { b1: makeFixture('b1', 'Old/Sub') },
      { b1: 'b1.board.json' },
    );
    const touched = boardStore.clearBoardDefaultFolderIfMatches('/vault/Old', '/vault/New');
    expect(touched).toEqual(['b1']);
    expect(
      (boardStore.cache.b1.board as { settings: { defaultFolder: string } }).settings.defaultFolder,
    ).toBe('New/Sub');
  });
});

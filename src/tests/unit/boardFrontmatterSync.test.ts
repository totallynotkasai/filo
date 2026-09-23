import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFrontmatterSyncSlice } from '@renderer/stores/boardFrontmatterSync';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { BoardContext } from '@renderer/stores/boardStoreTypes';
import type { MindMapBoard, TileDefinition } from '@renderer/schema/index';

/**
 * Audit-14 7.7 — `boardFrontmatterSync.ts` had no dedicated test file; its
 * cascade was only reached incidentally through the CascadeDeleteCommand suites.
 * Covers the slice's own surface directly: the file-delete cascade (a tile
 * referencing the deleted `.md` is removed and the delete is undoable), the
 * no-op path, and the rename delegation.
 */

function makeMindMapWithFileTile(boardId: string, tileId: string, filePath: string): V7BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: { [tileId]: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false } },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      [tileId]: {
        id: tileId,
        type: 'text',
        title: 'Notes',
        contentId: `doc_${tileId}`,
        style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
        boardId,
        position: { x: 0, y: 0 },
        size: { width: 200, height: 100 },
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
        filePath,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  };
}

describe('boardFrontmatterSync — makeFrontmatterSyncSlice', () => {
  const slice = makeFrontmatterSyncSlice({} as unknown as BoardContext);

  beforeEach(() => {
    installFiloMock(() => ({ ok: true, success: true }));
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    historyStore.setActiveBoard('b');
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  it('cascadeDeleteByVaultPath removes every tile referencing the deleted file and is undoable', async () => {
    boardCacheStore.hydrate({ b: makeMindMapWithFileTile('b', 't1', 'Notes.md') }, { b: 'b.board.json' });
    expect(boardCacheStore.getFullTilesForBoard('b').t1).toBeDefined();

    const result = slice.cascadeDeleteByVaultPath('Notes.md');
    expect(result.removedTileIds).toContain('t1');
    expect(result.changedBoardIds).toContain('b');
    expect(boardCacheStore.getFullTilesForBoard('b').t1).toBeUndefined();

    // The cascade dispatched an undoable command.
    expect(historyStore.canUndo).toBe(true);
    await historyStore.undo();
    expect(boardCacheStore.getFullTilesForBoard('b').t1).toBeDefined();
  });

  it('cascadeDeleteByVaultPath is a no-op for a path no tile references', () => {
    boardCacheStore.hydrate({ b: makeMindMapWithFileTile('b', 't1', 'Notes.md') }, { b: 'b.board.json' });
    const result = slice.cascadeDeleteByVaultPath('Unreferenced.md');
    expect(result.removedTileIds).toEqual([]);
    expect(boardCacheStore.getFullTilesForBoard('b').t1).toBeDefined();
    expect(historyStore.canUndo).toBe(false);
  });

  it('propagateRename delegates to the cache and rebinds the tile file ref', () => {
    boardCacheStore.hydrate({ b: makeMindMapWithFileTile('b', 't1', 'Notes.md') }, { b: 'b.board.json' });
    const changed = slice.propagateRename('Notes.md', 'Renamed.md');
    expect(changed).toContain('b');
    const def = boardCacheStore.cache.b?.tileDefs.t1 as { filePath?: string };
    expect(def.filePath).toBe('Renamed.md');
  });
});

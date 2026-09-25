import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Phase 7.5 — findBoardIdFor* now memoises scan results (id → boardId). A tile
 * is created on one board and never re-parented (an invariant), so a hit stays
 * valid for the tile's life. The memo verifies-on-hit and rescans on a miss or
 * stale hit, so it can never return a wrong board — these tests pin that.
 */
function installFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function mmWithPlacement(boardId: string, tileId: string): BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: { [tileId]: { x: 0, y: 0, width: 1, height: 1, locked: false, faded: false } },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('boardCache — tile→board reverse index (Phase 7.5)', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
  });
  afterEach(() => boardCacheStore.clear());

  it('resolves the owning board for a tile (and caches the hit)', () => {
    boardCacheStore.hydrate({ A: mmWithPlacement('A', 't1') }, { A: 'a.board.json' });
    expect(boardCacheStore.findTileBoardId('t1')).toBe('A'); // scan → memo
    expect(boardCacheStore.findTileBoardId('t1')).toBe('A'); // memo hit
    expect(boardCacheStore.findTileBoardId('missing')).toBeNull();
  });

  it('self-heals when the memoised board no longer owns the tile (verify-on-hit)', () => {
    boardCacheStore.hydrate({ A: mmWithPlacement('A', 't1') }, { A: 'a.board.json' });
    expect(boardCacheStore.findTileBoardId('t1')).toBe('A'); // memo: t1 → A

    // Drop A and re-home the SAME tile id on B WITHOUT an intervening clear().
    boardCacheStore.removeBoardFromCache('A');
    boardCacheStore.hydrate({ B: mmWithPlacement('B', 't1') }, { B: 'b.board.json' });

    // The stale memo (A) must be rejected and rescanned to B.
    expect(boardCacheStore.findTileBoardId('t1')).toBe('B');
  });

  it('clear() evicts the memo', () => {
    boardCacheStore.hydrate({ A: mmWithPlacement('A', 't1') }, { A: 'a.board.json' });
    expect(boardCacheStore.findTileBoardId('t1')).toBe('A');
    boardCacheStore.clear();
    expect(boardCacheStore.findTileBoardId('t1')).toBeNull();
  });
});

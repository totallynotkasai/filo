import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, TaskListBoard } from '@renderer/schema/index';

/**
 * AUDIT13 Phase 7 L18 — `findBoardIdForTask` now routes through the shared
 * `resolveOwnerCached` reverse-index memo (like its tile / connection / frame /
 * kanban-column siblings) instead of an O(boards × tasks) scan on every keyless
 * persist. The memo verifies-on-hit, so it can never return a stale board.
 *
 * `findBoardIdForTask` is private; it's exercised via the keyless
 * `removeTaskPlacement('', tileId)` path (empty boardId → resolve by scan).
 */

function installFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeTaskList(boardId: string): BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'tasklist',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'priority' },
      tasks: [],
    } as unknown as TaskListBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function defOf(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${title}.md`,
    style: {
      headerColor: '#000',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    createdAt: 0,
    updatedAt: 0,
  } as TileDefinition;
}

const tileIds = (boardId: string): string[] =>
  ((boardCacheStore.cache[boardId].board as TaskListBoard).tasks ?? []).map((p) => p.tileId);

describe('boardCache — findBoardIdForTask memo (L18)', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear(); // also resets the reverse-index memos
  });
  afterEach(() => boardCacheStore.clear());

  it('resolves the owning board for a keyless removeTaskPlacement', () => {
    boardCacheStore.hydrate({ tl: makeTaskList('tl') }, { tl: 'tasks.board.json' });
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);

    // Empty boardId forces resolution through findBoardIdForTask (the memo path).
    boardCacheStore.removeTaskPlacement('', 't1');
    expect(tileIds('tl')).toEqual([]);
  });

  it('resolves the correct board among several task lists', () => {
    boardCacheStore.hydrate(
      { a: makeTaskList('a'), b: makeTaskList('b') },
      { a: 'a.board.json', b: 'b.board.json' },
    );
    boardCacheStore.persistAddTaskPlacement('a', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('b', defOf('t2', 'B'), 0);

    boardCacheStore.removeTaskPlacement('', 't2'); // keyless → must resolve b
    expect(tileIds('a')).toEqual(['t1']);
    expect(tileIds('b')).toEqual([]);
  });

  it('returns no-op (unresolved) for an unknown task id', () => {
    boardCacheStore.hydrate({ tl: makeTaskList('tl') }, { tl: 'tasks.board.json' });
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);

    boardCacheStore.removeTaskPlacement('', 'ghost'); // findBoardIdForTask → null
    expect(tileIds('tl')).toEqual(['t1']); // untouched
  });

  it('verify-on-hit: a stale memo entry never resolves to the wrong board', () => {
    boardCacheStore.hydrate(
      { a: makeTaskList('a'), b: makeTaskList('b') },
      { a: 'a.board.json', b: 'b.board.json' },
    );
    boardCacheStore.persistAddTaskPlacement('a', defOf('t1', 'A'), 0);

    // Resolve+cache t1→a, then remove it from a (memo entry now stale).
    boardCacheStore.removeTaskPlacement('', 't1');
    expect(tileIds('a')).toEqual([]);

    // Re-create the same id on board b. A keyless remove must reject the stale
    // 'a' hit (a no longer owns t1) and re-scan to b.
    boardCacheStore.persistAddTaskPlacement('b', defOf('t1', 'A2'), 0);
    boardCacheStore.removeTaskPlacement('', 't1');
    expect(tileIds('b')).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

/**
 * Phase R7 (Reactive BoardScope, 2026-05-26) — the pre-R7 `tickAndPersist`
 * helper used to call `boardStore.setBoard({ ...cached.board }, ...)` so that
 * the separate active-board `$state` proxy adopted a new top-level identity
 * and Svelte's identity check re-fired. R7 collapsed the runtime/cache
 * duality: `boardStore.current` is now a `$derived` view of
 * `boardCacheStore.cache[currentBoardId].board`, so cache-only mutations
 * propagate to the active board automatically without the identity-flip
 * bridge.
 *
 * This test asserts the new contract:
 *  - `boardStore.current` is the **same** proxy as `boardCacheStore.cache[id].board`.
 *  - Mutating the cache (e.g. adding a Kanban column via the cache mutator)
 *    is visible through `boardStore.current` immediately, without any
 *    intermediate `setBoard` call.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeKanbanFixture(): BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        { id: 'c1', title: 'To Do', position: 0, collapsed: false, tilePlacements: [] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('Reactive BoardScope — cache → active-board propagation', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('boardStore.current returns the same proxy reference as the cache board', () => {
    const fixture = makeKanbanFixture();
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'tasks.board.json' });
    boardStore.setBoard(fixture.board);

    expect(boardStore.current).not.toBeNull();
    expect(boardStore.current).toBe(boardCacheStore.cache.kb.board);
  });

  it('cache-only mutation is visible through boardStore.current without a setBoard re-publish', () => {
    const fixture = makeKanbanFixture();
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'tasks.board.json' });
    boardStore.setBoard(fixture.board);

    const before = (boardStore.current as KanbanBoard).columns.length;
    expect(before).toBe(1);

    boardCacheStore.addKanbanColumn('kb', { id: 'c2', title: 'In Progress' });

    expect((boardStore.current as KanbanBoard).columns.length).toBe(2);
    expect((boardStore.current as KanbanBoard).columns[1].id).toBe('c2');
  });
});

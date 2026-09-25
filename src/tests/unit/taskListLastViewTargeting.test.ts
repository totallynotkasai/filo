import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { createBoardScope } from '@renderer/lib/boards/boardScopeFactory';
import { setActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Audit-4 DI-08 — Task List `lastView` persisted into the WRONG board.
 *
 * The persist timer in `TaskListBoard.svelte` fires ~300 ms after a change.
 * In split view two boards are mounted at once; if board A's surviving timer
 * fires while the user has switched the active pane to board B, the old code
 * routed the write through `updateBoardSettingsWithHistory`, whose
 * `UpdateBoardSettingsCommand` captured the GLOBAL `boardStore.current` (= B)
 * and `historyStore.execute` filed it onto the ACTIVE board's stack (= B). So
 * A's view metadata landed on B AND polluted B's undo stack.
 *
 * The fix routes through the pane-scoped, non-undoable `boardStore.updateSettings`
 * (mirroring KanbanBoard): the pane's own `scope.board` targets its
 * `currentBoard.id`, so the write lands on A and no command touches B's stack.
 *
 * The targeting mechanism lives in the shared store/command layer, not in any
 * Task-List-specific code, so a mindmap fixture exercises it faithfully; the
 * `lastView` settings key reflects the real scenario.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeFixture(id: string): BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function settingsOf(boardId: string): Record<string, unknown> {
  return (boardCacheStore.cache[boardId]?.board.settings ?? {}) as Record<string, unknown>;
}

describe('TaskList lastView persist — targets the armed pane board (DI-08)', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard(null);
    vi.restoreAllMocks();
  });

  it('pane-scoped updateSettings writes lastView to its own board while a different board is active', () => {
    boardCacheStore.hydrate(
      { a: makeFixture('a'), b: makeFixture('b') },
      { a: 'a.board.json', b: 'b.board.json' },
    );

    const paneA = createBoardScope();
    const paneB = createBoardScope();
    paneA.board.setBoard(boardCacheStore.cache['a'].board);
    paneB.board.setBoard(boardCacheStore.cache['b'].board);

    // The user switched the active pane to board B (split view). Both the
    // active scope and the history active-board point at B — the exact
    // precondition that made A's surviving timer write into B.
    setActiveScope(paneB);
    historyStore.setActiveBoard('b');

    const lastView = {
      groupBy: 'status',
      sortBy: 'priority',
      filterTags: ['urgent'],
      filterStatus: null,
      filterPriority: null,
      showCompleted: true,
      smartList: 'all',
    };

    // Board A's persist timer fires against ITS pane scope (the fix path).
    paneA.board.updateSettings({ lastView });

    // A got its lastView; B's settings are untouched.
    expect(settingsOf('a').lastView).toEqual(lastView);
    expect(settingsOf('b')).not.toHaveProperty('lastView');
    // B's (active) undo stack is untouched — the non-undoable write pushes
    // no command anywhere.
    expect(historyStore.canUndo).toBe(false);
  });

  it('the OLD undoable path from a non-active pane would have polluted board B (contrast)', () => {
    // Pins down WHY the fix switched away from updateBoardSettingsWithHistory:
    // the command captures the global active board and files onto its stack.
    boardCacheStore.hydrate(
      { a: makeFixture('a'), b: makeFixture('b') },
      { a: 'a.board.json', b: 'b.board.json' },
    );

    const paneA = createBoardScope();
    const paneB = createBoardScope();
    paneA.board.setBoard(boardCacheStore.cache['a'].board);
    paneB.board.setBoard(boardCacheStore.cache['b'].board);
    setActiveScope(paneB);
    historyStore.setActiveBoard('b');

    // Even though this is paneA's facade, the command targets the GLOBAL
    // active board (B) and commitExecute files synchronously onto B's stack.
    paneA.board.updateBoardSettingsWithHistory({ lastView: { sortBy: 'title' } }, {}, 'Change task view');

    // canUndo reads the active board's (B's) stack — it now has an entry,
    // exactly the cross-board undo pollution DI-08 eliminates.
    expect(historyStore.canUndo).toBe(true);
  });
});

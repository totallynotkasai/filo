import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { createBoardScope } from '@renderer/lib/boards/boardScopeFactory';
import { setActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * IMPL_PLAN_2026-05-26 / Item 1 — Inactive pane silently rebinds the global
 * active-board id.
 *
 * `historyStore.activeBoardId` is a process-global signal that points at the
 * board whose undo/redo stack Ctrl+Z hits. The correct owner of this signal
 * is `PaneView.svelte`'s `isActive`-gated `$effect` (lines 59-65) — only the
 * pane the user has activated should drive it.
 *
 * The bug: `boardScope.board.setBoard()` previously called
 * `historyStore.setActiveBoard(board.id)` unconditionally. An inactive
 * pane's `BoardRouter` re-derives its `tab` whenever any tab is renamed /
 * reordered / the project shape changes — at which point the inactive
 * pane's `setBoard()` ran and hijacked the global signal. Ctrl+Z then
 * routed to the inactive pane's board's undo stack — wrong undo, subtle
 * data-loss risk.
 *
 * This test pins the fix: invoking `setBoard()` on a *non-active* scope
 * must not call `historyStore.setActiveBoard`. The follow-up test exercises
 * the user-observable consequence — undo still pops the active board's
 * stack after the inactive pane churns.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapFixture(id: string): V7BoardFileData {
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

describe('historyStore.activeBoardId — inactive pane does not hijack', () => {
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

  it("inactive pane's setBoard does not call historyStore.setActiveBoard", () => {
    const fixtureA = makeMindMapFixture('a');
    const fixtureB = makeMindMapFixture('b');
    boardCacheStore.hydrate(
      { a: fixtureA, b: fixtureB },
      { a: 'a.board.json', b: 'b.board.json' },
    );

    const paneA = createBoardScope();
    const paneB = createBoardScope();

    // Pane A is the active pane.
    setActiveScope(paneA);
    paneA.board.setBoard(fixtureA.board);
    historyStore.setActiveBoard('a');

    // Now spy on setActiveBoard so we can detect any further mutations.
    const spy = vi.spyOn(historyStore, 'setActiveBoard');

    // Pane B is INACTIVE. Its `BoardRouter` $effect re-derives `tab` for
    // any tab-array mutation and fires `scope.board.setBoard(boardB)`.
    // The fix: this call must NOT touch the global active-board signal —
    // PaneView's `isActive`-gated effect is the sole owner.
    paneB.board.setBoard(fixtureB.board);

    expect(spy).not.toHaveBeenCalled();
  });

  it('undo continues to pop the active pane stack after the inactive pane churns', async () => {
    const fixtureA = makeMindMapFixture('a');
    const fixtureB = makeMindMapFixture('b');
    boardCacheStore.hydrate(
      { a: fixtureA, b: fixtureB },
      { a: 'a.board.json', b: 'b.board.json' },
    );

    const paneA = createBoardScope();
    const paneB = createBoardScope();
    setActiveScope(paneA);
    paneA.board.setBoard(fixtureA.board);
    historyStore.setActiveBoard('a');

    // Push a no-op onto board A's stack so undo has something to do.
    let undidA = false;
    await historyStore.execute({
      description: 'noop-a',
      execute: () => {},
      undo: () => {
        undidA = true;
      },
    });

    // Pane B churns — pre-fix this would re-target historyStore at B.
    paneB.board.setBoard(fixtureB.board);

    // Undo must still hit A's stack.
    await historyStore.undo();
    expect(undidA).toBe(true);
  });
});

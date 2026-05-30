import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Regression: a freshly-added waypoint used to appear on the minimap but be
 * invisible on the main canvas. Root cause: `boardStore` is built by spreading
 * slices (`...waypointsGroupsSlice`), and object spread invokes getters once
 * and copies their resulting values as static properties. The slice's
 * `get waypoints()` therefore evaluated when `currentBoard` was still null,
 * leaving `boardStore.waypoints` permanently bound to an empty array. The
 * minimap read `boardStore.current.waypoints` directly and was unaffected.
 *
 * Fix lives in `board.svelte.ts` — defines live `waypoints` / `groups` getters
 * on the facade via `Object.defineProperties` after the spreads, so reads
 * resolve against the current `currentBoard`. This test pins the slice getter
 * and the direct read to the same value after `addWaypoint`.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapFixture(): V7BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
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

describe('boardStore.addWaypoint', () => {
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

  it('exposes the new waypoint via both the slice getter and `current.waypoints`', () => {
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
    boardStore.setBoard(fixture.board, {}, {}, []);

    expect(boardStore.waypoints.length).toBe(0);
    expect((boardStore.current as MindMapBoard).waypoints.length).toBe(0);

    boardStore.addWaypoint({ id: 'wp1', name: 'Home', x: 100, y: 200 });

    expect(boardStore.waypoints.length).toBe(1);
    expect((boardStore.current as MindMapBoard).waypoints.length).toBe(1);
    expect(boardStore.waypoints[0].id).toBe('wp1');
    expect((boardStore.current as MindMapBoard).waypoints[0].id).toBe('wp1');
  });
});

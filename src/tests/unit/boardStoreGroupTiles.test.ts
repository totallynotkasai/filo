import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Group `displayIndex` drives the small number badge rendered above every
 * tile that belongs to the group. It is monotonic per board — deleting an
 * older group must never renumber a younger one — and a merge always mints
 * a fresh index because the merged set is semantically a different group.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapFixture(): BoardFileData {
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
      groups: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('boardStore.groupTiles — displayIndex', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
    boardStore.setBoard(fixture.board, {}, {}, []);
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('assigns displayIndex 1 to the first group', () => {
    boardStore.groupTiles(['t1', 't2']);
    const groups = boardStore.groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].displayIndex).toBe(1);
  });

  it('increments displayIndex monotonically across independent group creations', () => {
    boardStore.groupTiles(['t1', 't2']);
    boardStore.groupTiles(['t3', 't4']);
    boardStore.groupTiles(['t5', 't6']);
    const groups = boardStore.groups;
    expect(groups.map(g => g.displayIndex).sort()).toEqual([1, 2, 3]);
  });

  it('keeps later groups stable when an earlier group is ungrouped', () => {
    boardStore.groupTiles(['t1', 't2']); // displayIndex 1
    boardStore.groupTiles(['t3', 't4']); // displayIndex 2
    boardStore.groupTiles(['t5', 't6']); // displayIndex 3
    boardStore.ungroupTiles(['t1']);     // removes group 1
    const remaining = boardStore.groups;
    expect(remaining.map(g => g.displayIndex).sort()).toEqual([2, 3]);
  });

  it('mints a fresh displayIndex when a group merges into an existing one', () => {
    boardStore.groupTiles(['t1', 't2']); // displayIndex 1
    boardStore.groupTiles(['t3', 't4']); // displayIndex 2
    // Grouping a tile already in group 1 with two new ones merges them and
    // must take a brand-new index (3), not the old 1.
    boardStore.groupTiles(['t1', 't5', 't6']);
    const groups = boardStore.groups;
    // Two groups remain: the untouched {t3,t4} group with index 2 and the
    // merged group containing t1,t2,t5,t6 with index 3.
    expect(groups).toHaveLength(2);
    const indices = groups.map(g => g.displayIndex).sort();
    expect(indices).toEqual([2, 3]);
    const mergedGroup = groups.find(g => g.displayIndex === 3);
    expect(mergedGroup?.tileIds.sort()).toEqual(['t1', 't2', 't5', 't6']);
  });

  it('exposes the group through getGroupForTile so tile components can read displayIndex', () => {
    boardStore.groupTiles(['t1', 't2']);
    boardStore.groupTiles(['t3', 't4']);
    expect(boardStore.getGroupForTile('t1')?.displayIndex).toBe(1);
    expect(boardStore.getGroupForTile('t3')?.displayIndex).toBe(2);
    expect(boardStore.getGroupForTile('unknown')).toBeUndefined();
  });
});

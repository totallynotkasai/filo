import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { ToggleGroupCommand, ToggleLockCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TileGroup } from '@renderer/schema/index';
import { seedBoard } from '../helpers/seedBoard';

/**
 * Phase 10.2 — ToggleGroupCommand and ToggleLockCommand.
 *
 * Both snapshot prior state so undo restores it exactly:
 *   - ToggleGroupCommand snapshots the full groups[] array (cheap; groups are
 *     shallow). Captures the case where a group operation merged two existing
 *     groups into a new one — undo restores both originals.
 *   - ToggleLockCommand snapshots per-tile lock state (Map<tileId, boolean>)
 *     so a mixed selection (some locked, some not) round-trips faithfully.
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
      placements: {
        a: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false },
        b: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false },
        c: { x: 0, y: 0, width: 100, height: 100, locked: true, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
      groups: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      a: { id: 'a', type: 'text', filePath: 'A.md', style: { headerColor: '', bodyColor: '', borderColor: '' }, createdAt: 0, updatedAt: 0 },
      b: { id: 'b', type: 'text', filePath: 'B.md', style: { headerColor: '', bodyColor: '', borderColor: '' }, createdAt: 0, updatedAt: 0 },
      c: { id: 'c', type: 'text', filePath: 'C.md', style: { headerColor: '', bodyColor: '', borderColor: '' }, createdAt: 0, updatedAt: 0 },
    },
    connections: {},
    frames: [],
  };
}

function activate(): MindMapBoard {
  const fixture = makeMindMapFixture();
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  const tiles = boardCacheStore.getFullTilesForBoard('mm');
  seedBoard(boardStore, fixture.board, tiles, {}, []);
  return boardStore.current as MindMapBoard;
}

describe('ToggleGroupCommand', () => {
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

  it('group → undo restores empty groups', () => {
    activate();
    const groupsBefore = [...boardStore.groups];
    const cmd = new ToggleGroupCommand(['a', 'b'], 'group', groupsBefore);
    cmd.execute();
    expect(boardStore.groups.length).toBe(1);
    expect(boardStore.groups[0].tileIds.sort()).toEqual(['a', 'b']);
    cmd.undo();
    expect(boardStore.groups.length).toBe(0);
  });

  it('ungroup → undo restores the original group exactly', () => {
    activate();
    boardStore.groupTiles(['a', 'b']);
    const groupsBefore = [...boardStore.groups].map(
      (g) => ({ ...g, tileIds: [...g.tileIds] }) as TileGroup,
    );
    const cmd = new ToggleGroupCommand(['a', 'b'], 'ungroup', groupsBefore);
    cmd.execute();
    expect(boardStore.groups.length).toBe(0);
    cmd.undo();
    expect(boardStore.groups.length).toBe(1);
    expect(boardStore.groups[0].tileIds.sort()).toEqual(['a', 'b']);
  });

  it('merge → undo restores both original groups separately', () => {
    activate();
    // Two distinct groups first
    boardStore.groupTiles(['a', 'b']);
    // Force a second group via direct mutation (groupTiles would merge).
    const current = boardStore.current as MindMapBoard;
    current.groups = [...(current.groups ?? []), {
      id: 'g2',
      boardId: 'mm',
      tileIds: ['c'],
      displayIndex: 99,
    }];
    const groupsBefore = [...boardStore.groups].map(
      (g) => ({ ...g, tileIds: [...g.tileIds] }) as TileGroup,
    );

    // Group a + c — merges existing 'a'/'b' group with the singleton 'c'.
    const cmd = new ToggleGroupCommand(['a', 'c'], 'group', groupsBefore);
    cmd.execute();
    expect(boardStore.groups.length).toBe(1);
    expect(boardStore.groups[0].tileIds.sort()).toEqual(['a', 'b', 'c']);

    cmd.undo();
    // Both originals restored.
    expect(boardStore.groups.length).toBe(2);
    const restored = boardStore.groups.map((g) => g.tileIds.sort().join(','));
    expect(restored.sort()).toEqual(['a,b', 'c']);
  });

  it('description reflects the action', () => {
    const group = new ToggleGroupCommand(['a', 'b'], 'group', []);
    expect(group.description).toBe('Group 2 tiles');
    const ungroup = new ToggleGroupCommand(['a', 'b'], 'ungroup', []);
    expect(ungroup.description).toBe('Ungroup 2 tiles');
  });
});

describe('ToggleLockCommand', () => {
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

  it('locks all tiles on execute and restores per-tile prior state on undo', () => {
    activate();
    // a: false → true, b: false → true, c: true → true (no-op but recorded)
    const prevStates = new Map<string, boolean>([
      ['a', false], ['b', false], ['c', true],
    ]);
    const cmd = new ToggleLockCommand(prevStates, true);
    cmd.execute();
    expect(boardStore.getTile('a')?.locked).toBe(true);
    expect(boardStore.getTile('b')?.locked).toBe(true);
    expect(boardStore.getTile('c')?.locked).toBe(true);
    cmd.undo();
    // 'a' and 'b' return to false, 'c' stays true.
    expect(boardStore.getTile('a')?.locked).toBe(false);
    expect(boardStore.getTile('b')?.locked).toBe(false);
    expect(boardStore.getTile('c')?.locked).toBe(true);
  });

  it('unlocks restoring mixed prior state', () => {
    activate();
    const prevStates = new Map<string, boolean>([
      ['a', true], ['b', false],
    ]);
    const cmd = new ToggleLockCommand(prevStates, false);
    cmd.execute();
    expect(boardStore.getTile('a')?.locked).toBe(false);
    expect(boardStore.getTile('b')?.locked).toBe(false);
    cmd.undo();
    expect(boardStore.getTile('a')?.locked).toBe(true);
    expect(boardStore.getTile('b')?.locked).toBe(false);
  });

  it('description reflects direction and count', () => {
    const lock = new ToggleLockCommand(new Map([['a', false], ['b', false]]), true);
    expect(lock.description).toBe('Lock 2 tile(s)');
    const unlock = new ToggleLockCommand(new Map([['a', true]]), false);
    expect(unlock.description).toBe('Unlock 1 tile(s)');
  });

  it('snapshots the Map so caller mutation does not leak in', () => {
    activate();
    const prev = new Map<string, boolean>([['a', false]]);
    const cmd = new ToggleLockCommand(prev, true);
    prev.set('a', true);
    cmd.execute();
    cmd.undo();
    // Should restore to the original false, not the post-construction true.
    expect(boardStore.getTile('a')?.locked).toBe(false);
  });
});

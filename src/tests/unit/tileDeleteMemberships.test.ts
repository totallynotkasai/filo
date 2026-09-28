/**
 * Deleting a Mind Map tile takes it out of every frame and group it was in,
 * and undo puts it back. A reference left behind made the next open report
 * "pruned orphan refs" as an error and write a recovery snapshot, for a
 * routine delete.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { DeleteTilesCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Frame, MindMapBoard, TextTile, Tile, TileGroup } from '@renderer/schema/index';
import { installMemoryVault } from '../helpers/memoryVault';
import { seedBoard } from '../helpers/seedBoard';

function textTile(id: string): TextTile {
  return {
    id,
    boardId: 'mm',
    type: 'text',
    title: id,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {
      headerColor: '#fff', bodyColor: '#fff', borderColor: '#000',
      shape: 'rounded', borderStyle: 'solid', borderWidth: 1, shadowIntensity: 0.3,
    } as never,
    tags: [],
    locked: false,
    faded: false,
    filePath: `${id}.md`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TextTile;
}

function frame(id: string, tileIds: string[]): Frame {
  return {
    id, boardId: 'mm', title: id, position: { x: 0, y: 0 }, size: { width: 500, height: 400 },
    tileIds, collapsed: false, locked: false, style: {},
  } as unknown as Frame;
}

function setup(): void {
  const tiles: Record<string, TextTile> = { t1: textTile('t1'), t2: textTile('t2'), t3: textTile('t3') };
  const placements: Record<string, unknown> = {};
  for (const id of Object.keys(tiles)) placements[id] = { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false };
  const groups: TileGroup[] = [
    { id: 'g-pair', boardId: 'mm', tileIds: ['t1', 't2'] },
    { id: 'g-solo', boardId: 'mm', tileIds: ['t1'] },
  ];
  const fixture: BoardFileData = {
    board: {
      id: 'mm', type: 'mindmap', name: 'Map', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      placements, inlineTiles: {}, waypoints: [], groups,
    } as unknown as MindMapBoard,
    tileDefs: tiles as unknown as BoardFileData['tileDefs'],
    connections: {},
    frames: [frame('f1', ['t1', 't2']), frame('f2', ['t3'])],
  };
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'Map.board.json' });
  seedBoard(boardStore, fixture.board, tiles as unknown as Record<string, Tile>, {}, fixture.frames);
}

const frameIds = (id: string): string[] => boardCacheStore.cache.mm?.frames.find((f) => f.id === id)?.tileIds ?? [];
const groups = (): TileGroup[] => (boardCacheStore.cache.mm?.board as MindMapBoard).groups ?? [];

describe('a deleted tile leaves its frames and groups, and undo puts it back', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    installMemoryVault({ 't1.md': 'one', 't2.md': 'two', 't3.md': 'three' });
    vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
    setup();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
  });

  it('delete: no frame or group still names the tile; a group left empty goes', async () => {
    const cmd = new DeleteTilesCommand(['t1']);
    await cmd.execute();
    expect(frameIds('f1')).toEqual(['t2']);
    expect(frameIds('f2')).toEqual(['t3']);
    expect(groups()).toEqual([{ id: 'g-pair', boardId: 'mm', tileIds: ['t2'] }]);
  });

  it('undo: the tile is back in its frame and both its groups', async () => {
    const cmd = new DeleteTilesCommand(['t1']);
    await cmd.execute();
    await cmd.undo();
    expect(boardStore.getTile('t1')).toBeDefined();
    expect([...frameIds('f1')].sort()).toEqual(['t1', 't2']);
    expect(frameIds('f2')).toEqual(['t3']);
    const byId = Object.fromEntries(groups().map((g) => [g.id, [...g.tileIds].sort()]));
    expect(byId).toEqual({ 'g-pair': ['t1', 't2'], 'g-solo': ['t1'] });
  });

  it('redo takes it out again', async () => {
    const cmd = new DeleteTilesCommand(['t1']);
    await cmd.execute();
    await cmd.undo();
    await cmd.execute();
    expect(frameIds('f1')).toEqual(['t2']);
    expect(groups().map((g) => g.id)).toEqual(['g-pair']);
  });

  it('undo does not put back a tile the user took out of a group meanwhile, other than the deleted one', async () => {
    const cmd = new DeleteTilesCommand(['t1']);
    await cmd.execute();
    // t2 ungrouped after the delete: the pair group is gone.
    (boardCacheStore.cache.mm!.board as MindMapBoard).groups = [];
    await cmd.undo();
    const byId = Object.fromEntries(groups().map((g) => [g.id, g.tileIds]));
    expect(byId).toEqual({ 'g-pair': ['t1'], 'g-solo': ['t1'] });
  });
});

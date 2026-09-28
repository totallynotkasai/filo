import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { DeleteTilesCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, Tile, TileDefinition } from '@renderer/schema/index';
import { seedBoard } from '../helpers/seedBoard';

/**
 * The tile header's Delete (with or without "delete the file too") runs
 * DeleteTilesCommand on a Kanban board as well. Undo must put the card back in
 * its column at its place: Kanban's addTile restores only the definition, so a
 * card undone without its column placement was invisible (and its def an
 * orphan in the board file).
 */

function def(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    title: id,
    filePath: `${id}.md`,
    content: '',
    tags: [],
    style: {
      headerColor: '#fff', bodyColor: '#fff', borderColor: '#000',
      shape: 'rounded', borderStyle: 'solid', borderWidth: 1, shadowIntensity: 0.3,
    },
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function kanbanFixture(): BoardFileData {
  const board = {
    id: 'kb',
    type: 'kanban',
    name: 'Board',
    emoji: '',
    createdAt: 0,
    updatedAt: 0,
    settings: {},
    columns: [
      {
        id: 'todo',
        title: 'To do',
        tilePlacements: [
          { tileId: 'a', position: 0 },
          { tileId: 'b', position: 1, style: { borderColor: '#ff0000' } },
          { tileId: 'c', position: 2 },
        ],
      },
      { id: 'done', title: 'Done', tilePlacements: [{ tileId: 'd', position: 0 }] },
    ],
  } as unknown as KanbanBoard;
  return {
    board,
    tileDefs: { a: def('a'), b: def('b'), c: def('c'), d: def('d') },
    connections: {},
    frames: [],
  };
}

function columnOrder(): Record<string, string[]> {
  const kb = boardCacheStore.cache.kb.board as KanbanBoard;
  return Object.fromEntries((kb.columns ?? []).map((c) => [c.id, (c.tilePlacements ?? []).map((p) => p.tileId)]));
}

describe('DeleteTilesCommand on a Kanban board', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
    const fixture = kanbanFixture();
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'Board.board.json' });
    seedBoard(boardStore, fixture.board, fixture.tileDefs as unknown as Record<string, Tile>, {}, []);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
  });

  it('undo puts the card back in its column, at its place, with its card style', async () => {
    const cmd = new DeleteTilesCommand(['b']);
    await cmd.execute();
    expect(columnOrder()).toEqual({ todo: ['a', 'c'], done: ['d'] });
    expect(boardCacheStore.cache.kb.tileDefs.b).toBeUndefined();

    await cmd.undo();
    expect(columnOrder()).toEqual({ todo: ['a', 'b', 'c'], done: ['d'] });
    expect(boardCacheStore.cache.kb.tileDefs.b).toBeDefined();
    const kb = boardCacheStore.cache.kb.board as KanbanBoard;
    const b = kb.columns[0].tilePlacements.find((p) => p.tileId === 'b');
    expect(b?.style).toEqual({ borderColor: '#ff0000' });
  });

  it('undo of a multi-card delete across columns restores every card', async () => {
    const cmd = new DeleteTilesCommand(['a', 'd']);
    await cmd.execute();
    expect(columnOrder()).toEqual({ todo: ['b', 'c'], done: [] });

    await cmd.undo();
    expect(columnOrder()).toEqual({ todo: ['a', 'b', 'c'], done: ['d'] });
  });

  it('redo after undo removes the cards again', async () => {
    const cmd = new DeleteTilesCommand(['c']);
    await cmd.execute();
    await cmd.undo();
    await cmd.execute();
    expect(columnOrder()).toEqual({ todo: ['a', 'b'], done: ['d'] });
    expect(boardCacheStore.cache.kb.tileDefs.c).toBeUndefined();
  });
});

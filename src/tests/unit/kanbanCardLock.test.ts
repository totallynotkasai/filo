import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import {
  KanbanTilePlacementSchema,
  type TileDefinition,
  type KanbanBoard,
  type KanbanTilePlacement,
} from '@renderer/schema/index';

/**
 * A Kanban card's lock is board structure: it lives on the card's placement
 * in the board file (the def schema has no `locked`), so a lock survives a
 * save and reload and the same note can be locked on one board only.
 */

function installFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function fixture(): BoardFileData {
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

function textDef(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${id}.md`,
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

function placement(tileId: string): KanbanTilePlacement | undefined {
  const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
  return cols.flatMap((c) => c.tilePlacements).find((p) => p.tileId === tileId);
}

describe('Kanban card lock', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: fixture() }, { kb: 'tasks.board.json' });
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', textDef('t1'), 0);
  });
  afterEach(() => {
    boardCacheStore.clear();
  });

  it('locking a card writes the placement and the card shows locked', () => {
    boardCacheStore.persistUpdateTile('t1', { locked: true }, 'kb');
    expect(placement('t1')?.locked).toBe(true);
    expect(boardCacheStore.getFullTilesForKanbanBoard('kb').t1.locked).toBe(true);
  });

  it('unlocking removes the field', () => {
    boardCacheStore.persistUpdateTile('t1', { locked: true }, 'kb');
    boardCacheStore.persistUpdateTile('t1', { locked: false }, 'kb');
    expect(placement('t1')).not.toHaveProperty('locked');
    expect(boardCacheStore.getFullTilesForKanbanBoard('kb').t1.locked).toBe(false);
  });

  it('the board file keeps the lock through a parse', () => {
    const parsed = KanbanTilePlacementSchema.parse({ tileId: 't1', position: 0, locked: true });
    expect(parsed.locked).toBe(true);
    expect(() => KanbanTilePlacementSchema.parse({ tileId: 't1', position: 0, locked: 'yes' })).toThrow();
  });
});

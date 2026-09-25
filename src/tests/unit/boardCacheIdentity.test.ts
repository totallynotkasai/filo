/**
 * Audit 5.5 / 5.6 — board sub-object mutators refresh cache identity.
 *
 * 5.5: `updateBoardSettings` used to mutate `cached.board.settings` in place
 *      and then ref-copy the SAME entry, leaving a transient window where the
 *      cache map pointed at the old entry while `board.settings` had already
 *      changed.
 * 5.6: the per-type `removeTile` ops (and `removeKanbanPlacement`) mutated
 *      `board.placements` / `board.columns` / `board.tasks` in place but only
 *      spread `tileDefs` / `connections` into `updateEntry`, carrying the same
 *      `board` reference forward.
 *
 * Both are latent today (deep-proxy reactivity still fires), but they violate
 * the spread-to-update convention and would bite any future identity check on
 * `board`. These tests assert each path yields a FRESH `board` object.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type {
  KanbanBoard,
  MindMapBoard,
  TaskListBoard,
  TileDefinition,
} from '@renderer/schema/index';
import { restoreFiloDefault } from '../helpers/filoBridge';

function mkDef(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    title: id,
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function makeMindMapWith(tileId: string): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'M',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        [tileId]: { x: 0, y: 0, width: 240, height: 160, locked: false, faded: false },
      },
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as unknown as MindMapBoard,
    tileDefs: { [tileId]: mkDef(tileId) },
    connections: {},
    frames: [],
  };
}

function makeKanbanWith(tileId: string): BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'c1',
          title: 'To Do',
          position: 0,
          collapsed: false,
          tilePlacements: [{ tileId, position: 0 }],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { [tileId]: mkDef(tileId) },
    connections: {},
    frames: [],
  };
}

function makeTaskListWith(tileId: string): BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'T',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      tasks: [{ tileId, position: 0 }],
      sections: [],
      collapsedSubtasks: [],
    } as unknown as TaskListBoard,
    tileDefs: { [tileId]: mkDef(tileId) },
    connections: {},
    frames: [],
  };
}

describe('Audit 5.5/5.6 — board mutators refresh cache identity', () => {
  beforeEach(() => {
    boardCacheStore.clear();
  });
  afterEach(() => {
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  it('5.5 updateBoardSettings replaces the board object and applies settings', () => {
    boardCacheStore.hydrate({ kb: makeKanbanWith('t1') }, { kb: 'k.board.json' });
    const before = boardCacheStore.cache.kb.board;
    boardCacheStore.updateBoardSettings('kb', { foo: 'bar' });
    const after = boardCacheStore.cache.kb.board;
    expect(after).not.toBe(before);
    expect((after as { settings: Record<string, unknown> }).settings).toEqual({ foo: 'bar' });
  });

  it('5.6 mindmap removeTile refreshes the board identity and drops the placement', () => {
    boardCacheStore.hydrate({ mm: makeMindMapWith('t1') }, { mm: 'm.board.json' });
    const before = boardCacheStore.cache.mm.board;
    boardCacheStore.persistRemoveTile('t1');
    const after = boardCacheStore.cache.mm.board;
    expect(after).not.toBe(before);
    expect((after as MindMapBoard).placements?.t1).toBeUndefined();
  });

  it('5.6 kanban removeKanbanPlacement refreshes the board identity', () => {
    boardCacheStore.hydrate({ kb: makeKanbanWith('t1') }, { kb: 'k.board.json' });
    const before = boardCacheStore.cache.kb.board;
    boardCacheStore.removeKanbanPlacement('kb', 't1');
    const after = boardCacheStore.cache.kb.board;
    expect(after).not.toBe(before);
  });

  it('5.6 tasklist removeTile refreshes the board identity', () => {
    boardCacheStore.hydrate({ tl: makeTaskListWith('t1') }, { tl: 't.board.json' });
    const before = boardCacheStore.cache.tl.board;
    boardCacheStore.persistRemoveTile('t1');
    const after = boardCacheStore.cache.tl.board;
    expect(after).not.toBe(before);
  });
});

/**
 * Phase 2 — direct contract tests for `boardTileOpsRegistry`.
 *
 * The characterization suite (`deleteTileEntryPoints.test.ts`) covers the
 * dispatcher-level post-condition. This file targets the *strategy
 * implementations* directly so a regression in one per-type op surfaces
 * with a precise failure message instead of being absorbed by the
 * dispatcher's tile-resolution fallbacks.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import {
  boardTileOpsRegistry,
  opsFor,
} from '@renderer/core/boardTileOps';
import {
  boardConnectionsOpsRegistry,
  connectionsOpsFor,
} from '@renderer/core/boardConnectionsOps';
import {
  boardFramesOpsRegistry,
  framesOpsFor,
} from '@renderer/core/boardFramesOps';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type {
  Connection,
  Frame,
  KanbanBoard,
  TaskListBoard,
  MindMapBoard,
  DocumentBoard,
  TileDefinition,
} from '@renderer/schema/index';
import { restoreFiloDefault } from '../helpers/filoBridge';

function mkDef(id: string, title = id): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${title}.md`,
    style: { headerColor: '#000', bodyColor: '#fff', borderColor: '' } as never,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function mindmapEnv(tileId: string): BoardFileData {
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

function kanbanEnv(tileId: string): BoardFileData {
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
          tilePlacements: [
            { tileId, position: 0 },
            { tileId: `${tileId}_neighbour`, position: 1 },
          ],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {
      [tileId]: mkDef(tileId),
      [`${tileId}_neighbour`]: mkDef(`${tileId}_neighbour`, 'Neighbour'),
    },
    connections: {},
    frames: [],
  };
}

function tasklistEnv(tileId: string): BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'T',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      tasks: [
        { tileId, position: 0 },
        { tileId: `${tileId}_neighbour`, position: 1 },
      ],
      sections: [
        { id: 's1', title: 'Top', position: 0, collapsed: false },
        { id: 's2', title: 'Tail', position: 1, collapsed: false },
      ],
      collapsedSubtasks: [],
    } as unknown as TaskListBoard,
    tileDefs: {
      [tileId]: mkDef(tileId),
      [`${tileId}_neighbour`]: mkDef(`${tileId}_neighbour`, 'Neighbour'),
    },
    connections: {},
    frames: [],
  };
}

function documentEnv(): BoardFileData {
  return {
    board: {
      id: 'doc',
      type: 'document',
      name: 'D',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      filePath: 'D.md',
    } as unknown as DocumentBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('boardTileOpsRegistry — exhaustive coverage', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  it('exposes one ops entry per BoardType', () => {
    expect(Object.keys(boardTileOpsRegistry).sort()).toEqual([
      'document',
      'kanban',
      'mindmap',
      'tasklist',
    ]);
    for (const [key, ops] of Object.entries(boardTileOpsRegistry)) {
      expect(ops.type).toBe(key);
    }
  });

  it('opsFor dispatches by board.type', () => {
    expect(opsFor(mindmapEnv('t').board).type).toBe('mindmap');
    expect(opsFor(kanbanEnv('t').board).type).toBe('kanban');
    expect(opsFor(tasklistEnv('t').board).type).toBe('tasklist');
    expect(opsFor(documentEnv().board).type).toBe('document');
  });

  describe('Kanban ops', () => {
    it('removeTile drops the def, the column placement, and renumbers survivors', () => {
      const env = kanbanEnv('tile_a');
      boardCacheStore.hydrate({ kb: env }, { kb: 'k.board.json' });

      boardCacheStore.persistRemoveTile('tile_a');

      const kb = boardCacheStore.cache.kb.board as KanbanBoard;
      const placements = kb.columns[0].tilePlacements ?? [];
      expect(placements.map((p) => p.tileId)).toEqual(['tile_a_neighbour']);
      expect(placements[0].position).toBe(0);
      expect(boardCacheStore.cache.kb.tileDefs.tile_a).toBeUndefined();
      expect(boardCacheStore.cache.kb.tileDefs.tile_a_neighbour).toBeDefined();
    });

    it('updateTile merges definition fields only (no placement geometry)', () => {
      const env = kanbanEnv('tile_a');
      boardCacheStore.hydrate({ kb: env }, { kb: 'k.board.json' });

      boardCacheStore.persistUpdateTile('tile_a', {
        title: 'Renamed',
        titleHtml: '<strong>Renamed</strong>',
        tags: ['urgent'],
        position: { x: 999, y: 999 },
      });

      const def = boardCacheStore.cache.kb.tileDefs.tile_a as unknown as Record<string, unknown>;
      // The formatted title is board-owned; a text card's title and tags
      // live in its note, so the def never stores them.
      expect(def.titleHtml).toBe('<strong>Renamed</strong>');
      expect(def.title).toBeUndefined();
      expect(def.tags).toBeUndefined();
      // Position is a MindMap-only field; Kanban def shouldn't carry it.
      expect(def.position).toBeUndefined();
    });

    it('getFullTiles fuses defs with column placements', () => {
      const env = kanbanEnv('tile_a');
      boardCacheStore.hydrate({ kb: env }, { kb: 'k.board.json' });

      const tiles = boardCacheStore.getFullTilesForBoard('kb');
      expect(Object.keys(tiles).sort()).toEqual(['tile_a', 'tile_a_neighbour']);
      expect(tiles.tile_a.boardId).toBe('kb');
    });

    it('listPlacementIds returns every tileId across columns', () => {
      const env = kanbanEnv('tile_a');
      const ids = boardTileOpsRegistry.kanban.listPlacementIds(env);
      expect(ids.sort()).toEqual(['tile_a', 'tile_a_neighbour']);
    });
  });

  describe('Task List ops', () => {
    it('removeTile drops def + tasks entry and shifts section positions', () => {
      const env = tasklistEnv('tile_a');
      boardCacheStore.hydrate({ tl: env }, { tl: 't.board.json' });

      boardCacheStore.persistRemoveTile('tile_a');

      const tl = boardCacheStore.cache.tl.board as TaskListBoard;
      expect(tl.tasks.map((t) => t.tileId)).toEqual(['tile_a_neighbour']);
      expect(tl.tasks[0].position).toBe(0);
      expect(boardCacheStore.cache.tl.tileDefs.tile_a).toBeUndefined();
      // Section that started AT the removed task's index stays put (the
      // tail section started at 1 and follows the removed task down to 0).
      const sections = tl.sections;
      expect(sections.find((s) => s.id === 's1')?.position).toBe(0);
      expect(sections.find((s) => s.id === 's2')?.position).toBe(0);
    });

    it('updateTile merges definition fields only', () => {
      const env = tasklistEnv('tile_a');
      boardCacheStore.hydrate({ tl: env }, { tl: 't.board.json' });

      boardCacheStore.persistUpdateTile('tile_a', {
        title: 'Renamed task',
        titleHtml: '<em>Renamed task</em>',
        size: { width: 9999, height: 9999 },
      });

      const def = boardCacheStore.cache.tl.tileDefs.tile_a as unknown as Record<string, unknown>;
      expect(def.titleHtml).toBe('<em>Renamed task</em>');
      // A task's title lives in its note, never on the def.
      expect(def.title).toBeUndefined();
      expect(def.size).toBeUndefined();
    });

    it('getFullTiles fuses defs with task placements', () => {
      const env = tasklistEnv('tile_a');
      boardCacheStore.hydrate({ tl: env }, { tl: 't.board.json' });

      const tiles = boardCacheStore.getFullTilesForBoard('tl');
      expect(Object.keys(tiles).sort()).toEqual(['tile_a', 'tile_a_neighbour']);
      expect(tiles.tile_a.boardId).toBe('tl');
    });

    it('listPlacementIds returns the flat tasks[] tileIds', () => {
      const env = tasklistEnv('tile_a');
      const ids = boardTileOpsRegistry.tasklist.listPlacementIds(env);
      expect(ids).toEqual(['tile_a', 'tile_a_neighbour']);
    });
  });

  describe('Document ops', () => {
    it('removeTile / updateTile are no-ops; getFullTiles returns {}', () => {
      const env = documentEnv();
      boardCacheStore.hydrate({ doc: env }, { doc: 'd.board.json' });

      // No throw and no state mutation.
      boardCacheStore.persistRemoveTile('any');
      boardCacheStore.persistUpdateTile('any', { title: 'x' });

      const tiles = boardCacheStore.getFullTilesForBoard('doc');
      expect(tiles).toEqual({});
      expect(boardTileOpsRegistry.document.listPlacementIds(env)).toEqual([]);
    });
  });

  describe('MindMap ops parity', () => {
    it('removeTile sweeps placements + connections referencing the tile', () => {
      const env = mindmapEnv('tile_a');
      env.connections = {
        c1: {
          id: 'c1',
          boardId: 'mm',
          fromTileId: 'tile_a',
          toTileId: 'tile_b',
          fromBubble: 0,
          toBubble: 0,
          pathColor: '',
          arrowColor: '',
          visibility: 'visible',
          labelVisibility: 'visible',
          label: { text: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
          createdAt: 0,
          updatedAt: 0,
        } as BoardFileData['connections'][string],
      };
      boardCacheStore.hydrate({ mm: env }, { mm: 'm.board.json' });

      boardCacheStore.persistRemoveTile('tile_a');

      const mm = boardCacheStore.cache.mm.board as MindMapBoard;
      expect(mm.placements.tile_a).toBeUndefined();
      expect(boardCacheStore.cache.mm.connections.c1).toBeUndefined();
      expect(boardCacheStore.cache.mm.tileDefs.tile_a).toBeUndefined();
    });

    it('listPlacementIds includes placements + inline tiles', () => {
      const env = mindmapEnv('tile_a');
      (env.board as { inlineTiles: Record<string, unknown> }).inlineTiles.inline_t = {
        id: 'inline_t',
        type: 'timer',
        title: 'Timer',
        x: 0,
        y: 0,
        width: 120,
        height: 80,
      };
      const ids = boardTileOpsRegistry.mindmap.listPlacementIds(env);
      expect(ids.sort()).toEqual(['inline_t', 'tile_a']);
    });
  });
});

/**
 * Phase 6 — strategy registry coverage for the connections + frames slices.
 *
 * Today every board type's body is uniform, but the registry promotes the
 * mutators to a typed home so a future per-type divergence (document boards
 * forbidding connections, etc.) doesn't have to touch the dispatcher.
 * These tests assert the registry is exhaustive over `BoardType`, that
 * `connectionsOpsFor` / `framesOpsFor` dispatch by `board.type`, and that
 * each per-type op writes through the cache + project mirror.
 */
function makeConnection(id: string, boardId: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id,
    boardId,
    fromTileId: 'tile_a',
    toTileId: 'tile_b',
    fromBubble: 0,
    toBubble: 0,
    pathColor: '',
    arrowColor: '',
    visibility: 'visible',
    labelVisibility: 'visible',
    label: { text: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Connection;
}

function makeFrame(id: string, boardId: string, overrides: Partial<Frame> = {}): Frame {
  return {
    id,
    boardId,
    title: 'Frame',
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    style: {
      backgroundColor: '#2a2a3e',
      backgroundImage: '',
      backgroundOpacity: 1,
      borderColor: '#3a3a4e',
      borderStyle: 'solid',
      borderWidth: 1,
    },
    collapsed: false,
    tileIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Frame;
}

describe('boardConnectionsOpsRegistry — exhaustive coverage', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  it('exposes one ops entry per BoardType', () => {
    expect(Object.keys(boardConnectionsOpsRegistry).sort()).toEqual([
      'document',
      'kanban',
      'mindmap',
      'tasklist',
    ]);
    for (const [key, ops] of Object.entries(boardConnectionsOpsRegistry)) {
      expect(ops.type).toBe(key);
    }
  });

  it('connectionsOpsFor dispatches by board.type', () => {
    expect(connectionsOpsFor(mindmapEnv('t').board).type).toBe('mindmap');
    expect(connectionsOpsFor(kanbanEnv('t').board).type).toBe('kanban');
    expect(connectionsOpsFor(tasklistEnv('t').board).type).toBe('tasklist');
    expect(connectionsOpsFor(documentEnv().board).type).toBe('document');
  });

  it('mindmap addConnection writes through cache + project mirror', () => {
    boardCacheStore.hydrate({ mm: mindmapEnv('tile_a') }, { mm: 'm.board.json' });
    const conn = makeConnection('c1', 'mm');
    boardCacheStore.persistAddConnection(conn);
    expect(boardCacheStore.cache.mm.connections.c1).toBeDefined();
    expect((boardCacheStore.cache.mm.connections.c1 as Connection).boardId).toBe('mm');
  });

  it('mindmap updateConnection replaces the cached entry', () => {
    boardCacheStore.hydrate({ mm: mindmapEnv('tile_a') }, { mm: 'm.board.json' });
    const seeded = makeConnection('c1', 'mm');
    boardCacheStore.persistAddConnection(seeded);
    const updated = { ...seeded, pathColor: '#abcdef' };
    boardCacheStore.persistUpdateConnection('c1', updated as Connection);
    expect((boardCacheStore.cache.mm.connections.c1 as Connection).pathColor).toBe('#abcdef');
  });

  it('mindmap removeConnection drops the cached entry', () => {
    boardCacheStore.hydrate({ mm: mindmapEnv('tile_a') }, { mm: 'm.board.json' });
    const seeded = makeConnection('c1', 'mm');
    boardCacheStore.persistAddConnection(seeded);
    boardCacheStore.persistRemoveConnection('c1', seeded);
    expect(boardCacheStore.cache.mm.connections.c1).toBeUndefined();
  });

  it('kanban / tasklist / document ops apply identical cache writes', () => {
    // Connections live in the board file shape for every board type. The
    // registry promotes the writes to a typed home so a future per-type
    // divergence has somewhere to land; today every body is uniform.
    for (const [name, env] of [
      ['kanban', kanbanEnv('tile_a')] as const,
      ['tasklist', tasklistEnv('tile_a')] as const,
      ['document', documentEnv()] as const,
    ]) {
      boardCacheStore.clear();
      const id = name;
      boardCacheStore.hydrate({ [id]: env }, { [id]: `${id}.board.json` });
      const conn = makeConnection(`c_${name}`, id, { fromTileId: 'tile_a', toTileId: 'tile_a' });
      // Explicit boardId on the connection — cache-scan fallback isn't
      // needed for kanban/tasklist/document tile resolution in this test.
      boardCacheStore.persistAddConnection(conn);
      expect((boardCacheStore.cache[id].connections[`c_${name}`] as Connection)?.boardId).toBe(id);
      boardCacheStore.persistRemoveConnection(`c_${name}`, conn);
      expect(boardCacheStore.cache[id].connections[`c_${name}`]).toBeUndefined();
    }
  });
});

describe('boardFramesOpsRegistry — exhaustive coverage', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  it('exposes one ops entry per BoardType', () => {
    expect(Object.keys(boardFramesOpsRegistry).sort()).toEqual([
      'document',
      'kanban',
      'mindmap',
      'tasklist',
    ]);
    for (const [key, ops] of Object.entries(boardFramesOpsRegistry)) {
      expect(ops.type).toBe(key);
    }
  });

  it('framesOpsFor dispatches by board.type', () => {
    expect(framesOpsFor(mindmapEnv('t').board).type).toBe('mindmap');
    expect(framesOpsFor(kanbanEnv('t').board).type).toBe('kanban');
    expect(framesOpsFor(tasklistEnv('t').board).type).toBe('tasklist');
    expect(framesOpsFor(documentEnv().board).type).toBe('document');
  });

  it('mindmap addFrame appends to cache + project mirror', () => {
    boardCacheStore.hydrate({ mm: mindmapEnv('tile_a') }, { mm: 'm.board.json' });
    const frame = makeFrame('f1', 'mm');
    boardCacheStore.persistAddFrame(frame);
    const stored = boardCacheStore.cache.mm.frames.find((f) => f.id === 'f1');
    expect(stored?.boardId).toBe('mm');
  });

  it('mindmap updateFrame replaces in-place', () => {
    boardCacheStore.hydrate({ mm: mindmapEnv('tile_a') }, { mm: 'm.board.json' });
    const seeded = makeFrame('f1', 'mm');
    boardCacheStore.persistAddFrame(seeded);
    const updated: Frame = { ...seeded, title: 'Renamed' };
    boardCacheStore.persistUpdateFrame('f1', updated);
    expect(
      boardCacheStore.cache.mm.frames.find((f) => f.id === 'f1')?.title,
    ).toBe('Renamed');
  });

  it('mindmap removeFrame drops the cached entry', () => {
    boardCacheStore.hydrate({ mm: mindmapEnv('tile_a') }, { mm: 'm.board.json' });
    const seeded = makeFrame('f1', 'mm');
    boardCacheStore.persistAddFrame(seeded);
    boardCacheStore.persistRemoveFrame('f1', seeded);
    expect(boardCacheStore.cache.mm.frames.find((f) => f.id === 'f1')).toBeUndefined();
  });

  it('kanban / tasklist / document ops apply identical cache writes', () => {
    for (const [name, env] of [
      ['kanban', kanbanEnv('tile_a')] as const,
      ['tasklist', tasklistEnv('tile_a')] as const,
      ['document', documentEnv()] as const,
    ]) {
      boardCacheStore.clear();
      const id = name;
      boardCacheStore.hydrate({ [id]: env }, { [id]: `${id}.board.json` });
      const frame = makeFrame(`f_${name}`, id);
      boardCacheStore.persistAddFrame(frame);
      expect(
        boardCacheStore.cache[id].frames.find((f) => f.id === `f_${name}`)?.boardId,
      ).toBe(id);
      boardCacheStore.persistRemoveFrame(`f_${name}`, frame);
      expect(boardCacheStore.cache[id].frames.find((f) => f.id === `f_${name}`)).toBeUndefined();
    }
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Connection, MindMapBoard } from '@renderer/schema/index';

/**
 * Connection-persistence regression: the original `persistUpdateConnection`
 * silently no-op'd whenever `conn.boardId` was missing or empty. Customizations
 * to such connections (legacy data, or connections created while no board was
 * active) never reached disk, so closing/reopening the app reverted the styling.
 *
 * These tests lock in the cache-scan fallback that now resolves the owning
 * board from `boardCache[*].connections[id]` (for update/remove) or from
 * either tile endpoint's owning board (for add).
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler> = {}): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
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
      placements: {
        t1: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false },
        t2: { x: 200, y: 0, width: 100, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: { id: 't1', type: 'text', title: 'A', style: {} as never, tags: [], createdAt: 0, updatedAt: 0 } as never,
      t2: { id: 't2', type: 'text', title: 'B', style: {} as never, tags: [], createdAt: 0, updatedAt: 0 } as never,
    },
    connections: {},
    frames: [],
  };
}

function makeConnection(id: string, boardId: string): Connection {
  return {
    id,
    boardId,
    fromTileId: 't1',
    toTileId: 't2',
    fromBubble: 3,
    toBubble: 7,
    pathType: 'curved',
    pathColor: '',
    pathSize: 2,
    pathStyle: 'solid',
    arrowType: 'none',
    arrowColor: '',
    arrowSize: 10,
    visibility: 'visible',
    labelVisibility: 'visible',
    label: { text: '', color: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
    createdAt: 0,
    updatedAt: 0,
  } as Connection;
}

describe('boardCache — connection persistence', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );
  });
  afterEach(() => boardCacheStore.clear());

  it('persistAddConnection with boardId="" resolves via the fromTileId endpoint', () => {
    const conn = makeConnection('c1', '');
    boardCacheStore.persistAddConnection(conn);
    const cached = boardCacheStore.cache.mm.connections.c1;
    expect(cached).toBeDefined();
    // Self-heal: the stored copy must have the resolved boardId stamped.
    expect((cached as Connection).boardId).toBe('mm');
  });

  it('persistUpdateConnection with boardId="" still writes via cache scan', () => {
    // Seed an existing connection on the board so cache-scan can locate it.
    const seeded = makeConnection('c1', 'mm');
    boardCacheStore.persistAddConnection(seeded);

    // Style edit arrives without boardId (the regression scenario).
    const stylePatch: Connection = {
      ...seeded,
      boardId: '',
      pathType: 'elbow',
      pathColor: '#ff0000',
      arrowType: 'both',
    } as Connection;
    boardCacheStore.persistUpdateConnection('c1', stylePatch);

    const stored = boardCacheStore.cache.mm.connections.c1 as Connection;
    expect(stored.pathType).toBe('elbow');
    expect(stored.pathColor).toBe('#ff0000');
    expect(stored.arrowType).toBe('both');
    // Self-heal: boardId is repaired on the stored copy.
    expect(stored.boardId).toBe('mm');
  });

  it('persistRemoveConnection with boardId="" still drops via cache scan', () => {
    const seeded = makeConnection('c1', 'mm');
    boardCacheStore.persistAddConnection(seeded);

    boardCacheStore.persistRemoveConnection('c1', { ...seeded, boardId: '' } as Connection);
    expect(boardCacheStore.cache.mm.connections.c1).toBeUndefined();
  });

  it('warns and drops the write only when neither boardId nor cache scan can resolve', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Connection refers to tiles that do not exist anywhere in the cache.
    const orphan: Connection = {
      ...makeConnection('orphan', ''),
      fromTileId: 'ghost-from',
      toTileId: 'ghost-to',
    } as Connection;
    boardCacheStore.persistAddConnection(orphan);

    expect(boardCacheStore.cache.mm.connections.orphan).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('persistAddConnection: cannot resolve boardId'),
    );
    warn.mockRestore();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { createBoardScope } from '@renderer/lib/boards/boardScopeFactory';
import { setActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, KanbanBoard, Tile, Frame, Connection } from '@renderer/schema/index';

/**
 * Phase R7 (Reactive BoardScope) — two `BoardScope` instances pointed at the
 * same `board.id` must reactively share their tile / connection / frame view.
 * The legacy runtime/cache duality (each scope owned its own runtime `$state`
 * for tiles / connections / frames) meant pane A's edits were invisible to
 * pane B until the user re-activated pane B's tab. R7 collapses the pair: the
 * shared cache is the single source of truth and each scope's view is a
 * `$derived` projection of `boardCacheStore.cache[currentBoardId]`.
 *
 * These tests directly exercise that contract — bypass the active-pane facade
 * (`boardStore`) and instantiate two scopes inline so we can read pane B's
 * state without flipping the active pane.
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

function makeKanbanFixture(): V7BoardFileData {
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

function makeTextTile(id: string, x = 0, y = 0): Tile {
  return {
    id,
    boardId: 'mm',
    type: 'text',
    title: id,
    position: { x, y },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    locked: false,
    faded: false,
    tags: [],
    filePath: `${id}.md`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Tile;
}

function makeFrame(id: string, boardId: string): Frame {
  return {
    id,
    boardId,
    title: `Frame ${id}`,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    style: { backgroundImage: '', borderColor: '#000' },
    collapsed: false,
    tileIds: [],
    createdAt: 0,
    updatedAt: 0,
  } as Frame;
}

describe('Reactive BoardScope — split-pane parity', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });

  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('pane A addTile is reactively visible in pane B for the same board', async () => {
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });

    const paneA = createBoardScope();
    const paneB = createBoardScope();
    paneA.board.setBoard(fixture.board);
    paneB.board.setBoard(fixture.board);

    expect(Object.keys(paneA.board.tiles)).toEqual([]);
    expect(Object.keys(paneB.board.tiles)).toEqual([]);

    // Mutate through pane A by making it active first, then via paneA's API.
    setActiveScope(paneA);
    await paneA.board.addTile(makeTextTile('t1', 100, 100));

    expect(paneA.board.tiles.t1?.id).toBe('t1');
    // Pane B reads tiles from the same derived projection of the cache.
    expect(paneB.board.tiles.t1?.id).toBe('t1');
    expect(paneB.board.tiles.t1?.position).toEqual({ x: 100, y: 100 });
  });

  it('pane A updateTile is reactively visible in pane B', async () => {
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });

    const paneA = createBoardScope();
    const paneB = createBoardScope();
    paneA.board.setBoard(fixture.board);
    paneB.board.setBoard(fixture.board);
    setActiveScope(paneA);
    await paneA.board.addTile(makeTextTile('t1', 100, 100));

    // A text tile's title belongs to its note; titleHtml is a board-owned field.
    paneA.board.updateTile('t1', { titleHtml: '<p><strong>edited</strong></p>' });

    expect(paneA.board.tiles.t1?.titleHtml).toBe('<p><strong>edited</strong></p>');
    expect(paneB.board.tiles.t1?.titleHtml).toBe('<p><strong>edited</strong></p>');
  });

  it('pane A removeTile is reactively visible in pane B', async () => {
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });

    const paneA = createBoardScope();
    const paneB = createBoardScope();
    paneA.board.setBoard(fixture.board);
    paneB.board.setBoard(fixture.board);
    setActiveScope(paneA);
    await paneA.board.addTile(makeTextTile('t1', 100, 100));
    await paneA.board.addTile(makeTextTile('t2', 200, 200));

    paneA.board.removeTile('t1');

    expect(Object.keys(paneA.board.tiles).sort()).toEqual(['t2']);
    expect(Object.keys(paneB.board.tiles).sort()).toEqual(['t2']);
  });

  it('pane A addConnection is reactively visible in pane B', async () => {
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });

    const paneA = createBoardScope();
    const paneB = createBoardScope();
    paneA.board.setBoard(fixture.board);
    paneB.board.setBoard(fixture.board);
    setActiveScope(paneA);
    await paneA.board.addTile(makeTextTile('t1', 0, 0));
    await paneA.board.addTile(makeTextTile('t2', 300, 0));

    const conn: Connection = {
      id: 'c1',
      boardId: 'mm',
      fromTileId: 't1',
      toTileId: 't2',
      fromBubble: 0,
      toBubble: 0,
      style: {},
      label: '',
      createdAt: 0,
      updatedAt: 0,
    } as Connection;
    paneA.board.addConnection(conn);

    expect(paneA.board.connections.c1?.id).toBe('c1');
    expect(paneB.board.connections.c1?.id).toBe('c1');
  });

  it('pane A addFrame is reactively visible in pane B', () => {
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });

    const paneA = createBoardScope();
    const paneB = createBoardScope();
    paneA.board.setBoard(fixture.board);
    paneB.board.setBoard(fixture.board);
    setActiveScope(paneA);

    paneA.board.addFrame(makeFrame('f1', 'mm'));

    expect(paneA.board.frames.map((f) => f.id)).toEqual(['f1']);
    expect(paneB.board.frames.map((f) => f.id)).toEqual(['f1']);
  });

  it('pane A updateSettings reflects in pane B without a re-activation', () => {
    const fixture = makeKanbanFixture();
    boardCacheStore.hydrate({ kb: fixture }, { kb: 't.board.json' });

    const paneA = createBoardScope();
    const paneB = createBoardScope();
    paneA.board.setBoard(fixture.board);
    paneB.board.setBoard(fixture.board);
    setActiveScope(paneA);

    paneA.board.updateSettings({ groupBy: 'priority' });

    const settingsA = paneA.board.settings as Record<string, unknown> | null;
    const settingsB = paneB.board.settings as Record<string, unknown> | null;
    expect(settingsA?.groupBy).toBe('priority');
    expect(settingsB?.groupBy).toBe('priority');
  });

  it('two scopes pinned to different boards do NOT cross-pollute', async () => {
    const mm = makeMindMapFixture();
    const kb = makeKanbanFixture();
    boardCacheStore.hydrate(
      { mm, kb },
      { mm: 'm.board.json', kb: 't.board.json' },
    );

    const paneMm = createBoardScope();
    const paneKb = createBoardScope();
    paneMm.board.setBoard(mm.board);
    paneKb.board.setBoard(kb.board);
    setActiveScope(paneMm);

    await paneMm.board.addTile(makeTextTile('t1', 100, 100));

    expect(Object.keys(paneMm.board.tiles)).toEqual(['t1']);
    // Kanban pane is pinned to a different board; the new tile must not bleed.
    expect(Object.keys(paneKb.board.tiles)).toEqual([]);
  });

  it('boardStore.current returns the same proxy as cache[id].board', () => {
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });

    const pane = createBoardScope();
    pane.board.setBoard(fixture.board);

    expect(pane.board.current).toBe(boardCacheStore.cache.mm.board);
  });
});

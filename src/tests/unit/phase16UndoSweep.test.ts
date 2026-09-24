/**
 * Phase 16 (Sprint E / H1-H7) regression guard.
 *
 * Each H-item from the audit gets one or two cases asserting the new
 * command round-trips. The component-level wiring (TileHeader trash,
 * Frame drag handlers, kanban context menus) is tested at the command
 * layer here; full E2E coverage of the click paths lives in Playwright.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import {
  AddTileTagCommand,
  RemoveTileTagCommand,
  UpdateFrameCommand,
  MoveFrameCommand,
  DeleteCardCommand,
  MoveCardsCommand,
  BatchCommand,
} from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type {
  Frame,
  KanbanBoard,
  MindMapBoard,
  Tile,
  TileDefinition,
} from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function installSilentBridge(): void {
  installFiloMock(() => null);
}

// ── H6: history clear on vault swap (vaultStore is hard to exercise in
// jsdom, so we just verify historyStore.clear() drops everything). ──

describe('historyStore.clear (H6 — vault swap)', () => {
  beforeEach(() => { installSilentBridge(); });
  afterEach(() => { restoreFiloDefault(); historyStore.clear(); });

  it('drops undo/redo stacks for every board', () => {
    historyStore.setActiveBoard('board-A');
    historyStore.pushWithoutExecute({
      description: 'noop',
      execute() {},
      undo() {},
    });
    expect(historyStore.canUndo).toBe(true);

    historyStore.clear();
    historyStore.setActiveBoard('board-A');
    expect(historyStore.canUndo).toBe(false);
    historyStore.setActiveBoard('board-B');
    expect(historyStore.canUndo).toBe(false);
  });
});

// ── H2: AddTileTagCommand / RemoveTileTagCommand ──

/** A link tile owns its tags on the board def, so its tag edits are pure
 *  cache writes (a note's tags live in its frontmatter instead). */
function makeMindMapWithLinkTile(tags: string[] = []): V7BoardFileData {
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
        t1: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'link',
        title: 'A',
        url: 'https://example.com',
        style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
        tags,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  };
}

/** The link tile's tags as stored on its board def. */
function linkTags(): string[] {
  const def = boardCacheStore.cache.mm?.tileDefs.t1;
  return def?.type === 'link' ? def.tags : [];
}

describe('AddTileTagCommand / RemoveTileTagCommand (H2)', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
  });

  it('AddTileTagCommand round-trip via cache (tile-def fallback path)', async () => {
    // Hydrate the cache but skip setBoard: the tile is found through the
    // loaded boards' cache (not `boardStore.tiles`) and written with
    // `persistUpdateTile` on its home board.
    const fixture = makeMindMapWithLinkTile([]);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });

    const cmd = new AddTileTagCommand('t1', 'project');
    cmd.execute();
    expect(linkTags()).toContain('project');

    cmd.undo();
    expect(linkTags()).not.toContain('project');
  });

  it('RemoveTileTagCommand round-trip via cache', async () => {
    const fixture = makeMindMapWithLinkTile(['holiday']);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });

    const cmd = new RemoveTileTagCommand('t1', 'holiday');
    cmd.execute();
    expect(linkTags()).not.toContain('holiday');

    cmd.undo();
    expect(linkTags()).toContain('holiday');
  });
});

// ── H4: Frame commands ──

function makeMindMapWithFrame(): V7BoardFileData {
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
        t1: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        filePath: 'A.md',
        style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [
      {
        id: 'f1',
        boardId: 'mm',
        title: 'Frame',
        position: { x: 0, y: 0 },
        size: { width: 300, height: 300 },
        tileIds: ['t1'],
        collapsed: false,
        style: {},
        createdAt: 0,
        updatedAt: 0,
      } as unknown as Frame,
    ],
  };
}

describe('UpdateFrameCommand / MoveFrameCommand (H4)', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
  });

  it('UpdateFrameCommand round-trip on title', () => {
    const fixture = makeMindMapWithFrame();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
    boardStore.setBoard(fixture.board, {}, {}, fixture.frames);

    const cmd = new UpdateFrameCommand('f1', { title: 'Frame' }, { title: 'Renamed' });
    cmd.execute();
    expect(boardStore.frames[0]?.title).toBe('Renamed');
    cmd.undo();
    expect(boardStore.frames[0]?.title).toBe('Frame');
  });

  it('UpdateFrameCommand round-trip on collapsed', () => {
    const fixture = makeMindMapWithFrame();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
    boardStore.setBoard(fixture.board, {}, {}, fixture.frames);

    const cmd = new UpdateFrameCommand('f1', { collapsed: false }, { collapsed: true });
    cmd.execute();
    expect(boardStore.frames[0]?.collapsed).toBe(true);
    cmd.undo();
    expect(boardStore.frames[0]?.collapsed).toBe(false);
  });

  it('MoveFrameCommand moves contained tiles by the same delta', () => {
    const fixture = makeMindMapWithFrame();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
    const tileMap: Record<string, Tile> = {
      t1: {
        id: 't1',
        boardId: 'mm',
        type: 'text',
        title: 'A',
        position: { x: 50, y: 50 },
        size: { width: 200, height: 100 },
        style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
        locked: false,
        faded: false,
        tags: [],
        contentId: 'doc-1',
        filePath: 'A.md',
        content: '',
        createdAt: 0,
        updatedAt: 0,
      } as unknown as Tile,
    };
    boardStore.setBoard(fixture.board, tileMap, {}, fixture.frames);

    const cmd = new MoveFrameCommand(
      'f1',
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      ['t1'],
    );
    cmd.execute();
    expect(boardStore.frames[0]?.position).toEqual({ x: 100, y: 50 });
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 150, y: 100 });

    cmd.undo();
    expect(boardStore.frames[0]?.position).toEqual({ x: 0, y: 0 });
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 50, y: 50 });
  });
});

// ── H5: Kanban bulk delete / move (BatchCommand of DeleteCardCommand) ──

function makeKanbanWithCards(): V7BoardFileData {
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
        { id: 'col-1', title: 'Todo', position: 0, collapsed: false, tilePlacements: [
          { tileId: 't1', position: 0 },
          { tileId: 't2', position: 1 },
        ] },
        { id: 'col-2', title: 'Done', position: 1, collapsed: false, tilePlacements: [] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {
      t1: { id: 't1', type: 'text', filePath: 'A.md', style: { headerColor: '', bodyColor: '', borderColor: '' } as never, createdAt: 0, updatedAt: 0 } as unknown as TileDefinition,
      t2: { id: 't2', type: 'text', filePath: 'B.md', style: { headerColor: '', bodyColor: '', borderColor: '' } as never, createdAt: 0, updatedAt: 0 } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  };
}

describe('Kanban bulk ops via BatchCommand / MoveCardsCommand (H5)', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
  });

  it('BatchCommand of DeleteCardCommand undoes both cards', async () => {
    const fixture = makeKanbanWithCards();
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });

    const commands = [new DeleteCardCommand('kb', 't1'), new DeleteCardCommand('kb', 't2')];
    const batch = new BatchCommand('Remove 2 cards', commands);
    // Polish phase 2.2 — BatchCommand.execute() / undo() are async.
    await batch.execute();
    const col1 = (boardCacheStore.cache.kb?.board as KanbanBoard).columns[0];
    expect(col1.tilePlacements).toHaveLength(0);

    await batch.undo();
    const col1After = (boardCacheStore.cache.kb?.board as KanbanBoard).columns[0];
    expect(col1After.tilePlacements).toHaveLength(2);
    expect(col1After.tilePlacements[0].tileId).toBe('t1');
    expect(col1After.tilePlacements[1].tileId).toBe('t2');
  });

  it('MoveCardsCommand moves both cards and undo restores both', () => {
    const fixture = makeKanbanWithCards();
    boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });

    const cmd = new MoveCardsCommand('kb', ['t1', 't2'], 'col-2', 0, [
      { tileId: 't1', fromColumnId: 'col-1', fromPosition: 0 },
      { tileId: 't2', fromColumnId: 'col-1', fromPosition: 1 },
    ]);
    cmd.execute();
    const kb = boardCacheStore.cache.kb?.board as KanbanBoard;
    expect(kb.columns[0].tilePlacements).toHaveLength(0);
    expect(kb.columns[1].tilePlacements).toHaveLength(2);

    cmd.undo();
    const kbBack = boardCacheStore.cache.kb?.board as KanbanBoard;
    expect(kbBack.columns[0].tilePlacements).toHaveLength(2);
    expect(kbBack.columns[1].tilePlacements).toHaveLength(0);
  });
});

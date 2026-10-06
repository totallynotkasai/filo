/**
 * Style and saved-view undo steps record what they changed, key by key, and
 * undo or redo only that on the element as it stands. A change made since by
 * anything outside the history stays:
 * - a font size "Use Default Font Sizes for all Existing Items" cleared is not
 *   brought back by undoing an older colour change (tile, frame, card);
 * - a tag a vault-wide rename rewrote in one saved view is not renamed back by
 *   undoing the save of another view, and a view deleted then undone comes back
 *   in its place beside views added since.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  UpdateTileStyleCommand,
  UpdateFrameStyleCommand,
  UpdateKanbanCardStyleCommand,
  UpdateSavedViewsCommand,
  UpdateConnectionCommand,
} from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Board, Connection, Frame, KanbanBoard, MindMapBoard, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { seedBoard } from '../helpers/seedBoard';

const STYLE = { headerColor: '#111111', bodyColor: '', borderColor: '', fontSizeTitle: 20 };

function linkTile(): Tile {
  return {
    id: 't1', boardId: 'mm', type: 'link', title: 'Site', url: 'https://example.com',
    position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
    style: { ...STYLE }, tags: [], locked: false, faded: false, createdAt: 0, updatedAt: 0,
  } as unknown as Tile;
}

function mindMapBoard(frames: Frame[] = []): BoardFileData {
  return {
    board: {
      id: 'mm', type: 'mindmap', name: 'M', emoji: '', createdAt: 0, updatedAt: 0,
      settings: {}, placements: {}, inlineTiles: {}, waypoints: [], groups: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames,
  };
}

function kanban(savedViews: unknown[] = []): BoardFileData {
  return {
    board: {
      id: 'kb', type: 'kanban', name: 'K', emoji: '', createdAt: 0, updatedAt: 0,
      settings: { savedViews },
      columns: [{ id: 'c1', title: 'To do', collapsed: false, tilePlacements: [{ tileId: 'k1', style: { ...STYLE } }] }],
    } as unknown as KanbanBoard,
    tileDefs: { k1: { id: 'k1', type: 'text', filePath: 'Card.md', style: { headerColor: '', bodyColor: '' }, createdAt: 0, updatedAt: 0 } } as unknown as BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  };
}

const view = (id: string, name: string, filterTags: string[], sortBy = 'manual') => ({ id, name, sortBy, filterTags, filterProp: null });

function savedViews(): Array<{ id: string; name: string; sortBy: string; filterTags: string[] }> {
  return (boardCacheStore.cache.kb.board.settings as { savedViews: Array<{ id: string; name: string; sortBy: string; filterTags: string[] }> }).savedViews;
}

/** What "Use Default Font Sizes for all Existing Items" does to one style block. */
function withoutSize(style: Record<string, unknown>): Record<string, unknown> {
  const { fontSizeTitle: _dropped, ...rest } = style;
  void _dropped;
  return rest;
}

beforeEach(() => {
  installFiloMock(() => ({ success: true, ok: true }));
  vaultStore.setPath('/vault');
  boardCacheStore.clear();
});

afterEach(() => {
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultStore.setPath('');
  restoreFiloDefault();
});

describe('a style step undoes only the keys it changed', () => {
  it('a tile: undoing a colour change leaves a size cleared since cleared', () => {
    boardCacheStore.hydrate({ mm: mindMapBoard() }, { mm: 'm.board.json' });
    seedBoard(boardStore, mindMapBoard().board as Board, { t1: linkTile() });
    const after = { ...STYLE, headerColor: '#222222' };
    boardStore.updateTile('t1', { style: after as Tile['style'] });
    const cmd = new UpdateTileStyleCommand('t1', { style: { ...STYLE } as Tile['style'] }, { style: after as Tile['style'] }, 'mm');

    boardStore.updateTile('t1', { style: withoutSize(boardStore.getTile('t1')?.style as Record<string, unknown>) as Tile['style'] });

    cmd.undo();
    expect(boardStore.getTile('t1')?.style).toMatchObject({ headerColor: '#111111' });
    expect(boardStore.getTile('t1')?.style).not.toHaveProperty('fontSizeTitle');
    cmd.execute();
    expect(boardStore.getTile('t1')?.style).toMatchObject({ headerColor: '#222222' });
    expect(boardStore.getTile('t1')?.style).not.toHaveProperty('fontSizeTitle');
  });

  it('a frame: the same', () => {
    const frame = { id: 'f1', boardId: 'mm', title: 'F', position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, tileIds: [], style: { ...STYLE } } as unknown as Frame;
    const data = mindMapBoard([frame]);
    boardCacheStore.hydrate({ mm: data }, { mm: 'm.board.json' });
    boardStore.setBoard(data.board as Board);
    const after = { ...STYLE, headerColor: '#222222' };
    boardStore.updateFrame('f1', { style: after as Frame['style'] });
    const cmd = new UpdateFrameStyleCommand('f1', { ...STYLE } as Frame['style'], after as Frame['style'], 'mm');

    boardStore.updateFrame('f1', { style: withoutSize(boardStore.frames[0]?.style as Record<string, unknown>) as Frame['style'] });

    cmd.undo();
    expect(boardStore.frames[0]?.style).toMatchObject({ headerColor: '#111111' });
    expect(boardStore.frames[0]?.style).not.toHaveProperty('fontSizeTitle');
  });

  it('a connection: undoing a colour change leaves a label size cleared since cleared', () => {
    const data = mindMapBoard();
    data.connections = {
      c1: { id: 'c1', boardId: 'mm', fromTileId: 'a', toTileId: 'b', pathColor: '#111111', label: { text: 'goes to', fontSize: 18 } } as unknown as Connection,
    };
    boardCacheStore.hydrate({ mm: data }, { mm: 'm.board.json' });
    boardStore.setBoard(data.board as Board);
    const before = { pathColor: '#111111', label: { text: 'goes to', fontSize: 18 } } as Partial<Connection>;
    const after = { pathColor: '#222222', label: { text: 'goes to', fontSize: 18 } } as Partial<Connection>;
    boardStore.updateConnection('c1', after);
    const cmd = new UpdateConnectionCommand('c1', before, after, 'mm');

    boardStore.updateConnection('c1', { label: { text: 'goes to' } } as Partial<Connection>);

    cmd.undo();
    expect(boardStore.connections.c1?.pathColor).toBe('#111111');
    expect(boardStore.connections.c1?.label).toEqual({ text: 'goes to' });
  });

  it('a Kanban card: the same', () => {
    boardCacheStore.hydrate({ kb: kanban() }, { kb: 'k.board.json' });
    const after = { ...STYLE, headerColor: '#222222' };
    boardCacheStore.updateKanbanCardPlacementStyle('kb', 'k1', after);
    const cmd = new UpdateKanbanCardStyleCommand('kb', 'k1', { ...STYLE }, after);

    boardCacheStore.updateKanbanCardPlacementStyle('kb', 'k1', null);
    boardCacheStore.updateKanbanCardPlacementStyle('kb', 'k1', withoutSize(after));

    cmd.undo();
    const style = (boardCacheStore.cache.kb.board as KanbanBoard).columns[0]?.tilePlacements?.[0]?.style;
    expect(style).toMatchObject({ headerColor: '#111111' });
    expect(style).not.toHaveProperty('fontSizeTitle');
  });
});

describe('a saved-views step undoes only what it changed', () => {
  it('undoing "Save view" keeps a tag a rename rewrote in another view since', () => {
    const drafts = view('v1', 'Drafts', ['draft']);
    boardCacheStore.hydrate({ kb: kanban([drafts]) }, { kb: 'k.board.json' });
    const cmd = new UpdateSavedViewsCommand('kb', 'kanban', [drafts], [drafts, view('v2', 'Mine', [])]);
    cmd.execute();
    expect(savedViews().map((v) => v.id)).toEqual(['v1', 'v2']);

    // A vault-wide rename of #draft rewrites the first view's filter.
    boardCacheStore.setKanbanSavedViews('kb', [view('v1', 'Drafts', ['wip']), view('v2', 'Mine', [])] as never);

    cmd.undo();
    expect(savedViews()).toEqual([view('v1', 'Drafts', ['wip'])]);
    cmd.execute();
    expect(savedViews()).toEqual([view('v1', 'Drafts', ['wip']), view('v2', 'Mine', [])]);
  });

  it('undoing a delete puts the view back in its place, beside a view saved since', () => {
    const a = view('v1', 'A', []);
    const b = view('v2', 'B', []);
    boardCacheStore.hydrate({ kb: kanban([a, b]) }, { kb: 'k.board.json' });
    const cmd = new UpdateSavedViewsCommand('kb', 'kanban', [a, b], [b]);
    cmd.execute();
    boardCacheStore.setKanbanSavedViews('kb', [b, view('v3', 'C', [])] as never);

    cmd.undo();
    expect(savedViews().map((v) => v.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('undoing an overwrite changes back only the keys it set', () => {
    const before = view('v1', 'Drafts', ['draft']);
    boardCacheStore.hydrate({ kb: kanban([before]) }, { kb: 'k.board.json' });
    const cmd = new UpdateSavedViewsCommand('kb', 'kanban', [before], [view('v1', 'Drafts', ['draft'], 'title')]);
    cmd.execute();
    boardCacheStore.setKanbanSavedViews('kb', [view('v1', 'Drafts', ['wip'], 'title')] as never);

    cmd.undo();
    expect(savedViews()).toEqual([view('v1', 'Drafts', ['wip'], 'manual')]);
  });
});

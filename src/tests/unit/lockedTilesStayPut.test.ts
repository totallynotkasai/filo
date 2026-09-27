import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { alignTiles, layoutTree, layoutRadial } from '@renderer/lib/canvas/layout';
import { tilesToDrag, tileDragAction, isSelectionHandled } from '@renderer/lib/canvas/tileDrag';
import { selectionStore } from '@renderer/stores/selection.svelte';
import { getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { MoveFrameCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Frame, MindMapBoard, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A locked tile never moves: not when it is selected or grouped with a tile
 * being dragged, not in Align / Distribute / Tree / Radial layout, and not
 * when undo or redo replays a frame move that left it where it was.
 */

function makeTile(id: string, x: number, y: number, locked = false): Tile {
  return {
    id,
    type: 'text',
    title: id,
    position: { x, y },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    locked,
    faded: false,
    tags: [],
    boardId: 'mm',
    createdAt: 0,
    updatedAt: 0,
    filePath: `${id}.md`,
    content: '',
  } as unknown as Tile;
}

describe('layout leaves locked tiles in place', () => {
  const tiles: Record<string, Tile> = {
    a: makeTile('a', 0, 0),
    b: makeTile('b', 300, 50, true),
    c: makeTile('c', 600, 120),
  };

  it('Align Top moves the unlocked tiles and not the locked one', () => {
    const result = alignTiles(tiles, ['a', 'b', 'c'], 'top');
    expect(result.has('b')).toBe(false);
    expect(result.get('c')?.after).toEqual({ x: 600, y: 0 });
  });

  it('a locked tile still sets the line the others align to', () => {
    const result = alignTiles(tiles, ['a', 'b'], 'bottom');
    expect(result.has('b')).toBe(false);
    expect(result.get('a')?.after).toEqual({ x: 0, y: 50 });
  });

  it('Tree and Radial layout arrange only the unlocked tiles', () => {
    expect(layoutTree(tiles, {}, ['a', 'b', 'c']).has('b')).toBe(false);
    expect(layoutRadial(tiles, ['a', 'b', 'c']).has('b')).toBe(false);
  });
});

describe('a header drag moves the unlocked tiles only', () => {
  const tiles: Record<string, Tile> = {
    a: makeTile('a', 0, 0),
    b: makeTile('b', 300, 0, true),
    c: makeTile('c', 600, 0),
    g: makeTile('g', 900, 0, true),
  };
  const board = {
    getTile: (id: string): Tile | undefined => tiles[id],
    getGroupedTileIds: (id: string): string[] => (id === 'c' ? ['c', 'g'] : []),
  };

  it('a locked tile in the selection stays behind', () => {
    expect(tilesToDrag('a', ['a', 'b'], board).map((t) => t.id)).toEqual(['a']);
  });

  it('a locked group member stays behind', () => {
    expect(tilesToDrag('c', [], board).map((t) => t.id)).toEqual(['c']);
  });

  it('dragging an unselected tile moves only it', () => {
    expect(tilesToDrag('a', ['c'], board).map((t) => t.id)).toEqual(['a']);
  });
});

describe('frame move undo and redo leave a locked tile alone', () => {
  function fixture(): BoardFileData {
    return {
      board: {
        id: 'mm', type: 'mindmap', name: 'M', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      } as unknown as MindMapBoard,
      tileDefs: {},
      connections: {},
      frames: [
        {
          id: 'f1', title: 'Frame', position: { x: 0, y: 0 }, size: { width: 1000, height: 600 },
          tileIds: ['t1', 't2'], collapsed: false, style: {}, createdAt: 0, updatedAt: 0,
        } as unknown as Frame,
      ],
    };
  }

  beforeEach(() => {
    installFiloMock(() => null);
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

  it('only the tiles that travelled with the frame move back and forth', () => {
    const data = fixture();
    boardCacheStore.hydrate({ mm: data }, { mm: 'm.board.json' });
    boardStore.setBoard(data.board, {
      t1: makeTile('t1', 50, 50),
      t2: makeTile('t2', 400, 50, true),
    }, {}, data.frames);

    // The drag moved the frame and t1 by (100, 0); the locked t2 stayed.
    boardStore.updateFrame('f1', { position: { x: 100, y: 0 } });
    boardStore.updateTile('t1', { position: { x: 150, y: 50 } });
    const cmd = new MoveFrameCommand('f1', { x: 0, y: 0 }, { x: 100, y: 0 }, ['t1', 't2']);

    cmd.undo();
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 50, y: 50 });
    expect(boardStore.getTile('t2')?.position).toEqual({ x: 400, y: 50 });
    cmd.execute();
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 150, y: 50 });
    expect(boardStore.getTile('t2')?.position).toEqual({ x: 400, y: 50 });
  });
});

describe('Ctrl-click on a locked tile toggles its selection once', () => {
  afterEach(() => {
    selectionStore.clear();
    document.body.innerHTML = '';
  });

  it('the header marks the click handled, so the tile container does not toggle it back', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    const action = tileDragAction(node, { tileId: 'locked-1', locked: true, scope: getActiveScope() });
    const ev = new MouseEvent('pointerdown', { button: 0, ctrlKey: true, bubbles: true, cancelable: true });
    node.dispatchEvent(ev);
    expect(selectionStore.isSelected('locked-1')).toBe(true);
    // The container's own pointerdown sees the same event and must skip it.
    expect(isSelectionHandled(ev)).toBe(true);
    action.destroy();
  });
});

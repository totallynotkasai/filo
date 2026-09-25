/**
 * Actions on a multi-tile selection: Lock / Unlock and Style apply to every
 * selected tile, and each is one undo step.
 *
 * The Style case mounts the real TileStylePopup with a `tileIds` list, picks
 * values through its controls, closes it, and undoes once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import TileStylePopup from '@renderer/components/tiles/TileStylePopup.svelte';
import { BOARD_SCOPE_KEY, getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { toggleLockSelection } from '@renderer/lib/boards/toggleLockSelection';
import { createSelectionActions } from '@renderer/lib/mindmap/selectionActions';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { settle } from './helpers/mountEditor';

const STYLE = { headerColor: '', bodyColor: '', borderColor: '' };

function def(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id, style: { ...STYLE }, boardId: 'mm', position: { x: 0, y: 0 },
    size: { width: 100, height: 100 }, createdAt: 0, updatedAt: 0, locked: false, faded: false,
    ...extra,
  };
}

function fixture(): BoardFileData {
  const placement = (locked: boolean): Record<string, unknown> =>
    ({ x: 0, y: 0, width: 100, height: 100, locked, faded: false });
  return {
    board: {
      id: 'mm', type: 'mindmap', name: 'Map', emoji: '', createdAt: 0, updatedAt: 0,
      settings: {},
      placements: { a: placement(false), b: placement(true), img: placement(false) },
      inlineTiles: {}, waypoints: [], groups: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      a: def('a', { type: 'text', filePath: 'A.md' }),
      b: def('b', { type: 'text', filePath: 'B.md', locked: true }),
      img: def('img', { type: 'image', title: 'Photo', src: 'pic.png' }),
    } as unknown as BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  };
}

function tile(id: string): Tile {
  const t = boardStore.getTile(id);
  if (!t) throw new Error(`no tile ${id}`);
  return t;
}

beforeEach(() => {
  installFiloMock(() => null);
  vaultStore.setPath('/vault');
  boardCacheStore.clear();
  boardStore.clearBoard();
  const f = fixture();
  boardCacheStore.hydrate({ mm: f }, { mm: 'map.board.json' });
  boardStore.setBoard(f.board, boardCacheStore.getFullTilesForBoard('mm'), {}, []);
  historyStore.clear();
  historyStore.setActiveBoard('mm');
});

afterEach(() => {
  historyStore.clear();
  historyStore.setActiveBoard(null);
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultStore.setPath('');
  restoreFiloDefault();
  document.body.innerHTML = '';
});

describe('toggleLockSelection', () => {
  it('locks every tile when any is unlocked, and one undo restores the mixed state', async () => {
    expect(toggleLockSelection(boardStore, ['a', 'b', 'img'])).toBe(true);
    await historyStore.whenChainSettled();
    expect([tile('a').locked, tile('b').locked, tile('img').locked]).toEqual([true, true, true]);

    await historyStore.undo();
    expect([tile('a').locked, tile('b').locked, tile('img').locked]).toEqual([false, true, false]);
    expect(historyStore.canUndo).toBe(false);
  });

  it('unlocks every tile when all are locked', async () => {
    toggleLockSelection(boardStore, ['a', 'b']);
    await historyStore.whenChainSettled();
    expect(toggleLockSelection(boardStore, ['a', 'b'])).toBe(false);
    await historyStore.whenChainSettled();
    expect([tile('a').locked, tile('b').locked]).toEqual([false, false]);
  });

  it('ignores ids that are not tiles', () => {
    expect(toggleLockSelection(boardStore, ['nope'])).toBeNull();
    expect(historyStore.canUndo).toBe(false);
  });
});

describe('createSelectionActions (tile and canvas menus)', () => {
  function actions(selected: string[]): {
    a: ReturnType<typeof createSelectionActions>;
    styleCalls: unknown[][];
  } {
    const styleCalls: unknown[][] = [];
    const a = createSelectionActions({
      board: boardStore,
      selection: { selectedIds: new Set(selected), clear: () => {} },
      openTileStyle: (...args) => { styleCalls.push(args); },
      openTagEditor: () => {},
    });
    return { a, styleCalls };
  }

  it('Lock / Unlock covers the whole selection, not just the clicked tile', async () => {
    actions(['a', 'b', 'img']).a.toggleLock();
    await historyStore.whenChainSettled();
    expect([tile('a').locked, tile('b').locked, tile('img').locked]).toEqual([true, true, true]);
    await historyStore.undo();
    expect([tile('a').locked, tile('b').locked, tile('img').locked]).toEqual([false, true, false]);
  });

  it('Style is seeded from the right-clicked tile and lists every selected tile', () => {
    const { a, styleCalls } = actions(['a', 'gone', 'img']);
    a.openStyle('img', 5, 6);
    expect((styleCalls[0]?.[0] as Tile).id).toBe('img');
    expect(styleCalls[0]?.slice(1)).toEqual([5, 6, ['a', 'img']]);
    a.openStyle(null, 5, 6);
    expect((styleCalls[1]?.[0] as Tile).id).toBe('a');
  });
});

describe('TileStylePopup with several tiles', () => {
  async function openPopup(tileIds: string[]): Promise<{ target: HTMLElement; close(): Promise<void> }> {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(TileStylePopup, {
      target,
      props: { tile: tile('a'), tileIds, x: 10, y: 10, onclose: () => {} },
      context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]),
    });
    await settle();
    return {
      target,
      close: async () => {
        await unmount(component);
        await settle();
      },
    };
  }

  function change(el: HTMLInputElement | HTMLSelectElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('applies each pick to every tile and undoes the whole session in one step', async () => {
    const popup = await openPopup(['a', 'b', 'img']);
    expect(document.body.textContent).toContain('Style: 3 tiles');

    change(document.getElementById('tile-shape') as HTMLSelectElement, 'rounded');
    change(document.getElementById('tile-fs-title') as HTMLInputElement, '20');
    change(document.getElementById('tile-fs-body') as HTMLInputElement, '18');

    for (const id of ['a', 'b', 'img']) {
      expect(tile(id).style.shape).toBe('rounded');
      expect(tile(id).style.fontSizeTitle).toBe(20);
    }
    // Only text tiles render a body font size.
    expect(tile('a').style.fontSizeBody).toBe(18);
    expect(tile('b').style.fontSizeBody).toBe(18);
    expect(tile('img').style.fontSizeBody).toBeUndefined();

    await settle();
    await popup.close();
    expect(historyStore.canUndo).toBe(true);

    await historyStore.undo();
    for (const id of ['a', 'b', 'img']) {
      expect(tile(id).style.shape).toBeUndefined();
      expect(tile(id).style.fontSizeTitle).toBeUndefined();
      expect(tile(id).style.fontSizeBody).toBeUndefined();
    }
    expect(historyStore.canUndo).toBe(false);
  });

  it('hides Body Font Size when no target is a text tile', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(TileStylePopup, {
      target,
      props: { tile: tile('img'), x: 10, y: 10, onclose: () => {} },
      context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]),
    });
    await settle();
    expect(document.getElementById('tile-fs-body')).toBeNull();
    expect(document.body.textContent).toContain('Tile Style');
    await unmount(component);
  });

  it('pushes nothing when nothing changed', async () => {
    const popup = await openPopup(['a', 'b']);
    await popup.close();
    expect(historyStore.canUndo).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { canvasStore } from '@renderer/stores/canvas.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { connectionsStore } from '@renderer/stores/connections.svelte';
import { isCanvasKeyBlocked } from '@renderer/lib/mindmap/mindMapKeyboard';
import { MarqueeSelectionController } from '@renderer/lib/mindmap/marqueeSelectionController.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';
import type { CanvasScope } from '@renderer/stores/canvas.svelte';
import type { SelectionScope } from '@renderer/stores/selection.svelte';
import type { SpatialScope } from '@renderer/stores/spatial.svelte';

/**
 * Mind Map keys and toggles: shortcuts stay out of dialogs, menus and a
 * focused control's own keys; "Snap Tiles" is saved on the board; hidden
 * tiles can't be box-selected; a connection can't join two boards.
 */

describe('isCanvasKeyBlocked', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  function add(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
  }

  it('lets keys through with nothing focused', () => {
    expect(isCanvasKeyBlocked('n', document.body)).toBe(false);
    expect(isCanvasKeyBlocked('Enter', null)).toBe(false);
  });

  it('blocks every key while a modal dialog is open, even with focus on the body', () => {
    add('<div role="dialog" aria-modal="true"><button>OK</button></div>');
    expect(isCanvasKeyBlocked('n', document.body)).toBe(true);
    expect(isCanvasKeyBlocked('Backspace', document.body)).toBe(true);
  });

  it('blocks keys typed inside a menu or popup', () => {
    const host = add('<div role="menu"><button role="menuitem">Snap Tiles</button></div>');
    expect(isCanvasKeyBlocked('ArrowDown', host.querySelector('button'))).toBe(true);
    expect(isCanvasKeyBlocked('c', host.querySelector('button'))).toBe(true);
  });

  it('leaves Enter and Space to a focused button, but N still creates a tile', () => {
    const host = add('<button>New tile</button>');
    const btn = host.querySelector('button');
    expect(isCanvasKeyBlocked('Enter', btn)).toBe(true);
    expect(isCanvasKeyBlocked(' ', btn)).toBe(true);
    expect(isCanvasKeyBlocked('n', btn)).toBe(false);
    expect(isCanvasKeyBlocked('Backspace', btn)).toBe(false);
  });

  it('leaves the arrows to a focused tab strip', () => {
    const host = add('<div role="tablist"><div role="tab" tabindex="0">A</div></div>');
    expect(isCanvasKeyBlocked('ArrowRight', host.querySelector('[role="tab"]'))).toBe(true);
  });

  it('blocks everything while typing in a field', () => {
    const host = add('<input type="text">');
    expect(isCanvasKeyBlocked('n', host.querySelector('input'))).toBe(true);
  });
});

describe('Snap Tiles is saved on the board', () => {
  function fixture(snapToGrid: boolean): BoardFileData {
    return {
      board: {
        id: 'mm', type: 'mindmap', name: 'Map', emoji: '', createdAt: 0, updatedAt: 0,
        settings: { semanticZoom: true, snapToGrid },
        viewport: { x: 0, y: 0, scale: 1 }, placements: {}, inlineTiles: {}, waypoints: [], groups: [],
      } as unknown as MindMapBoard,
      tileDefs: {}, connections: {}, frames: [],
    };
  }

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).filo = { invoke: async () => null, on: () => () => {}, send: () => {} };
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('opening a board applies its saved snap setting', () => {
    const data = fixture(true);
    boardCacheStore.hydrate({ mm: data }, { mm: 'map.board.json' });
    boardStore.setBoard(data.board, {}, {}, []);
    expect(canvasStore.snapEnabled).toBe(true);
  });

  it('toggling writes settings.snapToGrid and flips the canvas', () => {
    const data = fixture(false);
    boardCacheStore.hydrate({ mm: data }, { mm: 'map.board.json' });
    boardStore.setBoard(data.board, {}, {}, []);
    expect(canvasStore.snapEnabled).toBe(false);
    boardStore.toggleSnapToGrid();
    expect(canvasStore.snapEnabled).toBe(true);
    const saved = (boardCacheStore.cache.mm?.board as { settings: Record<string, unknown> }).settings;
    expect(saved.snapToGrid).toBe(true);
  });
});

describe('box selection skips tiles hidden in a collapsed frame', () => {
  it('selects only the visible tiles the box covers', () => {
    let selected: string[] = [];
    const marquee = new MarqueeSelectionController({
      canvas: { transform: { x: 0, y: 0, scale: 1 } } as unknown as CanvasScope,
      selection: {
        startBox: () => {},
        updateBox: () => {},
        get boxRect() { return { left: 0, top: 0, right: 100, bottom: 100 }; },
        selectMultiple: (ids: string[]) => { selected = ids; },
      } as unknown as SelectionScope,
      spatial: { queryViewport: () => ['a', 'hidden', 'b'] } as unknown as SpatialScope,
      hiddenTileIds: () => new Set(['hidden']),
    });
    const el = document.createElement('div');
    el.setPointerCapture = () => {};
    marquee.setContainer(el);
    marquee.handlePointerDown({ shiftKey: true, button: 0, clientX: 0, clientY: 0, pointerId: 1, preventDefault() {}, stopPropagation() {} } as unknown as PointerEvent);
    marquee.handlePointerMove({ clientX: 50, clientY: 50 } as unknown as PointerEvent);
    expect(selected).toEqual(['a', 'b']);
  });
});

describe('a connection is drawn within one board', () => {
  afterEach(() => { connectionsStore.cancelDrawing(); });

  it('a drawing started on another board is not continued here', () => {
    connectionsStore.startDrawing('tile-on-A', 0, 0, 0);
    const boardB = { getTile: (id: string) => (id === 'tile-on-B' ? {} : undefined) };
    expect(connectionsStore.drawingOn(boardB)).toBeNull();
    const boardA = { getTile: (id: string) => (id === 'tile-on-A' ? {} : undefined) };
    expect(connectionsStore.drawingOn(boardA)?.fromTileId).toBe('tile-on-A');
  });
});

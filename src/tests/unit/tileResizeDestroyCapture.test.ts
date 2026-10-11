import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { canvasStore } from '@renderer/stores/canvas.svelte';
import { tileResizeAction } from '@renderer/lib/canvas/tileResize';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TileDefinition } from '@renderer/schema/index';
import { seedBoard } from '../helpers/seedBoard';

/**
 * `tileResizeAction.destroy()` must release the captured pointer.
 *
 * When a tile unmounts mid-resize, the old `destroy()` nulled `activePointerId`
 * WITHOUT calling `releasePointerCapture` — unlike the parallel `tileDrag.ts`,
 * which routes teardown through `cancelDrag()`. The browser self-heals on node
 * disconnect, but in-flight pointer events for that gesture are dropped (stuck-
 * cursor glitch). The fix routes `destroy()` through `cancelResize()`, which
 * restores the start size, releases the capture, and clears the cursor.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapWithTile(): BoardFileData {
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
        t1: { x: 100, y: 100, width: 200, height: 150, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        filePath: 'T.md',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        boardId: 'mm',
        position: { x: 100, y: 100 },
        size: { width: 200, height: 150 },
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  };
}

function activate(): void {
  const fixture = makeMindMapWithTile();
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  const tiles = boardCacheStore.getFullTilesForBoard('mm');
  seedBoard(boardStore, fixture.board, tiles, {}, []);
}

function makePointerEvent(
  type: string,
  init: { clientX: number; clientY: number; button?: number; pointerId?: number },
): PointerEvent {
  const ev = new MouseEvent(type, {
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1, configurable: true });
  return ev as unknown as PointerEvent;
}

/** Replaces the node's capture methods with call-recording stubs. */
function trackPointerCapture(el: HTMLElement): { captured: number[]; released: number[] } {
  const captured: number[] = [];
  const released: number[] = [];
  (el as { setPointerCapture: (id: number) => void }).setPointerCapture = (id) => { captured.push(id); };
  (el as { releasePointerCapture: (id: number) => void }).releasePointerCapture = (id) => { released.push(id); };
  return { captured, released };
}

describe('tileResizeAction.destroy releases pointer capture', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    canvasStore.setTransform({ x: 0, y: 0, scale: 1 });
    document.body.style.cursor = '';
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    document.body.style.cursor = '';
  });

  it('destroy() mid-resize releases the captured pointer and restores the start size', () => {
    activate();
    const node = document.createElement('div');
    document.body.appendChild(node);
    const capture = trackPointerCapture(node);
    const action = tileResizeAction(node, { tileId: 't1', locked: false });

    // Start a resize — the gesture captures the pointer.
    node.dispatchEvent(makePointerEvent('pointerdown', { clientX: 300, clientY: 250, pointerId: 7 }));
    expect(capture.captured).toEqual([7]);
    expect(document.body.style.cursor).toBe('se-resize');

    // Simulate an in-flight resize that grew the tile past its start size.
    boardStore.updateTile('t1', { size: { width: 400, height: 400 } });

    // Tile unmounts mid-resize.
    action.destroy();

    // The captured pointer must be released (the bug: it leaked).
    expect(capture.released).toEqual([7]);
    // Cancel-not-commit: size restored to the pre-resize start.
    expect(boardStore.getTile('t1')?.size).toEqual({ width: 200, height: 150 });
    // Cursor reset.
    expect(document.body.style.cursor).toBe('');

    node.remove();
  });

  it('destroy() with no active resize does not touch pointer capture', () => {
    activate();
    const node = document.createElement('div');
    document.body.appendChild(node);
    const capture = trackPointerCapture(node);
    const action = tileResizeAction(node, { tileId: 't1', locked: false });

    // No pointerdown — teardown must be a clean no-op for the pointer capture.
    action.destroy();
    expect(capture.released).toEqual([]);

    node.remove();
  });
});

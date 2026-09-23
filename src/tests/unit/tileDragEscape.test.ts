import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { selectionStore } from '@renderer/stores/selection.svelte';
import { canvasStore } from '@renderer/stores/canvas.svelte';
import { tileDragAction } from '@renderer/lib/canvas/tileDrag';
// Audit-18 6.1 — the action now requires the pane's BoardScope. The global
// stores these tests assert through resolve to `getActiveScope()`, so passing
// it keeps the action operating on the same active scope.
import { getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile } from '@renderer/schema/index';

/**
 * Phase 27 / A2 — Escape mid-drag cancels the move. Without this fix, a
 * partial drag would commit (committing wherever the cursor was when the
 * key was pressed), be added to history, and the user would have to Ctrl+Z
 * to recover. The new contract: Escape restores the start positions on
 * every dragged tile, suppresses the MoveTilesCommand push, and tears down
 * the drag in the same shape as pointercancel.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapWithTile(): V7BoardFileData {
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
        title: 'T',
        contentId: 'doc_t1',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        boardId: 'mm',
        position: { x: 100, y: 100 },
        size: { width: 200, height: 150 },
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
      } as unknown as Tile,
    },
    connections: {},
    frames: [],
  };
}

function activate(): void {
  const fixture = makeMindMapWithTile();
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  const tiles = boardCacheStore.getFullTilesForBoard('mm');
  boardStore.setBoard(fixture.board, tiles, {}, []);
}

/**
 * Builds a Pointer-like MouseEvent. jsdom 22 ships a working `PointerEvent`
 * constructor for the basic shape; we add `setPointerCapture` /
 * `releasePointerCapture` stubs on the target element because jsdom's
 * Element.prototype is missing them.
 */
function makePointerEvent(type: string, init: { clientX: number; clientY: number; button?: number; pointerId?: number }): PointerEvent {
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

function stubPointerCapture(el: HTMLElement): void {
  if (!(el as { setPointerCapture?: unknown }).setPointerCapture) {
    (el as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
    (el as { releasePointerCapture: (id: number) => void }).releasePointerCapture = () => {};
  }
}

describe('tileDragAction — Escape cancels in-flight drag', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    selectionStore.clear();
    // Reset canvasStore to identity transform so screen-space coords
    // match world-space 1:1 in the assertions.
    canvasStore.setTransform({ x: 0, y: 0, scale: 1 });
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    selectionStore.clear();
  });

  it('restores the dragged tile position and pushes no command', () => {
    activate();
    const startTile = boardStore.getTile('t1');
    expect(startTile?.position).toEqual({ x: 100, y: 100 });

    const node = document.createElement('div');
    document.body.appendChild(node);
    stubPointerCapture(node);
    const action = tileDragAction(node, { tileId: 't1', locked: false, scope: getActiveScope() });

    // Drag start at screen (200, 200)
    node.dispatchEvent(makePointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    // Move by (+50, +30) — must call runMoveBody synchronously through
    // rAF queueing, so we flush rAF below.
    node.dispatchEvent(makePointerEvent('pointermove', { clientX: 250, clientY: 230 }));
    // jsdom doesn't paint, so rAF is queued but not flushed. We don't need
    // the tile to actually move for the test — what matters is that Escape
    // RESTORES startPositions regardless of where the in-flight move left
    // the tile. To prove it does, manually move the tile first.
    boardStore.updateTile('t1', { position: { x: 999, y: 999 } });
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 999, y: 999 });

    // Now fire Escape on window — A2 should restore (100, 100).
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    window.dispatchEvent(esc);

    expect(boardStore.getTile('t1')?.position).toEqual({ x: 100, y: 100 });
    expect(historyStore.canUndo).toBe(false);

    // pointerup after Escape: isDragging is false, must NOT push history.
    node.dispatchEvent(makePointerEvent('pointerup', { clientX: 250, clientY: 230 }));
    expect(historyStore.canUndo).toBe(false);
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 100, y: 100 });

    action.destroy();
    node.remove();
  });

  it('non-Escape keys do NOT cancel the drag', () => {
    activate();
    const node = document.createElement('div');
    document.body.appendChild(node);
    stubPointerCapture(node);
    const action = tileDragAction(node, { tileId: 't1', locked: false, scope: getActiveScope() });

    node.dispatchEvent(makePointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    // Simulate an in-flight move
    boardStore.updateTile('t1', { position: { x: 250, y: 220 } });

    // Press a non-Escape key — drag must NOT cancel, position must NOT
    // restore. After this, Escape must STILL restore (proves the listener
    // is still attached and only Escape triggers cancellation).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 250, y: 220 });

    // Escape after the ignored 'a' still cancels — proves the listener
    // wasn't removed.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 100, y: 100 });

    action.destroy();
    node.remove();
  });

  it('Escape outside a drag is a no-op (no listener leak)', () => {
    activate();
    const node = document.createElement('div');
    document.body.appendChild(node);
    stubPointerCapture(node);
    const action = tileDragAction(node, { tileId: 't1', locked: false, scope: getActiveScope() });

    // No pointerdown yet — Escape should not touch the tile.
    boardStore.updateTile('t1', { position: { x: 500, y: 500 } });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 500, y: 500 });

    action.destroy();
    node.remove();
  });

  it('pointercancel mid-drag restores the start position (D.4)', () => {
    activate();
    const node = document.createElement('div');
    document.body.appendChild(node);
    stubPointerCapture(node);
    const action = tileDragAction(node, { tileId: 't1', locked: false, scope: getActiveScope() });

    node.dispatchEvent(makePointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    // Simulate an in-flight move that left the tile away from its start.
    boardStore.updateTile('t1', { position: { x: 250, y: 250 } });

    // Native pointercancel (OS gesture interrupted the drag) — must snap
    // back to the start position and push no command.
    node.dispatchEvent(makePointerEvent('pointercancel', { clientX: 250, clientY: 250 }));

    expect(boardStore.getTile('t1')?.position).toEqual({ x: 100, y: 100 });
    expect(historyStore.canUndo).toBe(false);

    action.destroy();
    node.remove();
  });

  it('Escape during multi-tile drag restores every captured tile', () => {
    activate();
    // Add a second tile and select both.
    boardStore.addTile({
      id: 't2',
      type: 'text',
      title: 'T2',
      contentId: 'doc_t2',
      style: { headerColor: '', bodyColor: '', borderColor: '' },
      boardId: 'mm',
      position: { x: 300, y: 300 },
      size: { width: 100, height: 100 },
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      locked: false,
      faded: false,
    } as unknown as Tile);
    selectionStore.select('t1');
    selectionStore.toggle('t2'); // additive

    const node = document.createElement('div');
    document.body.appendChild(node);
    stubPointerCapture(node);
    const action = tileDragAction(node, { tileId: 't1', locked: false, scope: getActiveScope() });

    node.dispatchEvent(makePointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    // Simulate move applied to both selected tiles
    boardStore.updateTile('t1', { position: { x: 150, y: 150 } });
    boardStore.updateTile('t2', { position: { x: 350, y: 350 } });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(boardStore.getTile('t1')?.position).toEqual({ x: 100, y: 100 });
    expect(boardStore.getTile('t2')?.position).toEqual({ x: 300, y: 300 });
    expect(historyStore.canUndo).toBe(false);

    action.destroy();
    node.remove();
  });
});

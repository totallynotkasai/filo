import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the tile factory so the test exercises ONLY dragDrop's pane routing,
// not createTile's global-store dependencies (getNextTileName / font defaults).
// The mock passes position + boardId straight through so we can assert which
// pane's board + viewport the drop used.
vi.mock('@renderer/stores/tiles.svelte', () => ({
  createTile: (
    type: string,
    position: { x: number; y: number },
    boardId: string,
    overrides?: Record<string, unknown>,
  ) => ({ id: 'tile-1', type, position, boardId, size: { width: 10, height: 10 }, ...overrides }),
  getTileTypeFromExtension: (ext: string) =>
    ext === '.md' || ext === '.markdown' ? 'text' : 'image',
  getTileTypeFromMime: () => 'image',
}));

import { dragDropAction } from '@renderer/lib/canvas/dragDrop';
import { screenToCanvas } from '@renderer/lib/canvas/coordinates';
import { setActiveScope, resetActiveScope, type BoardScope } from '@renderer/lib/boards/boardScope.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-12 M5 — an OS file-drop must create the tile on the pane it was dropped
 * on, not the globally-active pane.
 *
 * A `drop` carries no preceding pointerdown to activate the target pane (unlike
 * tile-drag, which uses pointer capture), so reading the global
 * `boardStore`/`canvasStore` created the tile on the ACTIVE pane's board with
 * its viewport transform. `dragDropAction` now takes the pane's BoardScope and
 * creates against `scope.board`/`scope.canvas`; the gate
 * `ci:document-editor-pane-scoped` forbids the global facade reads.
 */
function makeVaultFileDrop(
  payload: { path: string; name: string; extension: string },
  clientX: number,
  clientY: number,
): Event {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types: ['application/x-vault-file'],
      getData: (t: string) => (t === 'application/x-vault-file' ? JSON.stringify(payload) : ''),
    },
  });
  Object.defineProperty(e, 'clientX', { value: clientX });
  Object.defineProperty(e, 'clientY', { value: clientY });
  return e;
}

function makeFakeScope(boardId: string, transform: { x: number; y: number; scale: number }) {
  const addTile = vi.fn();
  const scope = {
    board: {
      current: { id: boardId },
      addTile,
      getTile: () => undefined,
      markDirty: vi.fn(),
    },
    canvas: { transform },
  } as unknown as BoardScope;
  return { scope, addTile };
}

describe('Audit-12 M5 — file-drop lands on the dropped-on pane', () => {
  beforeEach(() => {
    installFiloMock(() => ({ ok: true, success: true }));
    historyStore.clear();
  });
  afterEach(() => {
    resetActiveScope();
    historyStore.clear();
    restoreFiloDefault();
    vi.clearAllMocks();
  });

  it('creates the tile on the THREADED pane scope, with that pane viewport', () => {
    // Pane A is the globally-active scope; the drop targets pane B's node.
    const paneA = makeFakeScope('pane-A-board', { x: 0, y: 0, scale: 1 });
    const paneB = makeFakeScope('pane-B-board', { x: 500, y: 300, scale: 2 });
    setActiveScope(paneA.scope);

    const node = document.createElement('div');
    const action = dragDropAction(node, paneB.scope);

    node.dispatchEvent(
      makeVaultFileDrop({ path: 'images/pic.png', name: 'pic.png', extension: '.png' }, 120, 80),
    );

    // Added to pane B's board, NOT pane A's.
    expect(paneB.addTile).toHaveBeenCalledTimes(1);
    expect(paneA.addTile).not.toHaveBeenCalled();

    const tile = paneB.addTile.mock.calls[0][0] as { boardId: string; position: { x: number; y: number } };
    expect(tile.boardId).toBe('pane-B-board');
    // Position derived from pane B's transform (jsdom getBoundingClientRect is 0).
    const expected = screenToCanvas(120, 80, { x: 500, y: 300, scale: 2 });
    expect(tile.position.x).toBeCloseTo(expected.x);
    expect(tile.position.y).toBeCloseTo(expected.y);

    (action as { destroy?: () => void }).destroy?.();
  });
});

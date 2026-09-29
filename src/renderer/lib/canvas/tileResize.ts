import { canvasStore } from '../../stores/canvas.svelte';
import { boardStore } from '../../stores/board.svelte';
import { historyStore } from '../../stores/history.svelte';
import { ResizeTileCommand } from '../../commands/index';
import { TILE_DEFAULTS } from '../../constants/defaults';

/**
 * Tile resize action — applied to the resize handle element (bottom-right corner).
 * Tracks pointer movement and updates tile size in the board store.
 * Enforces minimum tile dimensions.
 * Creates a single ResizeTileCommand on resize end for undo/redo.
 *
 * Usage: <div use:tileResizeAction={{ tileId, locked }}>...</div>
 */

export interface TileResizeOptions {
  tileId: string;
  locked: boolean;
}

export function tileResizeAction(node: HTMLElement, options: TileResizeOptions) {
  let currentOptions = options;
  let isResizing = false;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let activePointerId: number | null = null;

  function onPointerDown(e: PointerEvent) {
    if (currentOptions.locked) return;
    if (e.button !== 0) return;

    e.stopPropagation();
    e.preventDefault();
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;

    const tile = boardStore.getTile(currentOptions.tileId);
    if (tile) {
      startWidth = tile.size.width;
      startHeight = tile.size.height;
    }

    node.setPointerCapture(e.pointerId);
    activePointerId = e.pointerId;
    document.body.style.cursor = 'se-resize';
    window.addEventListener('keydown', onWindowKeyDown, true);
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (!isResizing || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelResize();
  }

  function cancelResize() {
    if (!isResizing) return;
    isResizing = false;
    if (boardStore.getTile(currentOptions.tileId)) {
      boardStore.updateTile(currentOptions.tileId, {
        size: { width: startWidth, height: startHeight },
      });
    }
    if (activePointerId !== null) {
      try { node.releasePointerCapture(activePointerId); } catch { /* already released */ }
      activePointerId = null;
    }
    document.body.style.cursor = '';
    window.removeEventListener('keydown', onWindowKeyDown, true);
  }

  function onPointerMove(e: PointerEvent) {
    if (!isResizing) return;

    const scale = canvasStore.scale;
    const dx = (e.clientX - startX) / scale;
    const dy = (e.clientY - startY) / scale;

    const newWidth = Math.max(TILE_DEFAULTS.minWidth, startWidth + dx);
    const newHeight = Math.max(TILE_DEFAULTS.minHeight, startHeight + dy);

    boardStore.updateTile(currentOptions.tileId, {
      size: { width: Math.round(newWidth), height: Math.round(newHeight) },
    });
  }

  function onPointerUp(e: PointerEvent) {
    if (!isResizing) return;
    isResizing = false;

    // Create a ResizeTileCommand for undo/redo if size actually changed
    const tile = boardStore.getTile(currentOptions.tileId);
    if (tile) {
      const afterWidth = tile.size.width;
      const afterHeight = tile.size.height;
      if (afterWidth !== startWidth || afterHeight !== startHeight) {
        const cmd = new ResizeTileCommand(
          currentOptions.tileId,
          { width: startWidth, height: startHeight },
          { width: afterWidth, height: afterHeight },
        );
        // Push without re-executing (tile is already at final size)
        historyStore.pushWithoutExecute(cmd);
      }
    }

    node.releasePointerCapture(e.pointerId);
    activePointerId = null;
    document.body.style.cursor = '';
    window.removeEventListener('keydown', onWindowKeyDown, true);
  }

  function onPointerCancel(_e: PointerEvent) {
    if (!isResizing) return;
    // A native pointercancel routes through the same snap-back path as
    // Escape so an interrupted resize doesn't strand the tile at a half-way
    // size that the user can't undo (no command would have been pushed).
    cancelResize();
  }

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerCancel);

  return {
    update(newOptions: TileResizeOptions) {
      currentOptions = newOptions;
    },
    destroy() {
      // Route teardown through cancelResize() (mirrors tileDrag's cancelDrag()).
      // If the tile unmounts mid-resize it restores the captured start size
      // (cancel-not-commit — never pushes a ResizeTileCommand), RELEASES the
      // pointer capture (else it leaks and drops in-flight pointer events), and
      // clears the cursor + keydown listener. cancelResize() no-ops when not resizing.
      cancelResize();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerCancel);
    },
  };
}

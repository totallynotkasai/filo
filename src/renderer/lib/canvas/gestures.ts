import type { CanvasScope } from '../../stores/canvas.svelte';

/**
 * Viewport action — attaches pan and zoom handlers to the canvas container.
 * Uses native pointer events for reliable Electron compatibility.
 *
 * Takes the pane's `CanvasScope` so wheel-zoom / drag-pan mutate THIS pane's
 * canvas, not whichever pane the global `canvasStore` facade delegates to. A
 * mouse wheel produces no pointerdown to activate the pane under the cursor, so
 * the facade would zoom the active pane (and persist the wrong board's
 * viewport). Mirrors `startEdgePan(scope)`.
 *
 * Usage: <div use:viewportAction={paneCanvasScope}>...</div>
 */

interface ViewportState {
  isPanning: boolean;
  startX: number;
  startY: number;
}

export function viewportAction(node: HTMLElement, scope: CanvasScope) {
  const state: ViewportState = {
    isPanning: false,
    startX: 0,
    startY: 0,
  };

  function onPointerDown(e: PointerEvent) {
    // Only pan on middle-click, or left-click on the canvas background
    const isMiddle = e.button === 1;
    const target = e.target as HTMLElement;
    const isLeftOnBackground = e.button === 0 && !e.shiftKey && (
      target === node ||
      target.classList?.contains('canvas-transform') ||
      target.classList?.contains('board-background') ||
      target.closest?.('.board-background') !== null
    );

    if (!isMiddle && !isLeftOnBackground) return;

    e.preventDefault();
    state.isPanning = true;
    state.startX = e.clientX;
    state.startY = e.clientY;
    node.setPointerCapture(e.pointerId);
    node.style.cursor = 'grabbing';
  }

  function onPointerMove(e: PointerEvent) {
    if (!state.isPanning) return;

    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    state.startX = e.clientX;
    state.startY = e.clientY;

    scope.panBy(dx, dy);
  }

  function onPointerUp(e: PointerEvent) {
    if (!state.isPanning) return;

    state.isPanning = false;
    node.releasePointerCapture(e.pointerId);
    node.style.cursor = 'grab';
  }

  function onWheel(e: WheelEvent) {
    // Let scrollable tile content (e.g. text editors) handle its own scrolling
    const target = e.target as HTMLElement;
    const scrollable = target.closest('.editor-container');
    if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) {
      return;
    }

    e.preventDefault();

    const rect = node.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Check for trackpad pinch (ctrlKey is set for pinch gestures)
    if (e.ctrlKey) {
      // Pinch zoom — 5% intervals
      const zoomFactor = e.deltaY > 0 ? 1 / 1.05 : 1.05;
      scope.zoomBy(zoomFactor, mouseX, mouseY);
    } else if (e.shiftKey) {
      // Horizontal pan with shift+scroll
      scope.panBy(-e.deltaY, 0);
    } else if (Math.abs(e.deltaX) > 0) {
      // Trackpad two-finger horizontal scroll.
      // Suppress Y when horizontal dominates to prevent diagonal drift.
      const panY = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 ? 0 : -e.deltaY;
      scope.panBy(-e.deltaX, panY);
    } else {
      // Standard scroll zoom — 5% intervals (scroll down = zoom out, scroll up = zoom in)
      const zoomFactor = e.deltaY > 0 ? 1 / 1.05 : 1.05;
      scope.zoomBy(zoomFactor, mouseX, mouseY);
    }
  }

  // Set initial cursor
  node.style.cursor = 'grab';

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerUp);
  node.addEventListener('wheel', onWheel, { passive: false });

  return {
    destroy() {
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerUp);
      node.removeEventListener('wheel', onWheel);
    },
  };
}

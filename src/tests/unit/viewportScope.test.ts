/**
 * Wheel-zoom / drag-pan route to the pane scope passed to
 * `viewportAction`, not the global `canvasStore` facade.
 *
 * `viewportAction` is attached per-pane but used to mutate through the global
 * facade, which delegates to whichever pane is ACTIVE. A mouse wheel produces
 * no pointerdown to activate the pane under the cursor, so scrolling over an
 * inactive pane zoomed the active pane — and persisted the wrong board's
 * viewport. The sibling `edgePan` was already fixed to take a `CanvasScope`;
 * this asserts `viewportAction` does the same.
 *
 * Mirrors edgePanScope.test.ts: pass a mock scope, dispatch the gesture, and
 * assert the delta lands on that scope and never on any other pane's scope.
 */
import { describe, it, expect, vi } from 'vitest';
import { viewportAction } from '@renderer/lib/canvas/gestures';
import type { CanvasScope } from '@renderer/stores/canvas.svelte';

function mkScope(): CanvasScope {
  return { panBy: vi.fn(), zoomBy: vi.fn() } as unknown as CanvasScope;
}

describe('viewportAction routes to the scope it was given', () => {
  it('wheel-zooms the passed pane scope and leaves other panes untouched', () => {
    const node = document.createElement('div');
    const paneA = mkScope();
    const paneB = mkScope();

    const handle = viewportAction(node, paneA);

    // Plain scroll-down over this pane → zoom out (factor 1/1.05) on paneA.
    node.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, clientX: 50, clientY: 60, cancelable: true, bubbles: true }),
    );

    expect(paneA.zoomBy).toHaveBeenCalledTimes(1);
    const call = (paneA.zoomBy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBeCloseTo(1 / 1.05);
    expect(call[1]).toBe(50);
    expect(call[2]).toBe(60);

    // The other pane's canvas is never touched.
    expect(paneB.zoomBy).not.toHaveBeenCalled();
    expect(paneB.panBy).not.toHaveBeenCalled();

    handle?.destroy?.();
  });

  it('shift+wheel pans the passed pane scope horizontally, not the global facade', () => {
    const node = document.createElement('div');
    const paneA = mkScope();
    const paneB = mkScope();

    const handle = viewportAction(node, paneA);

    node.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, shiftKey: true, cancelable: true, bubbles: true }),
    );

    expect(paneA.panBy).toHaveBeenCalledTimes(1);
    expect((paneA.panBy as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([-120, 0]);
    expect(paneB.panBy).not.toHaveBeenCalled();

    handle?.destroy?.();
  });
});

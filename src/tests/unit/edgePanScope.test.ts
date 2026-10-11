/**
 * Edge-pan pans the captured pane scope, not the global facade.
 *
 * `edgePan` is a module singleton. It used to call the global `canvasStore`
 * facade, which routes to whichever pane is active AT TICK TIME. Connection
 * drawing has no pointer capture, so activating another pane mid-draw made
 * edge-pan scroll the wrong pane's canvas (and persist its viewport). The fix
 * captures the originating pane's `CanvasScope` at `startEdgePan(scope)` time.
 *
 * This test stubs `requestAnimationFrame` so a single tick runs synchronously
 * and asserts the delta lands on the scope that was passed in — never on any
 * other scope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startEdgePan, stopEdgePan, updateEdgePanMouse } from '@renderer/lib/canvas/edgePan';
import type { CanvasScope } from '@renderer/stores/canvas.svelte';

function mkScope(): CanvasScope {
  return { panBy: vi.fn() } as unknown as CanvasScope;
}

describe('edge-pan routes to the scope passed to startEdgePan', () => {
  let raf: FrameRequestCallback | null = null;

  beforeEach(() => {
    raf = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      raf = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    stopEdgePan();
    vi.unstubAllGlobals();
  });

  it('pans the captured pane scope and leaves other panes untouched', () => {
    const paneA = mkScope();
    const paneB = mkScope();

    // Mouse hard against the left edge so tick produces a positive dx.
    updateEdgePanMouse(0, 400);
    startEdgePan(paneA);

    // startEdgePan scheduled the first tick through our RAF stub.
    expect(raf).toBeTypeOf('function');
    raf?.(0); // run exactly one tick

    expect(paneA.panBy).toHaveBeenCalledTimes(1);
    const call = (paneA.panBy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBeGreaterThan(0); // dx pans right (toward the left edge)
    expect(call[1]).toBe(0); // dy unchanged (mouse is vertically centred)

    // The other pane's canvas is never touched.
    expect(paneB.panBy).not.toHaveBeenCalled();
  });
});

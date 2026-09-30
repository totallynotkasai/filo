/**
 * A box-select the system cancels (pointercancel) ends the box: it isn't left
 * drawn, and the next pointer move doesn't grow it.
 */
import { describe, it, expect } from 'vitest';
import { MarqueeSelectionController } from '@renderer/lib/mindmap/marqueeSelectionController.svelte';
import type { CanvasScope } from '@renderer/stores/canvas.svelte';
import type { SelectionScope } from '@renderer/stores/selection.svelte';
import type { SpatialScope } from '@renderer/stores/spatial.svelte';

function setup(): { ctl: MarqueeSelectionController; calls: string[]; container: HTMLElement } {
  const calls: string[] = [];
  const selection = {
    startBox: () => calls.push('start'),
    updateBox: () => calls.push('update'),
    endBox: () => calls.push('end'),
    boxRect: null,
    selectMultiple: () => calls.push('select'),
  } as unknown as SelectionScope;
  const canvas = { transform: { x: 0, y: 0, zoom: 1 } } as unknown as CanvasScope;
  const spatial = { queryViewport: () => [] } as unknown as SpatialScope;
  const ctl = new MarqueeSelectionController({ canvas, selection, spatial });
  const container = document.createElement('div');
  container.setPointerCapture = () => {};
  container.releasePointerCapture = () => {};
  ctl.setContainer(container);
  return { ctl, calls, container };
}

describe('marquee selection: pointercancel', () => {
  it('ends the box, and a later move or pointerup does nothing', () => {
    const { ctl, calls } = setup();
    ctl.handlePointerDown(new PointerEvent('pointerdown', { shiftKey: true, button: 0, pointerId: 1 }));
    expect(ctl.isSelecting).toBe(true);
    ctl.handlePointerCancel();
    expect(ctl.isSelecting).toBe(false);
    expect(calls).toEqual(['start', 'end']);
    ctl.handlePointerMove(new PointerEvent('pointermove', { pointerId: 1 }));
    ctl.handlePointerUp(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(calls).toEqual(['start', 'end']);
  });

  it('with no box open, does nothing', () => {
    const { ctl, calls } = setup();
    ctl.handlePointerCancel();
    expect(calls).toEqual([]);
  });
});

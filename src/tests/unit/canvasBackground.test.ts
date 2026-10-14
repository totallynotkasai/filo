/**
 * A press in a Mind Map frame's empty body is a press on the canvas: it pans
 * the board, as a press outside the frame does. The frame's header, a tile
 * and anything else drawn on the canvas keep the press for themselves.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { isCanvasBackground } from '@renderer/lib/canvas/canvasBackground';
import { viewportAction } from '@renderer/lib/canvas/gestures';
import type { CanvasScope } from '@renderer/stores/canvas.svelte';

/** The Mind Map's shape: board > background + transform > frame (header, body) + tile. */
function board(): Record<'board' | 'background' | 'transform' | 'frame' | 'header' | 'title' | 'body' | 'tile', HTMLElement> {
  const el = (cls: string, parent?: HTMLElement): HTMLElement => {
    const e = document.createElement('div');
    e.className = cls;
    parent?.appendChild(e);
    return e;
  };
  const b = el('mindmap-board');
  const background = el('board-background', b);
  const transform = el('canvas-transform', b);
  const frame = el('frame-container', transform);
  const header = el('frame-header', frame);
  const title = el('frame-title', header);
  const body = el('frame-body', frame);
  const tile = el('tile-container', transform);
  document.body.appendChild(b);
  return { board: b, background, transform, frame, header, title, body, tile };
}

function pointer(el: Element, type: string, x: number, y: number): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  el.dispatchEvent(e);
}

beforeAll(() => {
  if (typeof Element.prototype.setPointerCapture !== 'function') Element.prototype.setPointerCapture = () => {};
  if (typeof Element.prototype.releasePointerCapture !== 'function') Element.prototype.releasePointerCapture = () => {};
});

describe('isCanvasBackground', () => {
  it('is the board, its transform layer, its background and a frame body', () => {
    const b = board();
    expect(isCanvasBackground(b.board, b.board)).toBe(true);
    expect(isCanvasBackground(b.transform, b.board)).toBe(true);
    expect(isCanvasBackground(b.background, b.board)).toBe(true);
    // `.frame-body` takes no pointer events, so a press in it lands on the container.
    expect(isCanvasBackground(b.frame, b.board)).toBe(true);
  });

  it('is not a frame header, its title, or a tile', () => {
    const b = board();
    expect(isCanvasBackground(b.header, b.board)).toBe(false);
    expect(isCanvasBackground(b.title, b.board)).toBe(false);
    expect(isCanvasBackground(b.tile, b.board)).toBe(false);
    expect(isCanvasBackground(null, b.board)).toBe(false);
    expect(isCanvasBackground(window, b.board)).toBe(false);
  });
});

describe('panning from inside a frame', () => {
  function attach(): { b: ReturnType<typeof board>; scope: CanvasScope; destroy: () => void } {
    const b = board();
    const scope = { panBy: vi.fn(), zoomBy: vi.fn() } as unknown as CanvasScope;
    const handle = viewportAction(b.board, scope);
    return { b, scope, destroy: () => handle.destroy() };
  }

  it('a press in a frame body pans the board', () => {
    const { b, scope, destroy } = attach();
    pointer(b.frame, 'pointerdown', 100, 100);
    pointer(b.board, 'pointermove', 140, 130);
    pointer(b.board, 'pointerup', 140, 130);
    expect(scope.panBy).toHaveBeenCalledWith(40, 30);
    destroy();
  });

  it('a press on the frame header or a tile does not pan', () => {
    const { b, scope, destroy } = attach();
    for (const el of [b.header, b.title, b.tile]) {
      pointer(el, 'pointerdown', 100, 100);
      pointer(b.board, 'pointermove', 140, 130);
      pointer(b.board, 'pointerup', 140, 130);
    }
    expect(scope.panBy).not.toHaveBeenCalled();
    destroy();
  });
});

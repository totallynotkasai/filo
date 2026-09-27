/**
 * The shared drag for the floating board toolbars: a background press drags,
 * a press on a button or while pinned doesn't, a cancel puts the toolbar back,
 * and a drop is kept inside the window.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFloatingToolbarDrag,
  clampToolbarPosition,
  floatingToolbarStyle,
  TOOLBAR_KEEP_VISIBLE_PX,
  type ToolbarPosition,
} from '@renderer/lib/canvas/floatingToolbarDrag';

interface Rig {
  bar: HTMLElement;
  button: HTMLButtonElement;
  events: string[];
  ended: Array<ToolbarPosition | null>;
  moves: ToolbarPosition[];
  setPinned(value: boolean): void;
}

function rig(): Rig {
  const bar = document.createElement('div');
  const button = document.createElement('button');
  button.className = 'side-btn';
  bar.appendChild(button);
  document.body.appendChild(bar);
  let pinned = false;
  const events: string[] = [];
  const ended: Array<ToolbarPosition | null> = [];
  const moves: ToolbarPosition[] = [];
  const handlers = createFloatingToolbarDrag({
    ignoreSelector: '.side-btn',
    isPinned: () => pinned,
    onStart: () => events.push('start'),
    onMove: (p) => moves.push(p),
    onEnd: (p) => { events.push('end'); ended.push(p); },
  });
  bar.addEventListener('pointerdown', handlers.onpointerdown);
  bar.addEventListener('pointermove', handlers.onpointermove);
  bar.addEventListener('pointerup', handlers.onpointerup);
  bar.addEventListener('pointercancel', handlers.onpointercancel);
  return { bar, button, events, ended, moves, setPinned: (v) => { pinned = v; } };
}

function pointer(el: Element, type: string, x: number, y: number, button = 0): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button, clientX: x, clientY: y, pointerId: 7 }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.innerWidth = 1000;
  window.innerHeight = 800;
});

describe('createFloatingToolbarDrag', () => {
  it('drags by the background and ends at the drop position', () => {
    const r = rig();
    pointer(r.bar, 'pointerdown', 0, 0);
    pointer(r.bar, 'pointermove', 120, 80);
    pointer(r.bar, 'pointerup', 120, 80);
    expect(r.events).toEqual(['start', 'end']);
    expect(r.moves).toEqual([{ x: 120, y: 80 }]);
    expect(r.ended).toEqual([{ x: 120, y: 80 }]);
  });

  it('a press that never moves ends with no position', () => {
    const r = rig();
    pointer(r.bar, 'pointerdown', 0, 0);
    pointer(r.bar, 'pointerup', 0, 0);
    expect(r.ended).toEqual([null]);
  });

  it('never starts on a button, a right press, or while pinned', () => {
    const r = rig();
    pointer(r.button, 'pointerdown', 0, 0);
    pointer(r.bar, 'pointerdown', 0, 0, 2);
    r.setPinned(true);
    pointer(r.bar, 'pointerdown', 0, 0);
    pointer(r.bar, 'pointermove', 50, 50);
    pointer(r.bar, 'pointerup', 50, 50);
    expect(r.events).toEqual([]);
    expect(r.moves).toEqual([]);
  });

  it('a cancelled drag ends with no position, so the toolbar goes back', () => {
    const r = rig();
    pointer(r.bar, 'pointerdown', 0, 0);
    pointer(r.bar, 'pointermove', 300, 300);
    pointer(r.bar, 'pointercancel', 300, 300);
    expect(r.ended).toEqual([null]);
    // Nothing after the cancel belongs to a drag.
    pointer(r.bar, 'pointermove', 10, 10);
    pointer(r.bar, 'pointerup', 10, 10);
    expect(r.ended).toEqual([null]);
    expect(r.moves).toHaveLength(1);
  });

  it('keeps a drop inside the window', () => {
    const r = rig();
    pointer(r.bar, 'pointerdown', 0, 0);
    pointer(r.bar, 'pointermove', 5000, -200);
    pointer(r.bar, 'pointerup', 5000, -200);
    expect(r.ended).toEqual([{ x: 1000 - TOOLBAR_KEEP_VISIBLE_PX, y: 0 }]);
  });
});

describe('clampToolbarPosition / floatingToolbarStyle', () => {
  it('clamps to the window, keeping a strip of the toolbar in view', () => {
    expect(clampToolbarPosition({ x: -5, y: 900 }, 1000, 800)).toEqual({ x: 0, y: 800 - TOOLBAR_KEEP_VISIBLE_PX });
  });

  it('is empty while docked, and clamps a position saved in a bigger window', () => {
    expect(floatingToolbarStyle(null)).toBe('');
    const style = floatingToolbarStyle({ x: 1900, y: 40 });
    expect(style).toContain('position: fixed');
    expect(style).toContain(`left: ${1000 - TOOLBAR_KEEP_VISIBLE_PX}px`);
    expect(style).toContain('top: 40px');
  });
});

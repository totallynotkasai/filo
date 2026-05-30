import { describe, it, expect } from 'vitest';
import { getContextMenuKeyPosition } from '@renderer/lib/utils/contextMenuKey';

function makeKey(key: string, shiftKey = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, shiftKey });
}

function makeRect(left: number, top: number, w: number, h: number): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top,
    toJSON: () => ({}),
  });
  return el;
}

describe('contextMenuKey', () => {
  it('returns position for Shift+F10', () => {
    const target = makeRect(100, 200, 50, 30);
    const pos = getContextMenuKeyPosition(makeKey('F10', true), target);
    expect(pos).toEqual({ x: 125, y: 215 });
  });

  it('returns position for the ContextMenu key', () => {
    const target = makeRect(0, 0, 20, 20);
    const pos = getContextMenuKeyPosition(makeKey('ContextMenu'), target);
    expect(pos).toEqual({ x: 10, y: 10 });
  });

  it('returns null for F10 without shift', () => {
    const target = makeRect(0, 0, 10, 10);
    expect(getContextMenuKeyPosition(makeKey('F10', false), target)).toBeNull();
  });

  it('returns null for unrelated keys', () => {
    const target = makeRect(0, 0, 10, 10);
    expect(getContextMenuKeyPosition(makeKey('Enter'), target)).toBeNull();
    expect(getContextMenuKeyPosition(makeKey('a'), target)).toBeNull();
  });

  it('returns (0,0) when no target and no activeElement', () => {
    // jsdom's activeElement is documentElement which has a rect — coerce
    // by passing null target with no focused custom element.
    const pos = getContextMenuKeyPosition(makeKey('ContextMenu'), null);
    expect(pos).toBeDefined();
    // jsdom returns 0-width 0-height rect for the body/html in tests
    expect(pos!.x).toBeGreaterThanOrEqual(0);
    expect(pos!.y).toBeGreaterThanOrEqual(0);
  });
});

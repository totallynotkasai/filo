/**
 * The Mind Map's single keys (N, C, Enter, Backspace) are registered
 * commands: listed with the other shortcuts, rebindable, and acting only for
 * the active pane while focus is in its canvas, with something to act on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerMindMapShortcuts, type MindMapShortcutDeps } from '@renderer/lib/mindmap/mindMapShortcuts';
import { _resetForTests, getAllShortcuts, initKeyboardShortcuts, setHotkeyOverride } from '@renderer/core/hotkeys';

let canvas: HTMLElement;
let outside: HTMLElement;
let unregister: () => void;
let acted: string[];
let selected = 0;
let activePane = true;

function deps(): MindMapShortcutDeps {
  return {
    isActivePane: () => activePane,
    canvas: () => canvas,
    selectedCount: () => selected,
    newTile: () => acted.push('new'),
    renameSelected: () => acted.push('rename'),
    removeSelected: () => acted.push('remove'),
    connectSelected: () => acted.push('connect'),
  };
}

function press(target: HTMLElement, key: string): boolean {
  target.focus();
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

beforeEach(() => {
  _resetForTests();
  initKeyboardShortcuts();
  document.body.innerHTML = `
    <div class="mindmap-board" tabindex="0"><div class="tile-container" tabindex="0"></div></div>
    <aside class="vault-sidebar"><div role="treeitem" tabindex="0">Chapter 1.md</div></aside>`;
  canvas = document.querySelector('.mindmap-board')!;
  outside = document.querySelector('[role="treeitem"]')!;
  acted = [];
  selected = 0;
  activePane = true;
  unregister = registerMindMapShortcuts(deps());
});

afterEach(() => {
  unregister();
  _resetForTests();
  document.body.innerHTML = '';
});

describe('Mind Map shortcuts', () => {
  it('are listed with a command id each, so Help shows them and they can be rebound', () => {
    const listed = getAllShortcuts().filter((s) => s.commandId?.startsWith('mindmap:'));
    expect(listed.map((s) => [s.commandId, s.key])).toEqual([
      ['mindmap:new-tile', 'n'],
      ['mindmap:connect', 'c'],
      ['mindmap:rename-tile', 'Enter'],
      ['mindmap:remove-tiles', 'Backspace'],
    ]);
    expect(listed.every((s) => s.description.startsWith('Mind Map: '))).toBe(true);
  });

  it('act from the canvas or a tile on it, with something to act on', () => {
    expect(press(canvas, 'n')).toBe(true);
    // Nothing selected: Enter, C and Backspace are left alone.
    expect(press(canvas, 'Enter')).toBe(false);
    expect(press(canvas, 'c')).toBe(false);
    expect(press(canvas, 'Backspace')).toBe(false);
    selected = 1;
    const tile = canvas.querySelector<HTMLElement>('.tile-container')!;
    for (const key of ['Enter', 'c', 'Backspace']) expect(press(tile, key), key).toBe(true);
    selected = 2;
    expect(press(tile, 'Enter')).toBe(false);
    expect(press(tile, 'Backspace')).toBe(true);
    expect(acted).toEqual(['new', 'rename', 'connect', 'remove', 'remove']);
  });

  it('do nothing from the sidebar, the page, or an inactive pane', () => {
    selected = 1;
    for (const key of ['n', 'Enter', 'c', 'Backspace']) expect(press(outside, key), key).toBe(false);
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }));
    activePane = false;
    expect(press(canvas, 'n')).toBe(false);
    expect(acted).toEqual([]);
  });

  it('follow a rebinding', () => {
    setHotkeyOverride('mindmap:new-tile', { key: 'm' });
    expect(press(canvas, 'n')).toBe(false);
    expect(press(canvas, 'm')).toBe(true);
    expect(acted).toEqual(['new']);
  });
});

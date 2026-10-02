/**
 * The Search panel's close button sits in the header the panel is dragged by.
 * A press on it must not start a drag: the drag captures the pointer on the
 * header, and the browser then sends the click to the header, so the button
 * never closes the panel. jsdom doesn't retarget the click, so the tests check
 * the capture itself; `searchPanel.e2e.ts` clicks it in the real window.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SearchPanel from '@renderer/components/search/SearchPanel.svelte';
import { searchStore } from '@renderer/stores/search.svelte';

let instance: ReturnType<typeof mount> | null = null;
let captured: Element[] = [];

function press(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 40, clientY: 90 }));
  flushSync();
}

describe('Search panel: the close button', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).filo = { invoke: async () => null, on: () => () => {}, send: () => {} };
    captured = [];
    Element.prototype.setPointerCapture ??= function () {};
    Element.prototype.releasePointerCapture ??= function () {};
    vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(function (this: Element) {
      captured.push(this);
    });
    searchStore.reset();
    searchStore.openPanel('find');
    const target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(SearchPanel, { target });
    flushSync();
  });

  afterEach(() => {
    if (instance) unmount(instance);
    instance = null;
    vi.restoreAllMocks();
    searchStore.reset();
    document.body.innerHTML = '';
  });

  it('a press on it captures nothing, and its click closes the panel', () => {
    const close = document.querySelector<HTMLButtonElement>('.search-panel button[aria-label="Close search"]')!;
    press(close.querySelector('line') ?? close);
    expect(captured).toEqual([]);
    close.click();
    flushSync();
    expect(searchStore.open).toBe(false);
    expect(document.querySelector('.search-panel')).toBeNull();
  });

  it('a press on the header around it still starts a drag', () => {
    const header = document.querySelector('.search-panel .drag-handle')!;
    press(header.querySelector('.title')!);
    expect(captured).toEqual([header]);
    header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
    expect(searchStore.open).toBe(true);
  });
});

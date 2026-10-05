/**
 * Keys typed in a tab's rename box are the box's. The tab itself takes Space
 * and Enter (to show it), and the box's keys bubbled up to it, so a space
 * never reached the name: "Chapter 4" became "Chapter4". Mounts the real tab.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import Tab from '@renderer/components/layout/Tab.svelte';

let instance: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  document.body.innerHTML = '';
});

function press(el: Element, key: string): boolean {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('a tab being renamed', () => {
  it('lets a space through to its rename box, while Space on the tab itself still shows the tab', () => {
    const tab = { id: 't1', boardId: 'b1', name: 'Plot', boardType: 'mindmap' as const, emoji: '' };
    const target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(Tab, { target, props: { tab } });
    flushSync();

    const tabEl = target.querySelector<HTMLElement>('.tab')!;
    expect(press(tabEl, ' ')).toBe(true);

    tabEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    flushSync();
    const input = target.querySelector<HTMLInputElement>('.tab input')!;
    expect(input).not.toBeNull();
    expect(press(input, ' ')).toBe(false);
  });
});

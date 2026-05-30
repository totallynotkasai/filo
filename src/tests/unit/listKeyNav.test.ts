import { describe, it, expect, beforeEach } from 'vitest';
import { handleListKeyNav, focusFirstItem } from '@renderer/lib/utils/listKeyNav';

function makeList(count: number, orientation: 'h' | 'v' = 'h'): {
  container: HTMLElement;
  items: HTMLButtonElement[];
} {
  const container = document.createElement('div');
  container.setAttribute('role', orientation === 'h' ? 'tablist' : 'menu');
  document.body.appendChild(container);
  const items: HTMLButtonElement[] = [];
  for (let i = 0; i < count; i++) {
    const b = document.createElement('button');
    b.textContent = `item-${i}`;
    b.setAttribute('role', orientation === 'h' ? 'tab' : 'menuitem');
    // jsdom doesn't lay out elements; force offsetParent to non-null so the
    // visibility filter in listKeyNav lets the items through.
    Object.defineProperty(b, 'offsetParent', { get: () => container });
    container.appendChild(b);
    items.push(b);
  }
  return { container, items };
}

function press(container: HTMLElement, key: string): boolean {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  // Mock preventDefault tracking
  return handleListKeyNav(e, container, {
    selector: '[role="tab"], [role="menuitem"]',
    orientation: container.getAttribute('role') === 'tablist' ? 'horizontal' : 'vertical',
  });
}

describe('listKeyNav', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('moves focus forward with ArrowRight on a horizontal tablist', () => {
    const { container, items } = makeList(3, 'h');
    items[0].focus();
    expect(document.activeElement).toBe(items[0]);
    const handled = press(container, 'ArrowRight');
    expect(handled).toBe(true);
    expect(document.activeElement).toBe(items[1]);
  });

  it('moves focus backward with ArrowLeft', () => {
    const { container, items } = makeList(3, 'h');
    items[1].focus();
    press(container, 'ArrowLeft');
    expect(document.activeElement).toBe(items[0]);
  });

  it('wraps from last to first on ArrowRight', () => {
    const { container, items } = makeList(3, 'h');
    items[2].focus();
    press(container, 'ArrowRight');
    expect(document.activeElement).toBe(items[0]);
  });

  it('wraps from first to last on ArrowLeft', () => {
    const { container, items } = makeList(3, 'h');
    items[0].focus();
    press(container, 'ArrowLeft');
    expect(document.activeElement).toBe(items[2]);
  });

  it('Home jumps to first item, End to last', () => {
    const { container, items } = makeList(4, 'h');
    items[2].focus();
    press(container, 'Home');
    expect(document.activeElement).toBe(items[0]);
    press(container, 'End');
    expect(document.activeElement).toBe(items[3]);
  });

  it('vertical orientation uses ArrowDown / ArrowUp', () => {
    const { container, items } = makeList(3, 'v');
    items[0].focus();
    const e1 = new KeyboardEvent('keydown', { key: 'ArrowDown' });
    expect(handleListKeyNav(e1, container, { selector: '[role="menuitem"]', orientation: 'vertical' })).toBe(true);
    expect(document.activeElement).toBe(items[1]);
    const e2 = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    // Horizontal arrows are not handled in vertical orientation
    expect(handleListKeyNav(e2, container, { selector: '[role="menuitem"]', orientation: 'vertical' })).toBe(false);
  });

  it('returns false for unrelated keys', () => {
    const { container, items } = makeList(2);
    items[0].focus();
    const e = new KeyboardEvent('keydown', { key: 'a' });
    expect(handleListKeyNav(e, container, { selector: '[role="tab"]', orientation: 'horizontal' })).toBe(false);
  });

  it('skips disabled items', () => {
    const { container, items } = makeList(3);
    items[1].setAttribute('disabled', '');
    items[0].focus();
    // The visibility filter rejects [disabled] items, so next is items[2].
    press(container, 'ArrowRight');
    expect(document.activeElement).toBe(items[2]);
  });

  it('no-wrap stops at the end when wrap: false', () => {
    const { container, items } = makeList(3, 'h');
    items[2].focus();
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    handleListKeyNav(e, container, { selector: '[role="tab"]', orientation: 'horizontal', wrap: false });
    expect(document.activeElement).toBe(items[2]);
  });

  it('focusFirstItem focuses the first matching child', () => {
    const { container, items } = makeList(3);
    focusFirstItem(container, '[role="tab"]');
    expect(document.activeElement).toBe(items[0]);
  });

  it('returns false on an empty container', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    expect(handleListKeyNav(e, container, { selector: '[role="tab"]' })).toBe(false);
  });
});

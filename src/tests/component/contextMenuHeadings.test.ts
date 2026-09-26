/**
 * A context-menu heading is a real heading: the items under it (up to the
 * next divider or heading) form a `group` named by the heading, and the
 * heading itself is never a menu item or a keyboard stop.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ContextMenu from '@renderer/components/shared/ContextMenu.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { buildBulkCardContextMenu } from '@renderer/lib/kanban/kanbanContextMenus';

describe('context menu headings', () => {
  let app: ReturnType<typeof mount> | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    uiStore.hideContextMenu();
    flushSync();
    if (app) unmount(app);
    host?.remove();
    app = null;
    host = null;
  });

  function open(): HTMLElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    app = mount(ContextMenu, { target: host });
    uiStore.showContextMenu(10, 10, buildBulkCardContextMenu({
      count: 3,
      columns: [{ id: 'a', title: 'Todo' }, { id: 'b', title: 'Done' }],
      onAddTag: () => {}, onRemove: () => {}, onMoveTo: () => {},
    }));
    flushSync();
    return host.querySelector('[role="menu"]') as HTMLElement;
  }

  it('groups the items under each heading, labelled by it', () => {
    const menu = open();
    const groups = [...menu.querySelectorAll('[role="group"]')];
    const summary = groups.map((g) => {
      const label = document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent?.trim();
      const items = [...g.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent?.trim());
      return { label, items };
    });
    expect(summary).toEqual([
      { label: '3 cards selected', items: ['Add tag…', 'Remove from board'] },
      { label: 'Move to column', items: ['Todo', 'Done'] },
    ]);
  });

  it('never makes a heading a menu item or a focus stop', () => {
    const menu = open();
    const itemTexts = [...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent?.trim());
    expect(itemTexts).not.toContain('3 cards selected');
    expect(itemTexts).not.toContain('Move to column');
    for (const h of menu.querySelectorAll('.menu-heading')) {
      expect(h.tagName).not.toBe('BUTTON');
      expect(h.getAttribute('tabindex')).toBeNull();
    }
    // Arrow keys walk the four items and wrap, skipping both headings.
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      flushSync();
      seen.push(menu.querySelector('.menu-item.focused')?.textContent?.trim() ?? '');
    }
    expect(seen).toEqual(['Remove from board', 'Todo', 'Done', 'Add tag…', 'Remove from board']);
  });
});

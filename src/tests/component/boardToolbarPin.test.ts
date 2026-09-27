/**
 * The floating board toolbar's pin: the button toggles the board's pin, a
 * pinned toolbar can't be dragged or reset, and an unpinned one drags and
 * keeps its position per board. Mounts the real Task List toolbar (the one
 * that had no drag before) inside a board scope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import TaskListSideToolbar from '@renderer/components/boards/TaskListSideToolbar.svelte';
import { BOARD_SCOPE_KEY } from '@renderer/lib/boards/boardScope.svelte';
import { workspaceStore } from '@renderer/stores/workspace.svelte';

const noop = (): void => {};

let instance: ReturnType<typeof mount> | null = null;

function mountToolbar(boardId: string): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const scope = { board: { current: { id: boardId } } };
  instance = mount(TaskListSideToolbar, {
    target,
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, scope]]),
    props: {
      onAddTask: noop,
      activeGroupBy: 'none',
      onGroupByChange: noop,
      activeSortBy: 'manual',
      onSortByChange: noop,
      knownStatuses: [],
      activeFilterTags: [],
      onFilterTagsChange: noop,
      activeFilterStatus: null,
      onFilterStatusChange: noop,
      activeFilterPriority: null,
      onFilterPriorityChange: noop,
      showCompleted: true,
      onShowCompletedChange: noop,
      onOpenTagsBrowser: noop,
    },
  });
  flushSync();
  const bar = target.querySelector<HTMLElement>('.side-toolbar');
  if (!bar) throw new Error('no side toolbar');
  return bar;
}

function pinButton(bar: HTMLElement): HTMLButtonElement {
  const button = bar.querySelector<HTMLButtonElement>('button[aria-label="Pin toolbar"]');
  if (!button) throw new Error('no pin button');
  return button;
}

function drag(bar: HTMLElement, x: number, y: number): void {
  const fire = (type: string, cx: number, cy: number): void => {
    bar.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: cx, clientY: cy, pointerId: 3 }));
  };
  fire('pointerdown', 0, 0);
  fire('pointermove', x, y);
  fire('pointerup', x, y);
  flushSync();
}

beforeEach(() => {
  workspaceStore.reset();
  workspaceStore.setChangeListener(null);
  window.innerWidth = 1200;
  window.innerHeight = 900;
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  workspaceStore.reset();
  document.body.innerHTML = '';
});

describe('floating board toolbar pin', () => {
  it('the pin button toggles the board pin', () => {
    const bar = mountToolbar('tl');
    const pin = pinButton(bar);
    expect(pin.getAttribute('aria-pressed')).toBe('false');

    pin.click();
    flushSync();
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(bar.classList.contains('pinned')).toBe(true);
    expect(workspaceStore.boardToolbar('tl').pinned).toBe(true);

    pin.click();
    flushSync();
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    expect(workspaceStore.boardToolbar('tl').pinned).toBe(false);
  });

  it('an unpinned toolbar drags, and the position is kept for its board only', () => {
    const bar = mountToolbar('tl');
    drag(bar, 200, 150);
    expect(bar.style.left).toBe('200px');
    expect(bar.style.top).toBe('150px');
    expect(workspaceStore.boardToolbar('tl').position).toEqual({ x: 200, y: 150 });
    expect(workspaceStore.boardToolbar('other').position).toBeNull();
  });

  it('a pinned toolbar neither drags nor resets on right-click', () => {
    const bar = mountToolbar('tl');
    drag(bar, 200, 150);
    pinButton(bar).click();
    flushSync();

    drag(bar, 500, 500);
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    bar.dispatchEvent(menu);
    flushSync();

    expect(menu.defaultPrevented).toBe(false);
    expect(bar.style.left).toBe('200px');
    expect(workspaceStore.boardToolbar('tl').position).toEqual({ x: 200, y: 150 });
  });

  it('right-click on an unpinned toolbar docks it again', () => {
    const bar = mountToolbar('tl');
    drag(bar, 200, 150);
    bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSync();
    expect(bar.style.left).toBe('');
    expect(workspaceStore.boardToolbar('tl').position).toBeNull();
  });
});

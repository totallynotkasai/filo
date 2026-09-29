/**
 * A Task List row's due chip reads the clock store's day, so a task due today
 * turns overdue at local midnight without the row re-rendering for any other
 * reason. Mounts the real row.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import TaskItem from '@renderer/components/boards/TaskItem.svelte';
import { clockStore } from '@renderer/stores/clock.svelte';
import type { Tile } from '@renderer/schema/index';

let instance: ReturnType<typeof mount> | null = null;
const noop = (): void => {};

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  clockStore.stop();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function task(): Tile {
  return {
    id: 't1', type: 'text', title: 'Pay rent', content: '', boardId: 'tl',
    position: { x: 0, y: 0 }, size: { width: 300, height: 40 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    locked: false, faded: false, frameless: false, tags: [], createdAt: 0, updatedAt: 0,
  } as Tile;
}

describe('a due chip at midnight', () => {
  it('turns overdue when the day moves on', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 29, 23, 58));
    clockStore.stop();
    const target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(TaskItem, {
      target,
      props: {
        tile: task(), completed: false, priority: 'none', dueDate: '2026-09-29',
        accentColor: '#3366ff', onToggleComplete: noop, onCyclePriority: noop,
        onSetDueDate: noop, onRename: noop, onDelete: noop, onOpen: noop,
      },
    });
    flushSync();
    const chip = (): Element | null => target.querySelector('.overdue');
    expect(chip()).toBeNull();

    vi.advanceTimersByTime(3 * 60_000);
    flushSync();
    expect(chip()).not.toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildDateContextMenu, buildRepeatMenu, unreadableRule } from '@renderer/lib/tasklist/taskDateMenus';
import { makeFrontmatterWriter, recurrenceModePatch } from '@renderer/lib/tasklist/frontmatterWriter';
import { everyRule, parseRecurrence, recurrenceLabel } from '@renderer/lib/tasks/recurrence';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { ContextMenuItem } from '@renderer/stores/ui.svelte';
import type { TaskListBoard as TaskListBoardType, Tile } from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * The Repeat menu (E-25): five presets used to be all it offered, so "every
 * 3 days" or a repeat counted from the day a task is done couldn't be set,
 * and a rule Filo can't read made Complete mark the task done for good with
 * no word about it.
 */

const labels = (items: ContextMenuItem[]): string[] => items.filter((i) => !i.divider).map((i) => `${i.checked ? '[x] ' : ''}${i.label}`);

function menu(recurrence: string, mode: 'schedule' | 'completion' = 'schedule') {
  const onSet = vi.fn();
  const onSetMode = vi.fn();
  const onCustom = vi.fn();
  const items = buildRepeatMenu({ recurrence, mode, onSet, onSetMode, onCustom });
  const pick = (label: string): void => items.find((i) => i.label.replace(/^\[x\] /, '') === label)?.action?.();
  return { items, onSet, onSetMode, onCustom, pick };
}

describe('the Repeat menu', () => {
  it('offers the presets, "Every…" for any number, and checks the rule the task has', () => {
    expect(labels(menu('').items)).toEqual([
      '[x] None', 'Daily', 'Weekdays (Mon–Fri)', 'Weekly', 'Every 2 weeks', 'Monthly', 'Yearly', 'Every…',
    ]);
    expect(labels(menu('every 1 week').items)).toContain('[x] Weekly');
    expect(labels(menu('every 2 w').items)).toContain('[x] Every 2 weeks');
  });

  it('a rule set through "Every…" is shown and checked on that item', () => {
    const { items, pick, onCustom } = menu('every 3 days');
    expect(labels(items)).toContain('[x] Every 3 days…');
    pick('Every 3 days…');
    expect(onCustom).toHaveBeenCalled();
  });

  it('with a rule, says what the next date counts from, and changes it', () => {
    const { items, pick, onSetMode } = menu('weekly', 'completion');
    expect(labels(items).slice(-3)).toEqual(['The next date counts from', 'The due date', '[x] The day it is done']);
    pick('The due date');
    expect(onSetMode).toHaveBeenCalledWith('schedule');
    expect(labels(menu('').items)).not.toContain('The due date');
  });

  it('names a rule Filo can\'t read, above the rules it can', () => {
    const { items, pick, onSet } = menu('every 2nd tuesday');
    expect(items[0]).toMatchObject({ heading: true, label: expect.stringContaining('can\'t read "every 2nd tuesday"') });
    expect(labels(items)).not.toContain('The due date');
    pick('Weekly');
    expect(onSet).toHaveBeenCalledWith('weekly');
    expect(unreadableRule('every 2nd tuesday')).toBe(true);
    expect(unreadableRule('Weekly')).toBe(false);
    expect(unreadableRule('')).toBe(false);
  });

  it('every rule the menu and "Every…" write is one the recurrence engine reads', () => {
    for (const unit of ['d', 'w', 'm', 'y'] as const) {
      for (const n of [1, 2, 3, 12, 999]) expect(parseRecurrence(everyRule(n, unit)), `${n}${unit}`).not.toBeNull();
    }
    expect(recurrenceLabel(everyRule(3, 'd'))).toBe('Every 3 days');
    expect(recurrenceLabel(everyRule(1, 'm'))).toBe('Monthly');
    expect(recurrenceLabel('weekday')).toBe('Weekdays');
  });
});

describe('the date chips\' menu', () => {
  it('shows a start date and a rule in words', () => {
    const items = buildDateContextMenu({
      dueDate: '2026-10-12', startDate: '2026-10-09', recurrence: 'every 2 weeks', now: new Date(2026, 9, 5),
      onPickDue: vi.fn(), onPickStart: vi.fn(), onRepeat: vi.fn(), onClearDue: vi.fn(), onClearStart: vi.fn(),
    });
    const text = labels(items).join(' | ');
    expect(text).toMatch(/Start: (Oct 9|9 Oct)/);
    expect(text).toContain('Repeat: Every 2 weeks…');
    expect(text).toContain('Clear due date');
  });
});

describe('what a repeat counts from (recurrenceModePatch)', () => {
  it('completion is written; the due date (the default) removes the key; the anchor goes either way', () => {
    expect(recurrenceModePatch('completion')).toEqual({ recurrenceMode: 'completion', recurrenceAnchor: '' });
    expect(recurrenceModePatch('schedule')).toEqual({ recurrenceMode: '', recurrenceAnchor: '' });
  });
});

describe('Complete on a rule Filo can\'t read warns, with Undo', () => {
  let vault: MemoryVault;
  const board = { id: 'tl', type: 'tasklist', name: 'T', settings: {}, tasks: [], sections: [] } as unknown as TaskListBoardType;

  function row(recurrence: string): TaskRow {
    return {
      placement: { tileId: 't1', position: 0 },
      tile: { id: 't1', type: 'text', filePath: 'Plants.md', title: 'Water plants', tags: [] } as unknown as Tile,
      completed: false, priority: 'none', dueDate: '2026-10-05', dueTime: '', startDate: '', status: '', tags: [], parent: '',
      recurrence, recurrenceMode: 'schedule', category: '',
    };
  }

  const writer = () => makeFrontmatterWriter({
    getBoard: () => board,
    vaultPathForTile: () => 'Plants.md',
    readFrontmatter: () => ({}),
    bumpCacheVersion: () => {},
  });

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard('tl');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    vaultIndexStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard(null);
    restoreFiloDefault();
  });

  it('marks it done, says it won\'t repeat, and Undo puts it back', async () => {
    vault = installMemoryVault({ 'Plants.md': '---\ncompleted: false\ndueDate: 2026-10-05\nrecurrence: every 2nd tuesday\n---\n' });
    const push = vi.spyOn(uiStore, 'pushToast');
    await writer().toggleCompleted(row('every 2nd tuesday'));
    await noteStore.flushAll();
    expect(vault.read('Plants.md')).toContain('completed: true');
    const toast = push.mock.calls.at(-1)?.[0];
    expect(toast?.text).toMatch(/won't repeat: Filo can't read its repeat rule "every 2nd tuesday"/);
    expect(toast?.type).toBe('warning');
    await toast?.actions?.[0]?.handler();
    await historyStore.whenChainSettled();
    await noteStore.flushAll();
    expect(vault.read('Plants.md')).toContain('completed: false');
  });

  it('a rule it reads rolls forward, with no warning', async () => {
    vault = installMemoryVault({ 'Plants.md': '---\ncompleted: false\ndueDate: 2026-10-05\nrecurrence: weekly\n---\n' });
    const push = vi.spyOn(uiStore, 'pushToast');
    await writer().toggleCompleted(row('weekly'));
    expect(push.mock.calls.some((c) => c[0].type === 'warning')).toBe(false);
  });
});

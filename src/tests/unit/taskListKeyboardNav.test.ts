import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Task List Alt+Up / Alt+Down and Tab follow the screen (E-03, E-04, D2):
 * the move is read off the rows as drawn and committed as the order drawn
 * (switching to Manual under another sort), and Tab indents one level.
 */

// Capture what Alt+Up / Alt+Down commit, without a real history store.
const captured = vi.hoisted(() => ({ after: [] as Array<{ tasks: Array<{ tileId: string }> }>, toasts: [] as string[], switched: 0 }));
vi.mock('@renderer/commands/index', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    ReorderTaskWithinSectionCommand: class {
      constructor(_b: string, _before: unknown, after: { tasks: Array<{ tileId: string }> }) {
        captured.after.push(after);
      }
      execute(): void {}
      undo(): void {}
    },
  };
});
vi.mock('@renderer/lib/tasklist/manualSortSwitch', () => ({
  executeReorderSwitchingToManual: () => { captured.switched++; return Promise.resolve(); },
}));
vi.mock('@renderer/stores/history.svelte', () => ({ historyStore: { execute: vi.fn(() => Promise.resolve()) } }));
vi.mock('@renderer/stores/ui.svelte', () => ({ uiStore: { toast: (m: string) => { captured.toasts.push(m); return 't'; }, pushToast: () => 't' } }));

import { TaskListViewModel, type TaskListViewModelDeps } from '@renderer/lib/tasklist/taskListViewModel.svelte';
import { TaskListKeyboardNav } from '@renderer/lib/tasklist/taskListKeyboardNav.svelte';
import type { SortBy, TaskRow } from '@renderer/lib/tasks/taskListModel';
import type { Tile, TaskPlacement } from '@renderer/schema/index';

interface TaskSpec { id: string; parent?: string; priority?: string }

function tile(id: string): Tile {
  return { id, type: 'text', title: id, position: { x: 0, y: 0 }, size: { w: 1, h: 1 }, style: {}, locked: false, createdAt: 0 } as unknown as Tile;
}

interface Board {
  vm: TaskListViewModel;
  placements: { value: TaskPlacement[] };
  sortBy: { value: SortBy };
}

function setup(tasks: TaskSpec[], sortBy: SortBy = 'manual'): Board {
  const placements = { value: tasks.map((t, i) => ({ tileId: t.id, position: i, ...(t.parent ? { parentTileId: t.parent } : {}) }) as TaskPlacement) };
  const sort = { value: sortBy };
  const tilesById = Object.fromEntries(tasks.map((t) => [t.id, tile(t.id)]));
  const priority = Object.fromEntries(tasks.map((t) => [t.id, t.priority]));
  const deps: TaskListViewModelDeps = {
    getPlacements: () => placements.value,
    getTilesById: () => tilesById,
    getDisplaySections: () => [{ id: '__default__', title: 'Task List', position: 0, collapsed: false }],
    getCacheVersion: () => 0,
    readFrontmatter: (t) => (priority[t.id] ? { priority: priority[t.id] } : {}),
    getActiveSmartList: () => 'all',
    getShowCompleted: () => true,
    getActiveFilterPriority: () => null,
    getActiveFilterStatus: () => null,
    getActiveFilterTags: () => [],
    getSortBy: () => sort.value,
    getGroupBy: () => 'none',
    getDefaultSectionId: () => '__default__',
    getCollapsedSubtasks: () => new Set(),
    getLeadingSectionId: () => '__leading__',
  };
  return { vm: new TaskListViewModel(deps), placements, sortBy: sort };
}

function nav(b: Board, commitIndent = vi.fn()): TaskListKeyboardNav {
  return new TaskListKeyboardNav({
    getBoard: () => ({ id: 'b' }) as never,
    getRows: () => b.vm.rows,
    getRenderedRows: () => b.vm.renderedRows,
    getFlatSections: () => b.vm.flatSections,
    getLeadingSectionId: () => '__leading__',
    getPlacements: () => b.placements.value,
    getSections: () => [],
    getSortBy: () => b.sortBy.value,
    snapshotSections: () => ({ sections: [], tasks: b.placements.value }),
    commitIndent,
    commitOutdent: vi.fn(),
    tickAndPersist: vi.fn(),
    getSelectionSize: () => 0,
    clearSelection: vi.fn(),
  });
}

/** Draws the rows as focusable elements and focuses `id`'s. */
function focusRow(b: Board, id: string): void {
  document.body.innerHTML = '';
  for (const r of b.vm.renderedRows) {
    const el = document.createElement('div');
    el.className = 'task-item';
    el.dataset.taskId = r.tile.id;
    el.tabIndex = 0;
    document.body.appendChild(el);
  }
  (document.querySelector(`[data-task-id="${id}"]`) as HTMLElement).focus();
}

const row = (b: Board, id: string): TaskRow => b.vm.rows.find((r) => r.tile.id === id)!;
const drawn = (b: Board): string[] => b.vm.renderedRows.map((r) => r.tile.id);

/** The board after the committed placements, as the board takes them. */
function committed(b: Board, sortBy: SortBy = 'manual'): Board {
  const tasks = (captured.after.at(-1)?.tasks ?? []) as TaskPlacement[];
  return setup(tasks.map((p) => ({ id: p.tileId, ...(p.parentTileId ? { parent: p.parentTileId } : {}) })), sortBy);
}

afterEach(() => {
  document.body.innerHTML = '';
  captured.after.length = 0;
  captured.toasts.length = 0;
  captured.switched = 0;
});

describe('Tab indents one level, under the row above at the same level', () => {
  it('Tab on B after A > A1 > A1a makes B a subtask of A (it was refused)', () => {
    const b = setup([{ id: 'A' }, { id: 'A1', parent: 'A' }, { id: 'A1a', parent: 'A1' }, { id: 'B' }]);
    expect(drawn(b)).toEqual(['A', 'A1', 'A1a', 'B']);
    const commitIndent = vi.fn();
    expect(nav(b, commitIndent).indentFocused(row(b, 'B'), false)).toBe(true);
    expect(captured.toasts).toEqual([]);
    expect(commitIndent).toHaveBeenCalledWith('B', 'A');
  });

  it('Tab on B after A > A1 puts B one level in, under A (it was two, under A1)', () => {
    const b = setup([{ id: 'A' }, { id: 'A1', parent: 'A' }, { id: 'B' }]);
    const commitIndent = vi.fn();
    nav(b, commitIndent).indentFocused(row(b, 'B'), false);
    expect(commitIndent).toHaveBeenCalledWith('B', 'A');
  });

  it('a refused indent says why and leaves Tab to move focus on (no trap)', () => {
    // A1a is as deep as a task goes: its sibling A1b can't go under it.
    const b = setup([{ id: 'A' }, { id: 'A1', parent: 'A' }, { id: 'A1a', parent: 'A1' }, { id: 'A1b', parent: 'A1' }]);
    const commitIndent = vi.fn();
    expect(nav(b, commitIndent).indentFocused(row(b, 'A1b'), false)).toBe(false);
    expect(commitIndent).not.toHaveBeenCalled();
    expect(captured.toasts).toEqual(['Maximum subtask depth reached']);
  });
});

describe('Alt+Up / Alt+Down follow the screen', () => {
  it('Alt+Up on C below B (which has subtask B1) puts C above B in one press', () => {
    const b = setup([{ id: 'A' }, { id: 'B' }, { id: 'B1', parent: 'B' }, { id: 'C' }]);
    focusRow(b, 'C');
    expect(nav(b).moveFocusedRow(-1)).toBe(true);
    expect(drawn(committed(b))).toEqual(['A', 'C', 'B', 'B1']);
  });

  it('under a priority sort, Alt+Up moves the row one place as drawn and fixes that order, switching to Manual', () => {
    // File order A, B, C (low, high, medium): drawn B, C, A.
    const b = setup([{ id: 'A', priority: 'low' }, { id: 'B', priority: 'high' }, { id: 'C', priority: 'medium' }], 'priority');
    expect(drawn(b)).toEqual(['B', 'C', 'A']);
    focusRow(b, 'C');
    expect(nav(b).moveFocusedRow(-1)).toBe(true);
    expect(captured.switched).toBe(1);
    expect(drawn(committed(b))).toEqual(['C', 'B', 'A']);
  });

  it('leaves the key alone at the top, and with no row focused', () => {
    const b = setup([{ id: 'A' }, { id: 'B' }]);
    focusRow(b, 'A');
    expect(nav(b).moveFocusedRow(-1)).toBe(false);
    document.body.innerHTML = '';
    expect(nav(b).moveFocusedRow(1)).toBe(false);
    expect(captured.after).toEqual([]);
  });
});

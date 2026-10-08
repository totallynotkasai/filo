import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TaskListViewModel,
  type TaskListViewModelDeps,
} from '@renderer/lib/tasklist/taskListViewModel.svelte';
import { TaskListKeyboardNav } from '@renderer/lib/tasklist/taskListKeyboardNav.svelte';
import { MultiSelectController } from '@renderer/lib/tasklist/multiSelectController.svelte';
import type { GroupBy, SortBy, TaskRow } from '@renderer/lib/tasks/taskListModel';
import type { Tile, TaskPlacement, TaskListSection } from '@renderer/schema/index';

/**
 * The Task List's keys and ranges follow the rows as drawn (E-01), and Group
 * By groups the rows inside each section (E-16). The rows on screen come from
 * the view model (`flatSections` / `renderedRows`): sections in order, each
 * section's rows group by group in the sort's order, a parent's shown
 * subtasks under it, and nothing from a folded section or parent.
 */

interface TaskSpec {
  id: string;
  priority?: string;
  completed?: boolean;
  /** A subtask's parent, on its placement. */
  parent?: string;
}

function tile(id: string): Tile {
  return { id, type: 'text', title: id, position: { x: 0, y: 0 }, size: { w: 1, h: 1 }, style: {}, locked: false, createdAt: 0 } as unknown as Tile;
}

function makeVm(opts: {
  tasks: TaskSpec[];
  sections?: TaskListSection[];
  sortBy?: SortBy;
  groupBy?: GroupBy;
  collapsedSubtasks?: string[];
}): TaskListViewModel {
  const placements: TaskPlacement[] = opts.tasks.map((t, i) => ({
    tileId: t.id,
    position: i,
    ...(t.parent ? { parentTileId: t.parent } : {}),
  }) as TaskPlacement);
  const tilesById = Object.fromEntries(opts.tasks.map((t) => [t.id, tile(t.id)]));
  const fm = Object.fromEntries(opts.tasks.map((t) => [t.id, {
    ...(t.priority ? { priority: t.priority } : {}),
    ...(t.completed ? { completed: true } : {}),
  }]));
  const deps: TaskListViewModelDeps = {
    getPlacements: () => placements,
    getTilesById: () => tilesById,
    getDisplaySections: () => opts.sections ?? [{ id: 'only', title: 'Task List', position: 0, collapsed: false }],
    getCacheVersion: () => 0,
    readFrontmatter: (t) => fm[t.id] ?? {},
    getActiveSmartList: () => 'all',
    getShowCompleted: () => true,
    getActiveFilterPriority: () => null,
    getActiveFilterStatus: () => null,
    getActiveFilterTags: () => [],
    getSortBy: () => opts.sortBy ?? 'priority',
    getGroupBy: () => opts.groupBy ?? 'none',
    getDefaultSectionId: () => '__default__',
    getCollapsedSubtasks: () => new Set(opts.collapsedSubtasks ?? []),
    getLeadingSectionId: () => '__leading__',
  };
  return new TaskListViewModel(deps);
}

const ids = (rows: readonly TaskRow[]): string[] => rows.map((r) => r.tile.id);

/** The rows as drawn, one string per row: "  B" for a subtask, "[Done] A" for a group's first row. */
function drawn(vm: TaskListViewModel): string[] {
  return vm.flatSections.flatMap((s) => s.collapsed ? [`(${s.sectionId} folded)`] : s.entries.map((e) =>
    `${e.group ? `[${e.group.label} ${e.group.count}] ` : ''}${'  '.repeat(e.depth)}${e.row.tile.id}`));
}

/** Focusable rows in the DOM, as the board draws them. */
function drawRows(rowIds: string[]): void {
  document.body.innerHTML = '';
  for (const id of rowIds) {
    const el = document.createElement('div');
    el.className = 'task-item';
    el.dataset.taskId = id;
    el.tabIndex = 0;
    document.body.appendChild(el);
  }
}

function keyboardNav(vm: TaskListViewModel, commitIndent = vi.fn()): TaskListKeyboardNav {
  return new TaskListKeyboardNav({
    getBoard: () => ({ id: 'b' }) as never,
    getRows: () => vm.rows,
    getRenderedRows: () => vm.renderedRows,
    getFlatSections: () => vm.flatSections,
    getLeadingSectionId: () => '__leading__',
    getPlacements: () => vm.rows.map((r) => r.placement),
    getSections: () => [],
    getSortBy: () => 'priority',
    snapshotSections: () => ({ sections: [], tasks: [] }),
    commitIndent,
    commitOutdent: vi.fn(),
    tickAndPersist: vi.fn(),
    getSelectionSize: () => 0,
    clearSelection: vi.fn(),
  });
}

function selection(vm: TaskListViewModel): MultiSelectController {
  return new MultiSelectController({
    getBoard: () => null,
    getRows: () => vm.rows,
    getRenderedRows: () => vm.renderedRows,
    getPlacements: () => vm.rows.map((r) => r.placement),
    getSections: () => [],
    buildTaskFieldCommand: () => null,
    bumpCacheVersion: vi.fn(),
    tickAndPersist: vi.fn(),
    announce: vi.fn(),
  });
}

const focused = (): string | undefined => (document.activeElement as HTMLElement | null)?.dataset.taskId;

afterEach(() => { document.body.innerHTML = ''; });

describe('the rows on screen (renderedRows)', () => {
  it('follows the sort, not the file: priority puts B, A, C on screen', () => {
    const vm = makeVm({ tasks: [{ id: 'A', priority: 'low' }, { id: 'B', priority: 'high' }, { id: 'C' }] });
    expect(ids(vm.renderedRows)).toEqual(['B', 'A', 'C']);
  });

  it('puts each subtask under its parent, and leaves a folded parent\'s out', () => {
    const tasks = [{ id: 'P' }, { id: 'S', parent: 'P' }, { id: 'Q' }];
    expect(drawn(makeVm({ tasks, sortBy: 'manual' }))).toEqual(['P', '  S', 'Q']);
    expect(ids(makeVm({ tasks, sortBy: 'manual', collapsedSubtasks: ['P'] }).renderedRows)).toEqual(['P', 'Q']);
  });

  it('goes section by section and leaves a folded section out', () => {
    const sections: TaskListSection[] = [
      { id: 'todo', title: 'To do', position: 0, collapsed: false },
      { id: 'later', title: 'Later', position: 2, collapsed: true },
      { id: 'done', title: 'Done', position: 3, collapsed: false },
    ];
    const vm = makeVm({ tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], sections, sortBy: 'manual' });
    expect(ids(vm.renderedRows)).toEqual(['a', 'b', 'd']);
    expect(drawn(vm)).toEqual(['a', 'b', '(later folded)', 'd']);
  });
});

describe('Group By inside each section (E-16)', () => {
  const sections: TaskListSection[] = [
    { id: 's1', title: 'Act one', position: 0, collapsed: false },
    { id: 's2', title: 'Act two', position: 3, collapsed: false },
  ];
  const tasks: TaskSpec[] = [
    { id: 'a1', completed: true }, { id: 'a2', priority: 'high' }, { id: 'a3' },
    { id: 'b1' }, { id: 'b2', completed: true },
  ];

  it('groups each section\'s rows by status, To Do before Done, each group headed', () => {
    const vm = makeVm({ tasks, sections, sortBy: 'priority', groupBy: 'status' });
    expect(drawn(vm)).toEqual([
      '[To Do 2] a2', 'a3', '[Done 1] a1',
      '[To Do 1] b1', '[Done 1] b2',
    ]);
    // A task stays in its own section: grouping never moves it across.
    expect(vm.sectionedView.map((s) => ids(s.rows))).toEqual([['a2', 'a3', 'a1'], ['b1', 'b2']]);
  });

  it('groups by priority in the shared words', () => {
    const vm = makeVm({ tasks, sections, sortBy: 'manual', groupBy: 'priority' });
    expect(drawn(vm)).toEqual([
      '[High 1] a2', '[No priority 2] a1', 'a3',
      '[No priority 2] b1', 'b2',
    ]);
  });

  it('a subtask stays under its parent, whatever group its own fields would put it in', () => {
    const vm = makeVm({
      tasks: [{ id: 'P' }, { id: 'S', parent: 'P', completed: true }, { id: 'Q', completed: true }],
      sortBy: 'manual',
      groupBy: 'status',
    });
    expect(drawn(vm)).toEqual(['[To Do 1] P', '  S', '[Done 1] Q']);
  });

  it('None shows no headings and keeps the sort\'s order', () => {
    const vm = makeVm({ tasks, sections, sortBy: 'manual', groupBy: 'none' });
    expect(drawn(vm)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
  });

  it('the keys follow the grouped order', () => {
    const vm = makeVm({ tasks, sections, sortBy: 'priority', groupBy: 'status' });
    expect(ids(vm.renderedRows)).toEqual(['a2', 'a3', 'a1', 'b1', 'b2']);
  });
});

describe('arrow keys and Tab follow the screen (E-01)', () => {
  // Placement order A(low), B(high), C(none); sorted by priority the screen shows B, A, C.
  const tasks: TaskSpec[] = [{ id: 'A', priority: 'low' }, { id: 'B', priority: 'high' }, { id: 'C' }];

  it('ArrowDown from the top row (B) focuses the row below it on screen (A)', () => {
    const vm = makeVm({ tasks });
    drawRows(ids(vm.renderedRows));
    (document.querySelector('[data-task-id="B"]') as HTMLElement).focus();
    const nav = keyboardNav(vm);
    nav.moveFocus(1);
    expect(focused()).toBe('A');
    nav.moveFocus(1);
    expect(focused()).toBe('C');
    nav.moveFocus(-1);
    expect(focused()).toBe('A');
  });

  it('Tab on C indents it under A, the row above it on screen', () => {
    const vm = makeVm({ tasks });
    const commitIndent = vi.fn();
    keyboardNav(vm, commitIndent).indentFocused(vm.rows[2]!, false);
    expect(commitIndent).toHaveBeenCalledWith('C', 'A');
  });

  it('ArrowDown moves past a folded parent instead of sticking on it', () => {
    const vm = makeVm({ tasks: [{ id: 'P' }, { id: 'S', parent: 'P' }, { id: 'Q' }], sortBy: 'manual', collapsedSubtasks: ['P'] });
    drawRows(ids(vm.renderedRows));
    (document.querySelector('[data-task-id="P"]') as HTMLElement).focus();
    const nav = keyboardNav(vm);
    nav.moveFocus(1);
    nav.moveFocus(1);
    expect(focused()).toBe('Q');
  });
});

describe('Shift-click and Select All follow the screen (E-01)', () => {
  it('a Shift-click range is the rows between the two clicks on screen', () => {
    // Placement order A(low), B(high), C(none), D(urgent); on screen D, B, A, C.
    const vm = makeVm({ tasks: [{ id: 'A', priority: 'low' }, { id: 'B', priority: 'high' }, { id: 'C' }, { id: 'D', priority: 'urgent' }] });
    const ms = selection(vm);
    ms.handleRowSelect('D', { shift: false, ctrl: false });
    ms.handleRowSelect('A', { shift: true, ctrl: false });
    expect([...ms.selectedTaskIds].sort()).toEqual(['A', 'B', 'D']);
  });

  it('a range across a folded section leaves its rows out', () => {
    const sections: TaskListSection[] = [
      { id: 's1', title: 'One', position: 0, collapsed: false },
      { id: 's2', title: 'Two', position: 1, collapsed: true },
      { id: 's3', title: 'Three', position: 2, collapsed: false },
    ];
    const vm = makeVm({ tasks: [{ id: 'a' }, { id: 'hidden' }, { id: 'c' }], sections, sortBy: 'manual' });
    const ms = selection(vm);
    ms.handleRowSelect('a', { shift: false, ctrl: false });
    ms.handleRowSelect('c', { shift: true, ctrl: false });
    expect([...ms.selectedTaskIds].sort()).toEqual(['a', 'c']);
  });

  it('Select All takes the rows on screen, not a folded parent\'s subtasks', () => {
    const vm = makeVm({ tasks: [{ id: 'P' }, { id: 'S', parent: 'P' }, { id: 'Q' }], sortBy: 'manual', collapsedSubtasks: ['P'] });
    const ms = selection(vm);
    ms.selectAllVisible();
    expect([...ms.selectedTaskIds].sort()).toEqual(['P', 'Q']);
  });
});

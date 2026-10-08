import { describe, it, expect, vi, afterEach } from 'vitest';
import { indentProblem } from '@renderer/lib/tasklist/indentRules';
import { TaskListKeyboardNav } from '@renderer/lib/tasklist/taskListKeyboardNav.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { TaskListSection, TaskPlacement } from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';

/**
 * One indent rule for the drag and for Tab: the new parent must be in the
 * same section, can't be the task or one of its own subtasks, and nothing
 * may end up deeper than a sub-subtask. Tab on a row that can't indent (or
 * Shift+Tab on a top-level row) leaves the key to the browser, so keyboard
 * focus is never trapped on the list.
 */

const row = (id: string, parent = ''): { tile: { id: string }; parent: string } => ({ tile: { id }, parent });
const p = (tileId: string, position: number): TaskPlacement => ({ tileId, position }) as TaskPlacement;
const s = (id: string, position: number): TaskListSection => ({ id, title: id, position }) as TaskListSection;

describe('indentProblem', () => {
  const placements = ['a', 'b', 'c', 'd', 'x'].map((id, i) => p(id, i));

  it('allows a sibling above in the same section', () => {
    expect(indentProblem({ rows: [row('a'), row('b')], placements, sections: [], tileId: 'b', newParentId: 'a' })).toBeNull();
  });

  it('refuses a parent in another section', () => {
    const sections = [s('S1', 0), s('S2', 4)];
    expect(indentProblem({ rows: [row('d'), row('x')], placements, sections, tileId: 'x', newParentId: 'd' }))
      .toMatch(/another section/);
  });

  it('refuses the task itself and its own subtasks', () => {
    const rows = [row('a'), row('b', 'a')];
    expect(indentProblem({ rows, placements, sections: [], tileId: 'a', newParentId: 'b' })).toMatch(/own subtask/);
    expect(indentProblem({ rows, placements, sections: [], tileId: 'a', newParentId: 'a' })).toMatch(/own subtask/);
  });

  it('refuses a fourth level', () => {
    const rows = [row('a'), row('b', 'a'), row('c', 'b'), row('d')];
    expect(indentProblem({ rows, placements, sections: [], tileId: 'd', newParentId: 'c' })).toMatch(/Maximum/);
  });

  it('counts the task\'s own subtasks against the limit', () => {
    // d has a subtask x; under b (depth 1) d would be depth 2 and x depth 3.
    const rows = [row('a'), row('b', 'a'), row('d'), row('x', 'd')];
    expect(indentProblem({ rows, placements, sections: [], tileId: 'd', newParentId: 'b' })).toMatch(/Maximum/);
    expect(indentProblem({ rows, placements, sections: [], tileId: 'd', newParentId: 'a' })).toBeNull();
  });
});

describe('Tab on a Task List row', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function setup(rows: TaskRow[], sections: TaskListSection[] = []) {
    const indent = vi.fn();
    const outdent = vi.fn();
    const depth = (r: TaskRow): number => (r.parent ? 1 + depth(rows.find((x) => x.tile.id === r.parent)!) : 0);
    const nav = new TaskListKeyboardNav({
      getBoard: () => null,
      getRows: () => rows,
      getRenderedRows: () => rows,
      getFlatSections: () => [{ sectionId: '__leading__', collapsed: false, entries: rows.map((r) => ({ row: r, depth: depth(r) })) }],
      getLeadingSectionId: () => '__leading__',
      getPlacements: () => rows.map((r, i) => p(r.tile.id, i)),
      getSections: () => sections,
      getSortBy: () => 'manual',
      snapshotSections: () => ({ sections: [], tasks: [] }),
      commitIndent: indent,
      commitOutdent: outdent,
      tickAndPersist: () => {},
      getSelectionSize: () => 0,
      clearSelection: () => {},
    });
    const els = new Map<string, HTMLElement>();
    for (const r of rows) {
      const el = document.createElement('div');
      el.className = 'task-item';
      el.dataset.taskId = r.tile.id;
      el.tabIndex = 0;
      const btn = document.createElement('button');
      el.appendChild(btn);
      document.body.appendChild(el);
      els.set(r.tile.id, el);
    }
    const press = (target: HTMLElement, shiftKey = false): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      Object.defineProperty(e, 'target', { value: target });
      nav.handleBoardKeydown(e);
      return e;
    };
    return { indent, outdent, els, press };
  }
  const task = (id: string, parent = ''): TaskRow => ({ tile: { id }, parent } as unknown as TaskRow);

  it('indents under the row above, through the same commit as a drag', () => {
    const { indent, els, press } = setup([task('a'), task('b')]);
    const e = press(els.get('b')!);
    expect(indent).toHaveBeenCalledWith('b', 'a');
    expect(e.defaultPrevented).toBe(true);
  });

  it('indents one level, under the row above at its level, not under that row\'s subtasks', () => {
    const { indent, els, press } = setup([task('a'), task('b', 'a'), task('c', 'b'), task('d')]);
    press(els.get('d')!);
    expect(indent).toHaveBeenCalledWith('d', 'a');
  });

  it('a refused indent says why, does not commit, and lets Tab move focus on', () => {
    const toast = vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
    // c is a sub-subtask: its sibling c2 can't go under it (a fourth level).
    const { indent, els, press } = setup([task('a'), task('b', 'a'), task('c', 'b'), task('c2', 'b')]);
    const e = press(els.get('c2')!);
    expect(indent).not.toHaveBeenCalled();
    expect(toast.mock.calls[0]?.[0]).toMatch(/Maximum/);
    expect(e.defaultPrevented).toBe(false);
  });

  it('Tab on the first row, and Shift+Tab on a top-level row, move focus as usual', () => {
    const { indent, outdent, els, press } = setup([task('a'), task('b')]);
    expect(press(els.get('a')!).defaultPrevented).toBe(false);
    expect(press(els.get('b')!, true).defaultPrevented).toBe(false);
    expect(indent).not.toHaveBeenCalled();
    expect(outdent).not.toHaveBeenCalled();
  });

  it('Tab from a button inside a row steps on instead of indenting', () => {
    const { indent, els, press } = setup([task('a'), task('b')]);
    const e = press(els.get('b')!.querySelector('button')!);
    expect(indent).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('Shift+Tab on a subtask outdents it', () => {
    const { outdent, els, press } = setup([task('a'), task('b', 'a')]);
    expect(press(els.get('b')!, true).defaultPrevented).toBe(true);
    expect(outdent).toHaveBeenCalledWith('b');
  });
});

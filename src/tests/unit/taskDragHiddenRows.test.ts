import { describe, it, expect } from 'vitest';
import {
  TaskDragController,
  type SectionItemsSnapshot,
} from '@renderer/lib/tasklist/taskDragController.svelte';
import { sameTileIds, type RowDndItem } from '@renderer/lib/tasklist/blockMove';
import type { TaskPlacement, TaskListSection } from '@renderer/schema/index';

/**
 * A Task List drag sees only the rows on screen. Rows hidden by a collapsed
 * parent, "Show completed" off, a smart list or a filter must survive every
 * drop, in their place next to the visible row they followed.
 */

interface RowFx {
  tile: { id: string };
  parent: string;
}

interface Reorder {
  nextPlacements: TaskPlacement[];
  nextSections: TaskListSection[];
}

const p = (tileId: string, position: number): TaskPlacement => ({ tileId, position });
const s = (id: string, position: number): TaskListSection => ({
  id,
  title: id,
  position,
  collapsed: false,
});
const row = (id: string, parent = ''): RowFx => ({ tile: { id }, parent });
const ids = (xs: string[]): RowDndItem[] => xs.map((id) => ({ id }));
const seq = (ps: TaskPlacement[]): string[] => ps.map((x) => x.tileId);

function dnd(items: RowDndItem[], draggedId: string): CustomEvent {
  return new CustomEvent('dnd', {
    detail: { items, info: { id: draggedId, source: 'pointer', trigger: 'drag' } },
  }) as unknown as CustomEvent;
}

function setup(opts: {
  rows: RowFx[];
  placements: TaskPlacement[];
  sections: TaskListSection[];
  visible: Record<string, string[]>;
  selected?: Set<string>;
}): { controller: TaskDragController; reorders: Reorder[]; toasts: string[] } {
  const reorders: Reorder[] = [];
  const toasts: string[] = [];
  const snapshot: SectionItemsSnapshot = {
    itemsBySection: Object.fromEntries(
      Object.entries(opts.visible).map(([k, v]) => [k, ids(v)]),
    ),
    displaySectionIds: Object.keys(opts.visible),
    leadingSectionId: '__lead',
  };
  const controller = new TaskDragController({
    getRows: () => opts.rows,
    getPlacements: () => opts.placements,
    getSections: () => opts.sections,
    getSelectedTaskIds: () => opts.selected ?? new Set(),
    getSnapshot: () => snapshot,
    commitIndent: () => {},
    commitOutdent: () => {},
    commitReorder: (args) => {
      reorders.push(args);
    },
    announce: () => {},
    toast: (msg) => {
      toasts.push(msg);
    },
  });
  controller.syncFromSnapshot();
  return { controller, reorders, toasts };
}

function drop(
  controller: TaskDragController,
  from: string,
  to: string,
  dragged: string,
  fromItems: string[],
  toItems: string[],
): void {
  controller.armRow(from, dragged, 0, 0);
  controller.onConsiderRows(from, dnd(ids(fromItems), dragged));
  if (from !== to) {
    controller.onConsiderRows(to, dnd(ids(toItems), dragged));
    controller.onFinalizeRows(to, dnd(ids(toItems), dragged));
    controller.onFinalizeRows(from, dnd(ids(fromItems), dragged));
  } else {
    controller.onFinalizeRows(to, dnd(ids(toItems), dragged));
  }
}

describe('Task List drag keeps hidden rows', () => {
  it('a sibling dragged past a collapsed parent keeps its subtasks', () => {
    const { controller, reorders } = setup({
      rows: [row('a'), row('a1', 'a'), row('a2', 'a'), row('b'), row('c')],
      placements: [p('a', 0), p('a1', 1), p('a2', 2), p('b', 3), p('c', 4)],
      sections: [s('S', 0)],
      visible: { S: ['a', 'b', 'c'] },
    });
    drop(controller, 'S', 'S', 'c', ['a', 'b', 'c'], ['c', 'a', 'b']);
    expect(reorders).toHaveLength(1);
    expect(seq(reorders[0]!.nextPlacements)).toEqual(['c', 'a', 'a1', 'a2', 'b']);
  });

  it('hidden completed tasks stay after the row they followed', () => {
    const { controller, reorders } = setup({
      rows: [row('a'), row('done'), row('b')],
      placements: [p('a', 0), p('done', 1), p('b', 2)],
      sections: [s('S', 0)],
      visible: { S: ['a', 'b'] },
    });
    drop(controller, 'S', 'S', 'b', ['a', 'b'], ['b', 'a']);
    expect(seq(reorders[0]!.nextPlacements)).toEqual(['b', 'a', 'done']);
  });

  it('rows outside a smart list at the top of a section stay at the top', () => {
    const { controller, reorders } = setup({
      rows: [row('x'), row('a'), row('y'), row('b')],
      placements: [p('x', 0), p('a', 1), p('y', 2), p('b', 3)],
      sections: [s('S', 0)],
      visible: { S: ['a', 'b'] },
    });
    drop(controller, 'S', 'S', 'b', ['a', 'b'], ['b', 'a']);
    expect(seq(reorders[0]!.nextPlacements)).toEqual(['x', 'b', 'a', 'y']);
  });

  it('a release in place commits nothing', () => {
    const { controller, reorders } = setup({
      rows: [row('a'), row('a1', 'a'), row('b')],
      placements: [p('a', 0), p('a1', 1), p('b', 2)],
      sections: [s('S', 0)],
      visible: { S: ['a', 'b'] },
    });
    drop(controller, 'S', 'S', 'b', ['a', 'b'], ['a', 'b']);
    expect(reorders).toHaveLength(0);
  });

  it('a cross-section move leaves hidden rows in their own section', () => {
    const { controller, reorders } = setup({
      rows: [row('a'), row('h'), row('b'), row('c'), row('h2')],
      placements: [p('a', 0), p('h', 1), p('b', 2), p('c', 3), p('h2', 4)],
      sections: [s('A', 0), s('B', 3)],
      visible: { A: ['a', 'b'], B: ['c'] },
    });
    drop(controller, 'A', 'B', 'b', ['a'], ['c', 'b']);
    expect(reorders).toHaveLength(1);
    const r = reorders[0]!;
    expect(seq(r.nextPlacements)).toEqual(['a', 'h', 'c', 'h2', 'b']);
    expect(r.nextSections.find((x) => x.id === 'B')?.position).toBe(2);
  });

  it('a multi-row drop lands next to the visible rows, not a hidden-row offset', () => {
    const { controller, reorders } = setup({
      rows: [row('h'), row('a'), row('b'), row('c')],
      placements: [p('h', 0), p('a', 1), p('b', 2), p('c', 3)],
      sections: [s('S', 0)],
      visible: { S: ['a', 'b', 'c'] },
      selected: new Set(['a', 'b']),
    });
    drop(controller, 'S', 'S', 'a', ['a', 'b', 'c'], ['c', 'a', 'b']);
    expect(seq(reorders[0]!.nextPlacements)).toEqual(['h', 'c', 'a', 'b']);
  });

  it('a collapsed parent dragged below a sibling takes its subtasks along', () => {
    const { controller, reorders } = setup({
      rows: [row('a'), row('a1', 'a'), row('b'), row('c')],
      placements: [p('a', 0), p('a1', 1), p('b', 2), p('c', 3)],
      sections: [s('S', 0)],
      visible: { S: ['a', 'b', 'c'] },
    });
    drop(controller, 'S', 'S', 'a', ['a', 'b', 'c'], ['b', 'a', 'c']);
    expect(seq(reorders[0]!.nextPlacements)).toEqual(['b', 'a', 'a1', 'c']);
  });
});

describe('sameTileIds', () => {
  it('refuses a result that drops or adds a tile', () => {
    const before = [p('a', 0), p('b', 1)];
    expect(sameTileIds(before, [p('b', 0), p('a', 1)])).toBe(true);
    expect(sameTileIds(before, [p('a', 0)])).toBe(false);
    expect(sameTileIds(before, [p('a', 0), p('b', 1), p('c', 2)])).toBe(false);
    expect(sameTileIds(before, [p('a', 0), p('c', 1)])).toBe(false);
  });
});

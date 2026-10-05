import { describe, it, expect } from 'vitest';
import {
  filterTaskRows,
  groupKey,
  statusFilterOptions,
  type TaskRow,
  type TaskFilterInputs,
} from '@renderer/lib/tasks/taskListModel';
import type { Tile, TaskPlacement } from '@renderer/schema/index';

/**
 * Phase 6 — pure filter coverage. The filter mirrors the transient UI state
 * held in TaskListBoard.svelte; extracting it to a pure function makes the
 * smart-list / chip / showCompleted combinations testable without the Svelte
 * runtime.
 */

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  const id = overrides.tile?.id ?? 'tile_a';
  const tile = {
    id,
    type: 'text',
    title: overrides.tile?.title ?? 'Task',
    position: { x: 0, y: 0 },
    size: { w: 100, h: 100 },
    style: {},
    locked: false,
    createdAt: overrides.tile?.createdAt ?? 0,
  } as unknown as Tile;
  const placement: TaskPlacement = {
    tileId: id,
    position: overrides.placement?.position ?? 0,
  };
  return {
    completed: false,
    priority: 'none',
    dueDate: '',
    dueTime: '',
    startDate: '',
    status: '',
    tags: [],
    parent: '',
    recurrence: '',
    recurrenceMode: 'schedule',
    category: '',
    ...overrides,
    tile: { ...tile, ...(overrides.tile ?? {}) },
    placement: { ...placement, ...(overrides.placement ?? {}) },
  };
}

const TODAY = new Date(2026, 4, 16);
TODAY.setHours(0, 0, 0, 0);

const BASE_INPUTS: TaskFilterInputs = {
  smartList: 'all',
  showCompleted: true,
  priority: null,
  status: null,
  tags: [],
};

describe('filterTaskRows — showCompleted toggle', () => {
  it('keeps completed rows when showCompleted=true (default)', () => {
    const rows = [makeRow({ tile: { id: 'a' } as Tile, completed: true })];
    expect(filterTaskRows(rows, TODAY, BASE_INPUTS)).toHaveLength(1);
  });

  it('hides completed rows when showCompleted=false', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, completed: true }),
      makeRow({ tile: { id: 'b' } as Tile, completed: false }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, showCompleted: false });
    expect(out.map((r) => r.tile.id)).toEqual(['b']);
  });

  it('"completed" smartList overrides showCompleted=false — completed rows visible', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, completed: true }),
      makeRow({ tile: { id: 'b' } as Tile, completed: false }),
    ];
    const out = filterTaskRows(rows, TODAY, {
      ...BASE_INPUTS,
      smartList: 'completed',
      showCompleted: false,
    });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });
});

describe('filterTaskRows — priority chip', () => {
  it('null priority — no filter applied', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, priority: 'urgent' }),
      makeRow({ tile: { id: 'b' } as Tile, priority: 'low' }),
    ];
    expect(filterTaskRows(rows, TODAY, BASE_INPUTS)).toHaveLength(2);
  });

  it('priority="urgent" keeps only urgent rows', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, priority: 'urgent' }),
      makeRow({ tile: { id: 'b' } as Tile, priority: 'low' }),
      makeRow({ tile: { id: 'c' } as Tile, priority: 'urgent' }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, priority: 'urgent' });
    expect(out.map((r) => r.tile.id).sort()).toEqual(['a', 'c']);
  });
});

describe('filterTaskRows — status chip', () => {
  it('null status — no filter applied', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, status: 'todo' }),
      makeRow({ tile: { id: 'b' } as Tile, status: 'blocked' }),
    ];
    expect(filterTaskRows(rows, TODAY, BASE_INPUTS)).toHaveLength(2);
  });

  it('status="todo" excludes other statuses', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, status: 'todo' }),
      makeRow({ tile: { id: 'b' } as Tile, status: 'done' }),
      makeRow({ tile: { id: 'c' } as Tile, status: 'todo' }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, status: 'todo' });
    expect(out.map((r) => r.tile.id).sort()).toEqual(['a', 'c']);
  });

  it('exact-match — custom statuses are not normalised', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, status: 'blocked' }),
      makeRow({ tile: { id: 'b' } as Tile, status: 'in-progress' }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, status: 'blocked' });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });
});

describe('Filter by Status agrees with Group by Status (E-15)', () => {
  // A task made in Filo has no `status:`; completing it writes `completed: true`.
  const fresh = makeRow({ tile: { id: 'fresh' } as Tile });
  const finished = makeRow({ tile: { id: 'finished' } as Tile, completed: true });
  const doing = makeRow({ tile: { id: 'doing' } as Tile, status: 'doing' });
  const blocked = makeRow({ tile: { id: 'blocked' } as Tile, status: 'blocked' });
  const rows = [fresh, finished, doing, blocked];
  const ids = (status: string): string[] =>
    filterTaskRows(rows, TODAY, { ...BASE_INPUTS, status }).map((r) => r.tile.id);

  it('the group calls them To Do and Done', () => {
    expect(groupKey(fresh, 'status', TODAY).key).toBe('todo');
    expect(groupKey(finished, 'status', TODAY).key).toBe('done');
  });

  it('"todo" shows the task with no status, "done" the completed one', () => {
    expect(ids('todo')).toEqual(['fresh']);
    expect(ids('done')).toEqual(['finished']);
  });

  it('"in-progress" shows a task written as doing, and an older view saved on "doing" still does', () => {
    expect(ids('in-progress')).toEqual(['doing']);
    expect(ids('doing')).toEqual(['doing']);
    expect(ids('blocked')).toEqual(['blocked']);
  });

  it('every row lands in exactly the bucket its group shows', () => {
    for (const r of rows) {
      const key = groupKey(r, 'status', TODAY).key;
      expect(ids(key), key).toContain(r.tile.id);
    }
  });

  it('the filter lists the statuses present, in the group order', () => {
    expect(statusFilterOptions(rows, null).map((o) => o.label)).toEqual(['To Do', 'In Progress', 'Done', 'Blocked']);
    expect(statusFilterOptions([fresh], null).map((o) => o.key)).toEqual(['todo']);
  });

  it('keeps the active status listed while no task is in it', () => {
    expect(statusFilterOptions([fresh], 'done').map((o) => o.key)).toEqual(['todo', 'done']);
    expect(statusFilterOptions([fresh], 'doing').map((o) => o.label)).toEqual(['To Do', 'In Progress']);
  });

  it('leaves out a task whose fields have not been read yet', () => {
    expect(statusFilterOptions([makeRow({ fieldsPending: true, completed: true })], null)).toEqual([]);
  });
});

describe('filterTaskRows — tag chip (intersection)', () => {
  it('empty tags input — no filter applied', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, tags: ['work'] }),
      makeRow({ tile: { id: 'b' } as Tile }),
    ];
    expect(filterTaskRows(rows, TODAY, BASE_INPUTS)).toHaveLength(2);
  });

  it('single tag — every selected tag must appear on the row', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, tags: ['work'] }),
      makeRow({ tile: { id: 'b' } as Tile, tags: ['errand'] }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, tags: ['work'] });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });

  it('multiple tags — intersection (row must have ALL of them)', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, tags: ['work', 'urgent'] }),
      makeRow({ tile: { id: 'b' } as Tile, tags: ['work'] }),
      makeRow({ tile: { id: 'c' } as Tile, tags: ['urgent'] }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, tags: ['work', 'urgent'] });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });

  it('strips leading # from tag inputs', () => {
    const rows = [makeRow({ tile: { id: 'a' } as Tile, tags: ['work'] })];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, tags: ['#work'] });
    expect(out).toHaveLength(1);
  });
});

describe('filterTaskRows — smart list bucket', () => {
  it('"today" — keeps rows due today, excludes deferred + completed', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, dueDate: '2026-05-16' }),
      makeRow({ tile: { id: 'b' } as Tile, dueDate: '2026-05-17' }),
      makeRow({ tile: { id: 'c' } as Tile, dueDate: '2026-05-16', completed: true }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, smartList: 'today' });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });

  it('"no-date" — keeps rows without dueDate', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile }),
      makeRow({ tile: { id: 'b' } as Tile, dueDate: '2026-05-17' }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, smartList: 'no-date' });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });

  it('"overdue" — past dueDate, not completed', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, dueDate: '2026-05-10' }),
      makeRow({ tile: { id: 'b' } as Tile, dueDate: '2026-05-10', completed: true }),
      makeRow({ tile: { id: 'c' } as Tile, dueDate: '2026-05-17' }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, smartList: 'overdue' });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });

  it('"upcoming" — strictly future, not completed/deferred', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, dueDate: '2026-05-17' }),
      makeRow({ tile: { id: 'b' } as Tile, dueDate: '2026-05-16' }), // today, not future
      makeRow({ tile: { id: 'c' } as Tile, dueDate: '2026-06-01', startDate: '2026-07-01' }),
    ];
    const out = filterTaskRows(rows, TODAY, { ...BASE_INPUTS, smartList: 'upcoming' });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });

  it('"all" with showCompleted=false — keeps completed rows out', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, completed: true }),
      makeRow({ tile: { id: 'b' } as Tile, completed: false }),
    ];
    const out = filterTaskRows(rows, TODAY, {
      ...BASE_INPUTS,
      smartList: 'all',
      showCompleted: false,
    });
    expect(out.map((r) => r.tile.id)).toEqual(['b']);
  });
});

describe('filterTaskRows — combined filters', () => {
  it('priority + tag intersection', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, priority: 'urgent', tags: ['work'] }),
      makeRow({ tile: { id: 'b' } as Tile, priority: 'urgent', tags: ['errand'] }),
      makeRow({ tile: { id: 'c' } as Tile, priority: 'low', tags: ['work'] }),
    ];
    const out = filterTaskRows(rows, TODAY, {
      ...BASE_INPUTS,
      priority: 'urgent',
      tags: ['work'],
    });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });

  it('smartList + tag + hide-completed — all narrow simultaneously', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile, dueDate: '2026-05-16', tags: ['work'] }),
      makeRow({ tile: { id: 'b' } as Tile, dueDate: '2026-05-16', tags: ['work'], completed: true }),
      makeRow({ tile: { id: 'c' } as Tile, dueDate: '2026-05-16', tags: ['errand'] }),
      makeRow({ tile: { id: 'd' } as Tile, dueDate: '2026-05-20', tags: ['work'] }),
    ];
    const out = filterTaskRows(rows, TODAY, {
      smartList: 'today',
      showCompleted: false,
      priority: null,
      status: null,
      tags: ['work'],
    });
    expect(out.map((r) => r.tile.id)).toEqual(['a']);
  });
});

describe('filterTaskRows — purity', () => {
  it('never mutates the input array', () => {
    const rows = [
      makeRow({ tile: { id: 'a' } as Tile }),
      makeRow({ tile: { id: 'b' } as Tile, completed: true }),
    ];
    const snapshot = rows.map((r) => r.tile.id);
    filterTaskRows(rows, TODAY, { ...BASE_INPUTS, showCompleted: false });
    expect(rows.map((r) => r.tile.id)).toEqual(snapshot);
  });

  it('returns a fresh array (not the input)', () => {
    const rows = [makeRow({ tile: { id: 'a' } as Tile })];
    const out = filterTaskRows(rows, TODAY, BASE_INPUTS);
    expect(out).not.toBe(rows);
    expect(out).toEqual(rows);
  });
});

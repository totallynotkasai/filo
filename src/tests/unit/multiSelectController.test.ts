import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SvelteSet } from 'svelte/reactivity';
import {
  MultiSelectController,
  type MultiSelectControllerDeps,
} from '@renderer/lib/tasklist/multiSelectController.svelte';
import { completionPatchForRow } from '@renderer/lib/tasklist/frontmatterWriter';
import { historyStore } from '@renderer/stores/history.svelte';
import { Command } from '@renderer/commands/Command';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import type { Tile, TaskListBoard } from '@renderer/schema/index';

/** Minimal real Command for touched>0 bulk-op tests (historyStore.execute is mocked). */
class NoopCommand extends Command {
  description = 'noop';
  readonly targetBoardId = 'b';
  execute(): void {}
  undo(): void {}
}

/** Base deps for a controller over `rows`; override per test. */
function baseDeps(rows: TaskRow[]): MultiSelectControllerDeps {
  return {
    getBoard: () => ({ id: 'b' } as unknown as TaskListBoard),
    getRows: () => rows,
    getRenderedRows: () => rows,
    getPlacements: () => [],
    getSections: () => [],
    buildTaskFieldCommand: () => null,
    bumpCacheVersion: () => {},
    tickAndPersist: () => {},
    announce: () => {},
  };
}

/** Row whose backing tile names its note by `filePath`. */
function rowWithNote(id: string, filePath: string): TaskRow {
  return mkRow({ id, tile: { id, type: 'text', title: id, filePath } as unknown as Tile });
}

/**
 * The bulk "Mark complete" path used to stamp `{ completed: true }` on every
 * selected row with NO recurrence branch, permanently completing repeating
 * tasks (they never recur again). The single-row `toggleCompleted` rolls
 * recurring tasks forward instead. Both now share `completionPatchForRow` so
 * they can't diverge again.
 *
 * The multi-select controller had no tests before this file.
 */

function installFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function mkRow(over: Partial<TaskRow> & { id: string }): TaskRow {
  const { id, ...rest } = over;
  return {
    placement: { tileId: id, position: 0 },
    tile: { id, type: 'text', title: id } as unknown as Tile,
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
    ...rest,
  } as TaskRow;
}

describe('completionPatchForRow (shared helper)', () => {
  const NOW = new Date(2026, 4, 15, 12, 0); // 2026-05-15 (Friday)

  it('marks a non-recurring row complete', () => {
    expect(completionPatchForRow(mkRow({ id: 't' }), NOW)).toEqual({ completed: true });
  });

  it('rolls a completion-mode recurring task forward (completedOn + interval)', () => {
    const r = mkRow({
      id: 't',
      recurrence: 'weekly',
      recurrenceMode: 'completion',
      dueDate: '2026-05-10',
    });
    // completion mode ignores the old due: next = 2026-05-15 + 1 week.
    expect(completionPatchForRow(r, NOW)).toEqual({ completed: false, dueDate: '2026-05-22' });
  });

  it('rolls a schedule-mode recurring task forward from its due date', () => {
    const r = mkRow({
      id: 't',
      recurrence: 'weekly',
      recurrenceMode: 'schedule',
      dueDate: '2026-05-13',
    });
    // schedule: step 2026-05-13 by 1 week until strictly after today → 2026-05-20.
    expect(completionPatchForRow(r, NOW)).toEqual({ completed: false, dueDate: '2026-05-20' });
  });

  it('falls back to plain completion when the recurrence string is unparseable', () => {
    const r = mkRow({ id: 't', recurrence: 'gibberish', dueDate: '2026-05-10' });
    expect(completionPatchForRow(r, NOW)).toEqual({ completed: true });
  });

  it('rolls an undated schedule-mode repeat forward from the completion day', () => {
    // schedule mode with no anchor date → nextDueDate(schedule) returns null.
    // Rather than silently terminating the recurrence (the old behavior —
    // a plain { completed: true }), seed the next due from the completion day
    // (completion-mode semantics). NOW = Fri 2026-05-15 → +1 week = 2026-05-22.
    const r = mkRow({ id: 't', recurrence: 'weekly', recurrenceMode: 'schedule', dueDate: '' });
    expect(completionPatchForRow(r, NOW)).toEqual({ completed: false, dueDate: '2026-05-22' });
  });

  it('still falls back to plain completion when BOTH modes return null (unparseable)', () => {
    const r = mkRow({ id: 't', recurrence: 'nonsense', recurrenceMode: 'schedule', dueDate: '' });
    expect(completionPatchForRow(r, NOW)).toEqual({ completed: true });
  });
});

describe('MultiSelectController.bulkMarkComplete (wiring)', () => {
  beforeEach(() => installFiloStub());

  it('routes recurring rows through roll-forward and plain rows through complete', () => {
    const recurring = mkRow({
      id: 'rec',
      recurrence: 'weekly',
      recurrenceMode: 'schedule',
      dueDate: '2030-01-01', // far future → schedule-step is now-independent
    });
    const plain = mkRow({ id: 'plain' });
    const alreadyDone = mkRow({ id: 'done', completed: true });
    const rows = [recurring, plain, alreadyDone];

    const captured: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const deps: MultiSelectControllerDeps = {
      getBoard: () => ({ id: 'b' } as unknown as TaskListBoard),
      getRows: () => rows,
      getRenderedRows: () => rows,
      getPlacements: () => [],
      getSections: () => [],
      // Capture the per-row patch and return null so bulkApplyFieldPatch
      // short-circuits before touching historyStore.
      buildTaskFieldCommand: (row, patch) => {
        captured.push({ id: row.tile.id, patch });
        return null;
      },
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
      announce: () => {},
    };
    const controller = new MultiSelectController(deps);
    controller.selectedTaskIds = new SvelteSet(['rec', 'plain', 'done']);

    controller.bulkMarkComplete();

    // Already-complete 'done' is skipped; only 'rec' + 'plain' produce a patch.
    expect(captured.map((c) => c.id)).toEqual(['rec', 'plain']);
    const recPatch = captured.find((c) => c.id === 'rec')?.patch;
    expect(recPatch?.completed).toBe(false);
    expect(recPatch?.dueDate).toBe('2030-01-08'); // 2030-01-01 + 1 week
    expect(captured.find((c) => c.id === 'plain')?.patch).toEqual({ completed: true });
  });
});

describe('MultiSelectController — selection cleared after non-delete bulk ops', () => {
  beforeEach(() => installFiloStub());
  // historyStore.execute is mocked, so nothing lands on the undo stack; restore
  // after each test so the spy doesn't leak.
  afterEach(() => vi.restoreAllMocks());

  function depsWithCmd(rows: TaskRow[]): MultiSelectControllerDeps {
    return {
      ...baseDeps(rows),
      // Return a real (no-op) Command so `touched > 0` and the clear fires.
      buildTaskFieldCommand: (() =>
        new NoopCommand()) as unknown as MultiSelectControllerDeps['buildTaskFieldCommand'],
    };
  }

  it('bulkSetPriority clears the selection once rows are touched', () => {
    vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const rows = [mkRow({ id: 'a' }), mkRow({ id: 'b' })];
    const c = new MultiSelectController(depsWithCmd(rows));
    c.selectedTaskIds = new SvelteSet(['a', 'b']);
    c.bulkSetPriority('high');
    expect(c.selectedTaskIds.size).toBe(0);
    expect(c.lastSelectedTaskId).toBeNull();
  });

  it('bulkMarkComplete clears the selection (hide-completed safety)', () => {
    vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const rows = [mkRow({ id: 'a' }), mkRow({ id: 'b' })];
    const c = new MultiSelectController(depsWithCmd(rows));
    c.selectedTaskIds = new SvelteSet(['a', 'b']);
    c.bulkMarkComplete();
    expect(c.selectedTaskIds.size).toBe(0);
  });

  it('a no-op bulk op (nothing touched) leaves the selection intact', () => {
    // buildTaskFieldCommand returns null → touched 0 → no clear (user can retry).
    const rows = [mkRow({ id: 'a' })];
    const c = new MultiSelectController(baseDeps(rows));
    c.selectedTaskIds = new SvelteSet(['a']);
    c.bulkSetPriority('low');
    expect(c.selectedTaskIds.size).toBe(1);
  });
});

describe('MultiSelectController.pruneSelection', () => {
  it('drops removed ids and clears the anchor when it was pruned', () => {
    const c = new MultiSelectController(baseDeps([]));
    c.selectedTaskIds = new SvelteSet(['a', 'b', 'c']);
    c.lastSelectedTaskId = 'b';
    c.pruneSelection(['b']);
    expect([...c.selectedTaskIds].sort()).toEqual(['a', 'c']);
    expect(c.lastSelectedTaskId).toBeNull();
  });

  it('keeps the anchor when it was not removed', () => {
    const c = new MultiSelectController(baseDeps([]));
    c.selectedTaskIds = new SvelteSet(['a', 'b']);
    c.lastSelectedTaskId = 'a';
    c.pruneSelection(['b']);
    expect([...c.selectedTaskIds]).toEqual(['a']);
    expect(c.lastSelectedTaskId).toBe('a');
  });

  it('is a no-op when no selected id matches', () => {
    const c = new MultiSelectController(baseDeps([]));
    c.selectedTaskIds = new SvelteSet(['a']);
    c.pruneSelection(['x']);
    expect([...c.selectedTaskIds]).toEqual(['a']);
  });
});

describe('MultiSelectController.handleRowSelect — shift-click with a lost anchor', () => {
  it('extends the selection instead of collapsing when the anchor is gone', () => {
    // Visible rows are a, b, c; the anchor 'z' was filtered away or deleted.
    const rows = [mkRow({ id: 'a' }), mkRow({ id: 'b' }), mkRow({ id: 'c' })];
    const c = new MultiSelectController(baseDeps(rows));
    c.selectedTaskIds = new SvelteSet(['a']);
    c.lastSelectedTaskId = 'z'; // not in the filtered rows
    c.handleRowSelect('c', { shift: true, ctrl: false });
    // Previously this collapsed to just {c}; now it keeps 'a', adds 'c', re-anchors.
    expect([...c.selectedTaskIds].sort()).toEqual(['a', 'c']);
    expect(c.lastSelectedTaskId).toBe('c');
  });
});

describe('MultiSelectController.bulkApplyFieldPatch — dedups rows sharing a backing file', () => {
  beforeEach(() => installFiloStub());

  it('builds ONE command for two selected rows backed by the same note path', () => {
    const rows = [rowWithNote('a', 'Shared.md'), rowWithNote('b', 'Shared.md')];
    const seen: string[] = [];
    const deps: MultiSelectControllerDeps = {
      ...baseDeps(rows),
      buildTaskFieldCommand: (row) => {
        seen.push(row.tile.id);
        return null;
      },
    };
    const c = new MultiSelectController(deps);
    c.selectedTaskIds = new SvelteSet(['a', 'b']);
    c.bulkSetPriority('high');
    // Both rows resolve to the same note → only the first reaches the builder.
    expect(seen).toEqual(['a']);
  });

  it('keeps rows with distinct note paths separate', () => {
    const rows = [rowWithNote('a', 'A.md'), rowWithNote('b', 'B.md')];
    const seen: string[] = [];
    const deps: MultiSelectControllerDeps = {
      ...baseDeps(rows),
      buildTaskFieldCommand: (row) => {
        seen.push(row.tile.id);
        return null;
      },
    };
    const c = new MultiSelectController(deps);
    c.selectedTaskIds = new SvelteSet(['a', 'b']);
    c.bulkSetPriority('high');
    expect(seen).toEqual(['a', 'b']);
  });

  it('does not dedup orphan rows that have no filePath', () => {
    const rows = [mkRow({ id: 'a' }), mkRow({ id: 'b' })]; // no filePath on either
    const seen: string[] = [];
    const deps: MultiSelectControllerDeps = {
      ...baseDeps(rows),
      buildTaskFieldCommand: (row) => {
        seen.push(row.tile.id);
        return null;
      },
    };
    const c = new MultiSelectController(deps);
    c.selectedTaskIds = new SvelteSet(['a', 'b']);
    c.bulkSetPriority('high');
    expect(seen).toEqual(['a', 'b']);
  });
});

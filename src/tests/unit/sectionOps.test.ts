/**
 * Unit coverage for the Task List section slice (`lib/tasklist/sectionOps.ts`).
 * The stores and structural Commands are stubbed so each test pins exactly
 * which snapshot a section op hands to history — the Commands themselves
 * have their own round-trip suites.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskListSection, TaskPlacement } from '@renderer/schema/index';

const h = vi.hoisted(() => ({
  persistTaskListStructure: vi.fn(),
  execute: vi.fn(),
  cache: {} as Record<string, { tileDefs?: Record<string, unknown> }>,
  idCounter: 0,
}));

vi.mock('@renderer/stores/boardCache.svelte', () => ({
  boardCacheStore: {
    persistTaskListStructure: h.persistTaskListStructure,
    get cache() {
      return h.cache;
    },
  },
}));
vi.mock('@renderer/stores/history.svelte', () => ({
  historyStore: { execute: h.execute },
}));
vi.mock('@renderer/lib/utils/ids', () => ({
  createId: () => `id${++h.idCounter}`,
}));
vi.mock('@renderer/commands/index', () => {
  class Cmd {
    args: unknown[];
    constructor(...args: unknown[]) {
      this.args = args;
    }
  }
  return {
    AddSectionCommand: class AddSectionCommand extends Cmd {},
    DeleteSectionCommand: class DeleteSectionCommand extends Cmd {},
    RenameSectionCommand: class RenameSectionCommand extends Cmd {},
    ReorderSectionCommand: class ReorderSectionCommand extends Cmd {},
  };
});

import { makeSectionOps, type SectionOpsDeps } from '@renderer/lib/tasklist/sectionOps';

const DEFAULT_ID = '__default__';

function task(tileId: string): TaskPlacement {
  return { tileId } as TaskPlacement;
}

function section(id: string, position: number, extra: Partial<TaskListSection> = {}): TaskListSection {
  return { id, title: id.toUpperCase(), position, collapsed: false, ...extra };
}

interface Harness {
  deps: SectionOpsDeps;
  tick: ReturnType<typeof vi.fn>;
  state: { board: { id: string } | null; sections: TaskListSection[]; tasks: TaskPlacement[] };
}

function harness(sections: TaskListSection[] = [], tasks: TaskPlacement[] = []): Harness {
  const state = { board: { id: 'b1' } as { id: string } | null, sections, tasks };
  const tick = vi.fn();
  const deps: SectionOpsDeps = {
    getBoard: () => state.board as never,
    getSections: () => state.sections,
    getPlacements: () => state.tasks,
    tickAndPersist: tick,
    snapshotSections: () => ({ sections: state.sections.map((s) => ({ ...s })), tasks: [...state.tasks] }),
    defaultSectionId: DEFAULT_ID,
  };
  return { deps, tick, state };
}

/** Last Command handed to historyStore.execute, as [className, args]. */
function lastCommand(): [string, unknown[]] {
  const cmd = h.execute.mock.calls.at(-1)?.[0] as { constructor: { name: string }; args: unknown[] };
  return [cmd.constructor.name, cmd.args];
}

beforeEach(() => {
  h.persistTaskListStructure.mockReset();
  h.execute.mockReset();
  h.cache = {};
  h.idCounter = 0;
});

describe('no-board guard', () => {
  it('every op is a no-op when there is no board', () => {
    const { deps, tick, state } = harness([section('a', 0)], [task('t1')]);
    state.board = null;
    const ops = makeSectionOps(deps);
    ops.persistSections([]);
    expect(ops.ensureDefaultSectionMaterialized()).toBeNull();
    ops.addSection();
    ops.renameSection('a', 'x');
    ops.deleteSection('a', 'keep-tasks');
    ops.moveSection('a', 1);
    expect(h.persistTaskListStructure).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });
});

describe('persistSections', () => {
  it('writes through the cache and ticks', () => {
    const { deps, tick } = harness();
    const next = [section('a', 0)];
    const tasks = [task('t1')];
    makeSectionOps(deps).persistSections(next, tasks);
    expect(h.persistTaskListStructure).toHaveBeenCalledWith('b1', next, tasks);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe('ensureDefaultSectionMaterialized', () => {
  it('materialises a real default section when none exist', () => {
    const { deps } = harness();
    const id = makeSectionOps(deps).ensureDefaultSectionMaterialized('Inbox');
    expect(id).toBe('sec_id1');
    expect(h.persistTaskListStructure).toHaveBeenCalledWith(
      'b1',
      [{ id: 'sec_id1', title: 'Inbox', position: 0, collapsed: false }],
      undefined,
    );
  });

  it('uses the default title when none is given', () => {
    const { deps } = harness();
    makeSectionOps(deps).ensureDefaultSectionMaterialized();
    expect(h.persistTaskListStructure.mock.calls[0]?.[1]?.[0]?.title).toBe('Task List');
  });

  it('is a no-op when a real section already exists', () => {
    const { deps } = harness([section('a', 0)]);
    expect(makeSectionOps(deps).ensureDefaultSectionMaterialized()).toBeNull();
    expect(h.persistTaskListStructure).not.toHaveBeenCalled();
  });
});

describe('addSection', () => {
  it('on a section-less board folds an auto default into the command', () => {
    const { deps, tick } = harness([], [task('t1'), task('t2')]);
    makeSectionOps(deps).addSection('Later');
    const [name, args] = lastCommand();
    expect(name).toBe('AddSectionCommand');
    const [boardId, before, after, title, autoDefault] = args as [
      string,
      { sections: TaskListSection[] },
      { sections: TaskListSection[] },
      string,
      TaskListSection | null,
    ];
    expect(boardId).toBe('b1');
    expect(before.sections).toEqual([]);
    expect(autoDefault).toEqual({ id: 'sec_id1', title: 'Task List', position: 0, collapsed: false });
    expect(after.sections).toEqual([
      autoDefault,
      { id: 'sec_id2', title: 'Later', position: 2, collapsed: false },
    ]);
    expect(title).toBe('Later');
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('appends after existing sections with no auto default and the default title', () => {
    const { deps } = harness([section('a', 0)], [task('t1')]);
    makeSectionOps(deps).addSection();
    const [, args] = lastCommand();
    const after = args[2] as { sections: TaskListSection[] };
    expect(args[4]).toBeNull();
    expect(after.sections.map((s) => [s.id, s.title, s.position])).toEqual([
      ['a', 'A', 0],
      ['sec_id1', 'New Section', 1],
    ]);
  });
});

describe('renameSection', () => {
  it('renaming the virtual default materialises it with the new title (no command)', () => {
    const { deps } = harness();
    makeSectionOps(deps).renameSection(DEFAULT_ID, 'Inbox');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.persistTaskListStructure.mock.calls[0]?.[1]?.[0]?.title).toBe('Inbox');
  });

  it('dispatches a RenameSectionCommand for a real section', () => {
    const sections = [section('a', 0)];
    const { deps, tick } = harness(sections);
    makeSectionOps(deps).renameSection('a', 'Renamed');
    const [name, args] = lastCommand();
    expect(name).toBe('RenameSectionCommand');
    expect(args).toEqual(['b1', 'a', 'A', 'Renamed', sections]);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown ids and unchanged titles', () => {
    const { deps } = harness([section('a', 0)]);
    const ops = makeSectionOps(deps);
    ops.renameSection('missing', 'x');
    ops.renameSection('a', 'A');
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe('toggleSectionCollapsed', () => {
  it('flips a real section without a command', () => {
    const { deps } = harness([section('a', 0), section('b', 1)]);
    makeSectionOps(deps).toggleSectionCollapsed('b');
    expect(h.execute).not.toHaveBeenCalled();
    const next = h.persistTaskListStructure.mock.calls[0]?.[1] as TaskListSection[];
    expect(next.map((s) => s.collapsed)).toEqual([false, true]);
  });

  it('materialises then collapses the virtual default', () => {
    const { deps, state } = harness();
    // The materialise write lands in the cache; reflect it in the live read.
    h.persistTaskListStructure.mockImplementation((_id: string, next: TaskListSection[]) => {
      state.sections = next;
    });
    makeSectionOps(deps).toggleSectionCollapsed(DEFAULT_ID);
    expect(h.persistTaskListStructure).toHaveBeenCalledTimes(2);
    expect(state.sections).toEqual([{ id: 'sec_id1', title: 'Task List', position: 0, collapsed: true }]);
  });

  it('does nothing for the virtual default when a real section already exists', () => {
    const { deps } = harness([section('a', 0)]);
    makeSectionOps(deps).toggleSectionCollapsed(DEFAULT_ID);
    expect(h.persistTaskListStructure).not.toHaveBeenCalled();
  });
});

describe('deleteSection', () => {
  const tasks = (): TaskPlacement[] => [task('t1'), task('t2'), task('t3'), task('t4')];
  // a owns [0,1), b owns [1,3), c owns [3,4)
  const sections = (): TaskListSection[] => [section('c', 3), section('a', 0), section('b', 1)];

  it('ignores the virtual default and unknown ids', () => {
    const { deps } = harness(sections(), tasks());
    const ops = makeSectionOps(deps);
    ops.deleteSection(DEFAULT_ID, 'keep-tasks');
    ops.deleteSection('missing', 'keep-tasks');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('keep-tasks drops only the section marker', () => {
    h.cache = { b1: { tileDefs: { t1: {}, t2: {} } } };
    const { deps, tick } = harness(sections(), tasks());
    makeSectionOps(deps).deleteSection('b', 'keep-tasks');
    const [name, args] = lastCommand();
    expect(name).toBe('DeleteSectionCommand');
    const after = args[2] as { sections: TaskListSection[]; tasks: TaskPlacement[]; defs: Record<string, unknown> };
    expect(after.sections.map((s) => s.id)).toEqual(['a', 'c']);
    expect(after.tasks.map((t) => t.tileId)).toEqual(['t1', 't2', 't3', 't4']);
    expect(Object.keys(after.defs)).toEqual(['t1', 't2']);
    expect(args[3]).toBe('B');
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('delete-tasks removes the section range, its defs, and shifts later sections', () => {
    h.cache = { b1: { tileDefs: { t1: {}, t2: {}, t3: {}, t4: {} } } };
    const { deps } = harness(sections(), tasks());
    makeSectionOps(deps).deleteSection('b', 'delete-tasks');
    const after = lastCommand()[1][2] as {
      sections: TaskListSection[];
      tasks: TaskPlacement[];
      defs: Record<string, unknown>;
    };
    expect(after.tasks.map((t) => t.tileId)).toEqual(['t1', 't4']);
    expect(after.sections.map((s) => [s.id, s.position])).toEqual([
      ['a', 0],
      ['c', 1],
    ]);
    expect(Object.keys(after.defs).sort()).toEqual(['t1', 't4']);
  });

  it('delete-tasks on the last section runs to the end of the task list (no cache entry)', () => {
    const { deps } = harness(sections(), tasks());
    makeSectionOps(deps).deleteSection('c', 'delete-tasks');
    const after = lastCommand()[1][2] as { sections: TaskListSection[]; tasks: TaskPlacement[] };
    expect(after.tasks.map((t) => t.tileId)).toEqual(['t1', 't2', 't3']);
    expect(after.sections.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('moveSection', () => {
  const tasks = (): TaskPlacement[] => [task('t1'), task('t2'), task('t3'), task('t4')];
  const sections = (): TaskListSection[] => [section('a', 0), section('b', 1), section('c', 3)];

  function afterOf(): { sections: TaskListSection[]; tasks: TaskPlacement[] } {
    const [name, args] = lastCommand();
    expect(name).toBe('ReorderSectionCommand');
    return args[2] as { sections: TaskListSection[]; tasks: TaskPlacement[] };
  }

  it('moves a section down, swapping its task slice with the next one', () => {
    const { deps, tick } = harness(sections(), tasks());
    makeSectionOps(deps).moveSection('a', 1);
    const after = afterOf();
    expect(after.tasks.map((t) => t.tileId)).toEqual(['t2', 't3', 't1', 't4']);
    expect(after.sections.map((s) => [s.id, s.position])).toEqual([
      ['a', 2],
      ['b', 0],
      ['c', 3],
    ]);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('moves the last section up, swapping with the previous one', () => {
    const { deps } = harness(sections(), tasks());
    makeSectionOps(deps).moveSection('c', -1);
    const after = afterOf();
    expect(after.tasks.map((t) => t.tileId)).toEqual(['t1', 't4', 't2', 't3']);
    expect(after.sections.map((s) => [s.id, s.position])).toEqual([
      ['a', 0],
      ['b', 2],
      ['c', 1],
    ]);
  });

  it('ignores the virtual default, unknown ids, and out-of-range moves', () => {
    const { deps } = harness(sections(), tasks());
    const ops = makeSectionOps(deps);
    ops.moveSection(DEFAULT_ID, 1);
    ops.moveSection('missing', 1);
    ops.moveSection('a', -1);
    ops.moveSection('c', 1);
    expect(h.execute).not.toHaveBeenCalled();
  });
});

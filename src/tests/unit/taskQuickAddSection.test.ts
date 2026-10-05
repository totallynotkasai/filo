import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTaskCreator, type TaskCreationDeps } from '@renderer/lib/tasklist/taskCreation';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { TaskListBoard, TaskListSection, TaskPlacement } from '@renderer/schema/index';

/**
 * Quick add files a task where Add Task does (E-02): the section last added
 * to, else the first one. It used to append to the end of the list, so with
 * sections "To do" and "Done" (folded) a quick-added task vanished into Done.
 */

afterEach(() => vi.restoreAllMocks());

interface Setup {
  sections: TaskListSection[];
  lastTargeted?: string | null;
  shown?: boolean;
}

function setup(opts: Setup) {
  const placements = ['t1', 't2', 't3', 't4'].map((tileId, i) => ({ tileId, position: i }) as unknown as TaskPlacement);
  const board = { id: 'b', type: 'tasklist', name: 'B', settings: {}, tasks: placements, sections: opts.sections } as unknown as TaskListBoard;
  const order: string[] = [];
  const executed: Array<{ position: number; targetSectionId?: string }> = [];
  vi.spyOn(historyStore, 'execute').mockImplementation((cmd) => {
    order.push('add');
    executed.push(cmd as never);
    return Promise.resolve();
  });
  const toast = vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
  let last: string | null = opts.lastTargeted ?? null;
  const deps: TaskCreationDeps = {
    getBoard: () => board,
    getSections: () => opts.sections,
    getPlacements: () => placements,
    getRows: () => [],
    getCollapsedSubtasks: () => new Set(),
    getLastTargetedSectionId: () => last,
    setLastTargetedSectionId: (next) => { last = next; },
    ensureDefaultSectionMaterialized: () => null,
    persistCollapsedSubtasks: () => {},
    tickAndPersist: () => {},
    announce: () => {},
    defaultSectionId: '__default__',
    expandSection: (id) => order.push(`expand ${id}`),
    isShown: () => opts.shown ?? true,
  };
  return { creator: makeTaskCreator(deps), executed, order, toast, lastTargeted: () => last };
}

const TODO_DONE = (): TaskListSection[] => [
  { id: 'todo', title: 'To do', position: 0, collapsed: false },
  { id: 'done', title: 'Done', position: 2, collapsed: true },
];

describe('quick add: which section the task lands in (E-02)', () => {
  it('lands at the end of the first section, not in the folded last one', async () => {
    const { creator, executed } = setup({ sections: TODO_DONE() });
    await creator.addTaskFromQuickAdd({ title: 'Outline chapter 3', tags: [] });
    expect(executed[0]).toMatchObject({ position: 2, targetSectionId: 'todo' });
  });

  it('follows the section last added to, as Add Task does', async () => {
    const sections: TaskListSection[] = [
      { id: 'todo', title: 'To do', position: 0, collapsed: false },
      { id: 'later', title: 'Later', position: 2, collapsed: false },
      { id: 'done', title: 'Done', position: 3, collapsed: false },
    ];
    const { creator, executed } = setup({ sections, lastTargeted: 'later' });
    await creator.addTaskFromQuickAdd({ title: 'x', tags: [] });
    expect(executed[0]).toMatchObject({ position: 3, targetSectionId: 'later' });
  });

  it('opens a folded target section first, so the task shows (an undo step undone after the add)', async () => {
    const { creator, order, lastTargeted } = setup({ sections: TODO_DONE(), lastTargeted: 'done' });
    await creator.addTaskFromQuickAdd({ title: 'x', tags: [] });
    expect(order).toEqual(['expand done', 'add']);
    expect(lastTargeted()).toBe('done');
  });

  it('leaves an open section as it is', async () => {
    const { creator, order } = setup({ sections: TODO_DONE() });
    await creator.addTaskFromQuickAdd({ title: 'x', tags: [] });
    expect(order).toEqual(['add']);
  });

  it('says where the task went when a filter hides it', async () => {
    const { creator, toast } = setup({ sections: TODO_DONE(), shown: false });
    await creator.addTaskFromQuickAdd({ title: 'Buy ink', tags: [] });
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/was added to "To do", but the filters hide it/), 'info', 4000);
  });

  it('says nothing when the task shows', async () => {
    const { creator, toast } = setup({ sections: TODO_DONE() });
    await creator.addTaskFromQuickAdd({ title: 'Buy ink', tags: [] });
    expect(toast).not.toHaveBeenCalled();
  });
});

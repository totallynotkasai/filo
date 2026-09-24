/**
 * Undo of a Task List bulk delete restores the exact order and section
 * membership.
 *
 * Each DeleteTaskCommand snapshots its placement position and the section
 * slices when it is constructed, and BatchCommand undoes children in reverse.
 * Absolute-index replay is only exact when the batch runs in DESCENDING
 * position order: then undo re-inserts the lowest position first. Built in
 * row order (ascending), undo re-inserted C before B and the section replay
 * then cut across the misordered array: A,B,C | D,E → S1=[A,B,D], S2=[C,E].
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore, type Command } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import { MultiSelectController } from '@renderer/lib/tasklist/multiSelectController.svelte';
import { makeTaskDeleter, orderForBatchDelete } from '@renderer/lib/tasklist/taskDeletion';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import type {
  TaskListBoard,
  TaskListSection,
  TaskPlacement,
  Tile,
  TileDefinition,
} from '@renderer/schema/index';

const IDS = ['A', 'B', 'C', 'D', 'E'];

function mkDef(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    title: id,
    filePath: `Tasks/${id}.md`,
    content: '',
    style: { headerColor: '#000', bodyColor: '#fff', borderColor: '' },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function hydrate(): void {
  const fixture: V7BoardFileData = {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'T',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      tasks: IDS.map((tileId, position) => ({ tileId, position })),
      sections: [
        { id: 'S1', title: 'One', position: 0, collapsed: false },
        { id: 'S2', title: 'Two', position: 3, collapsed: false },
      ],
      collapsedSubtasks: [],
    } as unknown as TaskListBoard,
    tileDefs: Object.fromEntries(IDS.map((id) => [id, mkDef(id)])),
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ tl: fixture }, { tl: 'T.board.json' });
}

function board(): TaskListBoard {
  return boardCacheStore.cache.tl?.board as TaskListBoard;
}

interface Layout {
  tasks: string[];
  sections: { id: string; position: number }[];
}

function layout(): Layout {
  const b = board();
  return {
    tasks: ((b.tasks ?? []) as TaskPlacement[])
      .slice()
      .sort((x, y) => x.position - y.position)
      .map((p) => p.tileId),
    sections: ((b.sections ?? []) as TaskListSection[]).map((s) => ({ id: s.id, position: s.position })),
  };
}

function rows(completed: string[] = []): TaskRow[] {
  return ((board().tasks ?? []) as TaskPlacement[]).map((placement) => ({
    placement,
    tile: { id: placement.tileId, type: 'text', title: placement.tileId } as unknown as Tile,
    completed: completed.includes(placement.tileId),
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
  })) as unknown as TaskRow[];
}

/** Captures the command a bulk path hands to historyStore and runs it. */
function captureExecutes(): Command[] {
  const captured: Command[] = [];
  vi.spyOn(historyStore, 'execute').mockImplementation(async (cmd: Command) => {
    captured.push(cmd);
    await cmd.execute();
  });
  return captured;
}

function confirmImmediately(): void {
  vi.spyOn(uiStore, 'openConfirm').mockImplementation((cfg) => {
    cfg.onConfirm(false);
  });
}

const ORIGINAL: Layout = {
  tasks: ['A', 'B', 'C', 'D', 'E'],
  sections: [
    { id: 'S1', position: 0 },
    { id: 'S2', position: 3 },
  ],
};

function bulkDelete(ids: string[]): Command {
  const captured = captureExecutes();
  confirmImmediately();
  const ctrl = new MultiSelectController({
    getBoard: () => board(),
    getRows: () => rows(),
    getFilteredRows: () => rows(),
    getPlacements: () => (board().tasks ?? []) as TaskPlacement[],
    getSections: () => (board().sections ?? []) as TaskListSection[],
    buildTaskFieldCommand: () => null,
    bumpCacheVersion: () => {},
    tickAndPersist: () => {},
    announce: () => {},
  });
  for (const id of ids) ctrl.handleRowSelect(id, { shift: false, ctrl: true });
  ctrl.bulkDelete();
  const cmd = captured[0];
  if (!cmd) throw new Error('bulkDelete executed no command');
  return cmd;
}

function deleteCompleted(completed: string[]): Command {
  const captured = captureExecutes();
  confirmImmediately();
  const deleter = makeTaskDeleter({
    getBoard: () => board(),
    getRows: () => rows(completed),
    getTilesById: () => ({}),
    buildTaskFieldCommand: () => null,
    tickAndPersist: () => {},
    announce: () => {},
  });
  deleter.deleteAllCompleted();
  const cmd = captured[0];
  if (!cmd) throw new Error('deleteAllCompleted executed no command');
  return cmd;
}

describe('Task List bulk delete → undo restores order and sections', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async () => null,
      on: () => () => {},
      send: () => {},
    };
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    hydrate();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    boardCacheStore.clear();
  });

  it('orderForBatchDelete sorts by descending position', () => {
    expect(orderForBatchDelete('tl', ['A', 'C', 'B', 'E'])).toEqual(['E', 'C', 'B', 'A']);
  });

  it('multi-select delete of {B, C} → undo deep-equals the original', async () => {
    const cmd = bulkDelete(['B', 'C']);
    await Promise.resolve();
    expect(layout().tasks).toEqual(['A', 'D', 'E']);
    await cmd.undo();
    expect(layout()).toEqual(ORIGINAL);
  });

  it('"Delete completed" with B and D (across sections) → undo deep-equals the original', async () => {
    const cmd = deleteCompleted(['B', 'D']);
    await Promise.resolve();
    expect(layout().tasks).toEqual(['A', 'C', 'E']);
    await cmd.undo();
    expect(layout()).toEqual(ORIGINAL);
  });

  it('multi-select delete of {A, E} → undo deep-equals the original', async () => {
    const cmd = bulkDelete(['A', 'E']);
    await Promise.resolve();
    await cmd.undo();
    expect(layout()).toEqual(ORIGINAL);
  });

  it('redo after undo reproduces the post-delete state', async () => {
    const cmd = bulkDelete(['B', 'C']);
    await Promise.resolve();
    const afterDelete = layout();
    await cmd.undo();
    await cmd.execute();
    expect(layout()).toEqual(afterDelete);
    await cmd.undo();
    expect(layout()).toEqual(ORIGINAL);
  });
});

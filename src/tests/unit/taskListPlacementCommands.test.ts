import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { sectionIdForPlacementIndex } from '@renderer/lib/tasklist/sectionMath';
import {
  AddTaskCommand,
  TogglePlacementLockCommand,
  ReorderTaskWithinSectionCommand,
} from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type {
  TaskListBoard,
  TaskListSection,
  TaskPlacement,
  TileDefinition,
} from '@renderer/schema/index';

/**
 * Phase 4 placement-level commands. Round-trip coverage:
 *   - TogglePlacementLockCommand  → flips placement.locked
 *   - ReorderTaskWithinSectionCommand → delegates to MoveTaskBlockCommand
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler> = {}): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function makeFixture(): BoardFileData {
  const defs: Record<string, TileDefinition> = {
    t1: { id: 't1', type: 'text', filePath: 'One.md' } as unknown as TileDefinition,
    t2: { id: 't2', type: 'text', filePath: 'Two.md' } as unknown as TileDefinition,
    t3: { id: 't3', type: 'text', filePath: 'Three.md' } as unknown as TileDefinition,
  };
  const tasks: TaskPlacement[] = [
    { tileId: 't1', position: 0 },
    { tileId: 't2', position: 1 },
    { tileId: 't3', position: 2 },
  ];
  const sections: TaskListSection[] = [
    { id: 's1', title: 'A', position: 0, collapsed: false },
  ];
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'manual' },
      sections,
      tasks,
    } as unknown as TaskListBoard,
    tileDefs: defs,
    connections: {},
    frames: [],
  };
}

function placement(tileId: string): TaskPlacement | undefined {
  const tl = boardCacheStore.cache.tl.board as TaskListBoard;
  return (tl.tasks ?? []).find((p) => p.tileId === tileId);
}

function tileOrder(): string[] {
  const tl = boardCacheStore.cache.tl.board as TaskListBoard;
  return (tl.tasks ?? []).map((p) => p.tileId);
}

describe('TogglePlacementLockCommand', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeFixture() },
      { tl: 'tasks.board.json' },
    );
  });
  afterEach(() => boardCacheStore.clear());

  it('execute locks the placement; undo unlocks', () => {
    const cmd = new TogglePlacementLockCommand('tl', 't2', false, true);
    cmd.execute();
    expect(placement('t2')?.locked).toBe(true);
    cmd.undo();
    expect(placement('t2')?.locked).toBeUndefined();
  });

  it('round-trip preserves prior state across execute/undo/execute', () => {
    boardCacheStore.setTaskPlacementLocked('tl', 't2', true);
    const cmd = new TogglePlacementLockCommand('tl', 't2', true, false);
    cmd.execute();
    expect(placement('t2')?.locked).toBeUndefined();
    cmd.undo();
    expect(placement('t2')?.locked).toBe(true);
    cmd.execute();
    expect(placement('t2')?.locked).toBeUndefined();
  });

  it('description reflects the target state', () => {
    expect(new TogglePlacementLockCommand('tl', 't2', false, true).description).toBe('Lock task');
    expect(new TogglePlacementLockCommand('tl', 't2', true, false).description).toBe('Unlock task');
  });
});

describe('AddTaskCommand targetSectionId disambiguation', () => {
  // Repro for the "tasks added to random sections" bug. When the user has
  // multiple empty sections sharing a `position` (the natural state right
  // after creating new sections without immediately filling them),
  // sectionIdForPlacementIndex picks the LAST section whose position <=
  // the placement index. Without a `targetSectionId` to pin the choice,
  // the new task gets assigned to a neighbour. Threading the target id
  // through AddTaskCommand → persistAddTaskPlacement fixes this.

  function makeMultiSectionFixture(): BoardFileData {
    const defs: Record<string, TileDefinition> = {
      t1: { id: 't1', type: 'text', filePath: 'One.md' } as unknown as TileDefinition,
      t2: { id: 't2', type: 'text', filePath: 'Two.md' } as unknown as TileDefinition,
      t3: { id: 't3', type: 'text', filePath: 'Three.md' } as unknown as TileDefinition,
    };
    const tasks: TaskPlacement[] = [
      { tileId: 't1', position: 0 },
      { tileId: 't2', position: 1 },
      { tileId: 't3', position: 2 },
    ];
    // A holds the three tasks; B and C are both empty and both sit at the
    // current tail (position == placements.length). This is exactly the
    // state produced by creating two new sections without filling them.
    const sections: TaskListSection[] = [
      { id: 'a', title: 'A', position: 0, collapsed: false },
      { id: 'b', title: 'B', position: 3, collapsed: false },
      { id: 'c', title: 'C', position: 3, collapsed: false },
    ];
    return {
      board: {
        id: 'tl',
        type: 'tasklist',
        name: 'Tasks',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: { groupBy: 'status', sortBy: 'manual' },
        sections,
        tasks,
      } as unknown as TaskListBoard,
      tileDefs: defs,
      connections: {},
      frames: [],
    };
  }

  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeMultiSectionFixture() },
      { tl: 'tasks.board.json' },
    );
  });
  afterEach(() => boardCacheStore.clear());

  function newTaskDef(id: string, title: string): TileDefinition {
    return {
      id,
      type: 'text',
      filePath: `${title}.md`,
      style: { headerColor: '', bodyColor: '' },
      createdAt: 0,
      updatedAt: 0,
    } as unknown as TileDefinition;
  }

  it('places the task in B when B and C share position 3 and B is the target', () => {
    const cmd = new AddTaskCommand(
      'tl',
      newTaskDef('tNew', 'Picked B'),
      3,
      undefined,
      'b',
    );
    cmd.execute();

    const tl = boardCacheStore.cache.tl.board as TaskListBoard;
    const tasks = (tl.tasks ?? []) as TaskPlacement[];
    const sections = (tl.sections ?? []) as TaskListSection[];

    expect(tasks.map((p) => p.tileId)).toEqual(['t1', 't2', 't3', 'tNew']);
    // B should keep position 3; C must shift to 4 so the new task at
    // index 3 unambiguously belongs to B.
    expect(sections.find((s) => s.id === 'a')?.position).toBe(0);
    expect(sections.find((s) => s.id === 'b')?.position).toBe(3);
    expect(sections.find((s) => s.id === 'c')?.position).toBe(4);
    expect(sectionIdForPlacementIndex(sections, 3)).toBe('b');
  });

  it('places the task in C when C is the target (the other branch of the same collision)', () => {
    const cmd = new AddTaskCommand(
      'tl',
      newTaskDef('tNew', 'Picked C'),
      3,
      undefined,
      'c',
    );
    cmd.execute();

    const tl = boardCacheStore.cache.tl.board as TaskListBoard;
    const sections = (tl.sections ?? []) as TaskListSection[];

    // C is the LAST tied section (array order [a, b, c]), so it naturally owns
    // the new tail slot — no section needs to move. Both B and C stay at 3
    // (the sorted, no-position-bump representation); the new task at index 3
    // resolves to C because sectionIdForPlacementIndex picks the last tied
    // section. (Pre-fix this bumped B to 4, leaving the array mis-sorted.)
    expect(sections.find((s) => s.id === 'b')?.position).toBe(3);
    expect(sections.find((s) => s.id === 'c')?.position).toBe(3);
    expect(sectionIdForPlacementIndex(sections, 3)).toBe('c');
  });

  it('without targetSectionId, preserves legacy carve-out (last tail section keeps the task)', () => {
    // No target id → the original `isAppend && position === oldLength`
    // carve-out applies to every tail-position section. The downstream
    // sectionIdForPlacementIndex then returns the last one (C). This is
    // the pre-fix behaviour — keep it intact for legacy callers.
    const cmd = new AddTaskCommand(
      'tl',
      newTaskDef('tNew', 'Legacy append'),
      3,
    );
    cmd.execute();

    const tl = boardCacheStore.cache.tl.board as TaskListBoard;
    const sections = (tl.sections ?? []) as TaskListSection[];
    expect(sections.find((s) => s.id === 'b')?.position).toBe(3);
    expect(sections.find((s) => s.id === 'c')?.position).toBe(3);
    expect(sectionIdForPlacementIndex(sections, 3)).toBe('c');
  });
});

describe('ReorderTaskWithinSectionCommand', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeFixture() },
      { tl: 'tasks.board.json' },
    );
  });
  afterEach(() => boardCacheStore.clear());

  it('execute swaps two adjacent tasks; undo restores order', () => {
    expect(tileOrder()).toEqual(['t1', 't2', 't3']);
    const before = {
      sections: [{ id: 's1', title: 'A', position: 0, collapsed: false }],
      tasks: [
        { tileId: 't1', position: 0 },
        { tileId: 't2', position: 1 },
        { tileId: 't3', position: 2 },
      ],
    };
    const after = {
      sections: [{ id: 's1', title: 'A', position: 0, collapsed: false }],
      tasks: [
        { tileId: 't2', position: 0 },
        { tileId: 't1', position: 1 },
        { tileId: 't3', position: 2 },
      ],
    };
    const cmd = new ReorderTaskWithinSectionCommand('tl', before, after, -1);
    cmd.execute();
    expect(tileOrder()).toEqual(['t2', 't1', 't3']);
    cmd.undo();
    expect(tileOrder()).toEqual(['t1', 't2', 't3']);
  });

  it('description reflects direction', () => {
    const empty = { sections: [], tasks: [] };
    expect(new ReorderTaskWithinSectionCommand('tl', empty, empty, -1).description).toBe('Move task up');
    expect(new ReorderTaskWithinSectionCommand('tl', empty, empty, 1).description).toBe('Move task down');
  });
});

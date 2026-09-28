/**
 * Undo of a Task List move, add or delete changes only what that step did.
 * Something else may have changed the board since (a cascade removed a task,
 * another view added one): undo must neither put that back nor push other
 * tasks into the wrong section. Whole-array snapshots and absolute section
 * starts did both.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { AddTaskCommand, DeleteTaskCommand, MoveTaskBlockCommand } from '@renderer/commands/index';
import { applyMove, layoutOf, movedTasks, regroup } from '@renderer/lib/tasklist/sectionMembership';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, TaskListSection, TaskPlacement, TileDefinition } from '@renderer/schema/index';

function def(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    createdAt: 0,
    updatedAt: 0,
    filePath: `${id}.md`,
  } as unknown as TileDefinition;
}

function section(id: string, position: number): TaskListSection {
  return { id, title: id, position, collapsed: false } as TaskListSection;
}

function placements(ids: string[]): TaskPlacement[] {
  return ids.map((tileId, position) => ({ tileId, position }));
}

/** Sections A = a1, a2 and B = b1, b2. */
function seed(): void {
  const ids = ['a1', 'a2', 'b1', 'b2'];
  const data: BoardFileData = {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'tl',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      sections: [section('A', 0), section('B', 2)],
      tasks: placements(ids),
    } as unknown as TaskListBoard,
    tileDefs: Object.fromEntries(ids.map((id) => [id, def(id)])),
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ tl: data }, { tl: 'tl.board.json' });
}

function live(): { sections: TaskListSection[]; tasks: TaskPlacement[] } {
  const tl = boardCacheStore.cache.tl!.board as TaskListBoard;
  return { sections: (tl.sections ?? []) as TaskListSection[], tasks: (tl.tasks ?? []) as TaskPlacement[] };
}

/** Each section's task ids, in order. */
function bySection(): Record<string, string[]> {
  const { sections, tasks } = live();
  const { order, sectionOf } = layoutOf(sections, tasks);
  const out: Record<string, string[]> = {};
  for (const id of order) (out[sectionOf[id] ?? '-'] ??= []).push(id);
  return out;
}

function snapshot(): { sections: TaskListSection[]; tasks: TaskPlacement[] } {
  const { sections, tasks } = live();
  return { sections: sections.map((s) => ({ ...s })), tasks: tasks.map((p) => ({ ...p })) };
}

describe('Task List undo keeps changes made off its stack', () => {
  beforeEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    seed();
  });
  afterEach(() => {
    boardCacheStore.clear();
  });

  it('move, then another task is removed, then undo the move: the removed task stays removed', () => {
    const before = snapshot();
    const after = {
      sections: [section('A', 0), section('B', 1)],
      tasks: placements(['a2', 'b1', 'b2', 'a1']),
    };
    const cmd = new MoveTaskBlockCommand('tl', before, after);
    cmd.execute();
    expect(bySection()).toEqual({ A: ['a2'], B: ['b1', 'b2', 'a1'] });

    boardCacheStore.removeTaskPlacement('tl', 'b1');
    cmd.undo();
    expect(bySection()).toEqual({ A: ['a1', 'a2'], B: ['b2'] });

    cmd.execute();
    expect(bySection()).toEqual({ A: ['a2'], B: ['b2', 'a1'] });
  });

  it('move, then a task is added elsewhere, then undo: the added task stays, in its section', () => {
    const cmd = new MoveTaskBlockCommand('tl', snapshot(), {
      sections: [section('A', 0), section('B', 2)],
      tasks: placements(['a1', 'a2', 'b2', 'b1']),
    });
    cmd.execute();
    expect(bySection()).toEqual({ A: ['a1', 'a2'], B: ['b2', 'b1'] });

    boardCacheStore.persistAddTaskPlacement('tl', def('n'), 2, undefined, 'A');
    expect(bySection()).toEqual({ A: ['a1', 'a2', 'n'], B: ['b2', 'b1'] });
    cmd.undo();
    expect(bySection()).toEqual({ A: ['a1', 'a2', 'n'], B: ['b1', 'b2'] });
  });

  it('add T to A, then a task of A is removed, then undo the add: every task stays in its section', async () => {
    const cmd = new AddTaskCommand('tl', def('t'), 2, undefined, 'A');
    await cmd.execute();
    expect(bySection()).toEqual({ A: ['a1', 'a2', 't'], B: ['b1', 'b2'] });

    boardCacheStore.removeTaskPlacement('tl', 'a1');
    cmd.undo();
    expect(bySection()).toEqual({ A: ['a2'], B: ['b1', 'b2'] });
  });

  it('delete b1, then a task of A is removed, then undo: b1 is back first in B', async () => {
    const cmd = new DeleteTaskCommand('tl', 'b1');
    await cmd.execute();
    expect(bySection()).toEqual({ A: ['a1', 'a2'], B: ['b2'] });

    boardCacheStore.removeTaskPlacement('tl', 'a1');
    await cmd.undo();
    expect(bySection()).toEqual({ A: ['a2'], B: ['b1', 'b2'] });
  });

  it('delete then undo with nothing in between is an exact round trip', async () => {
    const start = snapshot();
    const cmd = new DeleteTaskCommand('tl', 'a2');
    await cmd.execute();
    await cmd.undo();
    expect(snapshot()).toEqual(start);
  });
});

describe('sectionMembership', () => {
  const sections = [section('A', 0), section('E', 2), section('B', 2)];
  const tasks = placements(['a1', 'a2', 'b1', 'b2']);

  it('reads an empty section tied with the next one as empty', () => {
    expect(layoutOf(sections, tasks).sectionOf).toEqual({ a1: 'A', a2: 'A', b1: 'B', b2: 'B' });
  });

  it('regroup keeps empty sections empty and recomputes starts', () => {
    const out = regroup(sections, placements(['a1', 'b1', 'a2', 'b2']), { a1: 'A', a2: 'A', b1: 'B', b2: 'B' });
    expect(out.tasks.map((p) => p.tileId)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(out.sections.map((s) => [s.id, s.position])).toEqual([['A', 0], ['E', 2], ['B', 2]]);
  });

  it('movedTasks finds only the block that moved', () => {
    const before = layoutOf([section('A', 0)], placements(['t1', 't2', 't3', 't4', 't5']));
    const after = layoutOf([section('A', 0)], placements(['t1', 't4', 't5', 't2', 't3']));
    // Either pair alone moving explains the new order; nothing else moved.
    expect(movedTasks(before, after)).toHaveLength(2);
  });

  it('applyMove reproduces the target exactly when nothing else changed', () => {
    const before = { sections: [section('A', 0), section('B', 2)], tasks: placements(['a1', 'a2', 'b1', 'b2']) };
    const after = { sections: [section('A', 0), section('B', 1)], tasks: placements(['a2', 'b1', 'a1', 'b2']) };
    const lb = layoutOf(before.sections, before.tasks);
    const la = layoutOf(after.sections, after.tasks);
    const moved = movedTasks(lb, la);
    const redone = applyMove(before.sections, before.tasks, moved, la);
    expect(redone.tasks.map((p) => p.tileId)).toEqual(['a2', 'b1', 'a1', 'b2']);
    expect(redone.sections.map((s) => s.position)).toEqual([0, 1]);
    const undone = applyMove(redone.sections, redone.tasks, moved, lb);
    expect(undone.tasks.map((p) => p.tileId)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(undone.sections.map((s) => s.position)).toEqual([0, 2]);
  });
});

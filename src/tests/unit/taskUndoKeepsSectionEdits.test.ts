import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { AddTaskCommand, DeleteTaskCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, TaskListSection, TaskPlacement, TileDefinition } from '@renderer/schema/index';

/**
 * Undo of adding or deleting a task puts back only the section starts the
 * add or delete shifted. It used to replay the whole `sections` array, so a
 * section renamed, collapsed or added in between was reverted with it.
 */

function installFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function textDef(id: string, filePath: string): TileDefinition {
  return { id, type: 'text', filePath, style: { headerColor: '', bodyColor: '' }, createdAt: 0, updatedAt: 0 } as unknown as TileDefinition;
}

function fixture(): BoardFileData {
  const defs: Record<string, TileDefinition> = {
    t1: textDef('t1', 'One.md'),
    t2: textDef('t2', 'Two.md'),
    t3: textDef('t3', 'Three.md'),
  };
  const tasks: TaskPlacement[] = [
    { tileId: 't1', position: 0 },
    { tileId: 't2', position: 1 },
    { tileId: 't3', position: 2 },
  ];
  const sections: TaskListSection[] = [
    { id: 's1', title: 'First', position: 0, collapsed: false },
    { id: 's2', title: 'Second', position: 2, collapsed: false },
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

function board(): TaskListBoard {
  return boardCacheStore.cache.tl!.board as TaskListBoard;
}

function sections(): TaskListSection[] {
  return (board().sections ?? []) as TaskListSection[];
}

/** An edit made between the command and its undo, not through the command. */
function renameSection(id: string, title: string): void {
  (board() as Record<string, unknown>).sections = sections().map((s) => (s.id === id ? { ...s, title } : s));
}

describe('Task List add / delete undo keeps section edits made since', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate({ tl: fixture() }, { tl: 'tasks.board.json' });
  });
  afterEach(() => {
    boardCacheStore.clear();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it('add a task, rename a section, undo the add: the rename stays and the starts round-trip', async () => {
    const def = textDef('t4', 'Four.md');
    const cmd = new AddTaskCommand('tl', def, 1, undefined, 's1');
    await cmd.execute();
    expect(sections().map((s) => s.position)).toEqual([0, 3]);

    renameSection('s2', 'Renamed');
    (board() as Record<string, unknown>).sections = sections().map((s) => (s.id === 's1' ? { ...s, collapsed: true } : s));
    cmd.undo();

    expect(sections().map((s) => [s.id, s.title, s.position, s.collapsed])).toEqual([
      ['s1', 'First', 0, true],
      ['s2', 'Renamed', 2, false],
    ]);
  });

  it('delete a task, rename a section, undo the delete: the rename stays and the starts round-trip', async () => {
    const cmd = new DeleteTaskCommand('tl', 't2');
    await cmd.execute();
    expect(sections().map((s) => s.position)).toEqual([0, 1]);

    renameSection('s1', 'Renamed');
    await cmd.undo();

    expect(sections().map((s) => [s.id, s.title, s.position])).toEqual([
      ['s1', 'Renamed', 0],
      ['s2', 'Second', 2],
    ]);
    expect((board().tasks ?? []).map((p) => p.tileId)).toEqual(['t1', 't2', 't3']);
  });

  it('a section deleted since is not brought back by the undo', async () => {
    const def = textDef('t4', 'Four.md');
    const cmd = new AddTaskCommand('tl', def, 3, undefined, 's2');
    await cmd.execute();
    (board() as Record<string, unknown>).sections = sections().filter((s) => s.id !== 's2');
    cmd.undo();
    expect(sections().map((s) => s.id)).toEqual(['s1']);
  });
});

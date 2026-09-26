/**
 * Undo puts a Kanban card or Task List task back exactly: in its column or
 * section, at its position, with every placement field it had (style, cover,
 * lock, and fields this version doesn't know). Covers the cascade delete (a
 * sidebar delete of the note, or of a folder holding the note and its cover)
 * and the single card / task deletes, plus the Mind Map inline-tile sweep.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { DeleteCardCommand, DeleteTaskCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, MindMapBoard, TaskListBoard, TileDefinition } from '@renderer/schema/index';

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function def(id: string, filePath: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath,
    style: { headerColor: '#000', bodyColor: '#fff', borderColor: '' } as never,
    createdAt: 0,
    updatedAt: 0,
  } as TileDefinition;
}

function makeKanban(): BoardFileData {
  return {
    board: {
      id: 'kb', type: 'kanban', name: 'kb', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      columns: [
        { id: 'todo', title: 'To Do', position: 0, collapsed: false, tilePlacements: [
          { tileId: 'a', position: 0 },
        ] },
        { id: 'doing', title: 'Doing', position: 1, collapsed: false, tilePlacements: [
          { tileId: 'b', position: 0 },
          { tileId: 'c', position: 1, style: { headerColor: '#123456' }, coverImage: 'Proj/cover.png', pinned: 'yes' },
          { tileId: 'd', position: 2 },
        ] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { a: def('a', 'A.md'), b: def('b', 'B.md'), c: def('c', 'Proj/C.md'), d: def('d', 'D.md') },
    connections: {},
    frames: [],
  };
}

function makeTaskList(): BoardFileData {
  return {
    board: {
      id: 'tl', type: 'tasklist', name: 'tl', emoji: '', createdAt: 0, updatedAt: 0,
      settings: { sortBy: 'manual' },
      sections: [
        { id: 's1', title: 'First', position: 0 },
        { id: 's2', title: 'Second', position: 2 },
      ],
      tasks: [
        { tileId: 't1', position: 0 },
        { tileId: 't2', position: 1 },
        { tileId: 't3', position: 2, locked: true, style: { headerColor: '#abcdef' }, extra: 42 },
        { tileId: 't4', position: 3 },
      ],
    } as unknown as TaskListBoard,
    tileDefs: { t1: def('t1', 'T1.md'), t2: def('t2', 'T2.md'), t3: def('t3', 'T3.md'), t4: def('t4', 'T4.md') },
    connections: {},
    frames: [],
  };
}

const columns = (): KanbanBoard['columns'] => (boardCacheStore.cache.kb.board as KanbanBoard).columns;
const taskList = (): TaskListBoard => boardCacheStore.cache.tl.board as TaskListBoard;

describe('undo of a delete on a list board', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    boardCacheStore.hydrate({ kb: makeKanban(), tl: makeTaskList() }, { kb: 'kb.board.json', tl: 'tl.board.json' });
  });
  afterEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('cascade (a folder holding the card and its cover): the card comes back in its column with style, cover and unknown fields', async () => {
    const before = JSON.parse(JSON.stringify(columns()));
    const { command } = boardStore.cascadeDeleteByVaultPath('Proj');
    expect(command).not.toBeNull();
    await flushAsync();
    expect(columns()[1].tilePlacements.map((p) => p.tileId)).toEqual(['b', 'd']);

    await command!.undo();
    await flushAsync();
    expect(JSON.parse(JSON.stringify(columns()))).toEqual(before);
    expect(boardCacheStore.cache.kb.tileDefs.c).toBeDefined();
  });

  it('cascade: a Task List task comes back at its index, with its lock and section boundaries', async () => {
    const before = JSON.parse(JSON.stringify({ tasks: taskList().tasks, sections: taskList().sections }));
    const { command } = boardStore.cascadeDeleteByVaultPath('T3.md');
    await flushAsync();
    expect(taskList().tasks.map((t) => t.tileId)).toEqual(['t1', 't2', 't4']);

    await command!.undo();
    await flushAsync();
    expect(JSON.parse(JSON.stringify({ tasks: taskList().tasks, sections: taskList().sections }))).toEqual(before);
  });

  it('cascade of two tasks and two cards: every one returns to its place', async () => {
    const kbBefore = JSON.parse(JSON.stringify(columns()));
    const tlBefore = JSON.parse(JSON.stringify(taskList().tasks));
    // Rename the defs so one folder holds a card pair and a task pair.
    for (const [board, ids] of [['kb', ['b', 'c']], ['tl', ['t2', 't3']]] as const) {
      for (const id of ids) {
        (boardCacheStore.cache[board].tileDefs[id] as { filePath: string }).filePath = `Gone/${id}.md`;
      }
    }
    const { command } = boardStore.cascadeDeleteByVaultPath('Gone');
    await flushAsync();
    expect(columns()[1].tilePlacements.map((p) => p.tileId)).toEqual(['d']);
    expect(taskList().tasks.map((t) => t.tileId)).toEqual(['t1', 't4']);

    await command!.undo();
    await flushAsync();
    expect(columns()[1].tilePlacements.map((p) => p.tileId)).toEqual(kbBefore[1].tilePlacements.map((p: { tileId: string }) => p.tileId));
    expect(JSON.parse(JSON.stringify(taskList().tasks))).toEqual(tlBefore);
  });

  it('DeleteTaskCommand keeps the lock and unknown placement fields', async () => {
    const cmd = new DeleteTaskCommand('tl', 't3');
    await cmd.execute();
    await cmd.undo();
    const t3 = taskList().tasks.find((t) => t.tileId === 't3') as Record<string, unknown>;
    expect(t3.locked).toBe(true);
    expect(t3.extra).toBe(42);
    expect(t3.style).toEqual({ headerColor: '#abcdef' });
  });

  it('DeleteCardCommand keeps unknown placement fields', () => {
    const cmd = new DeleteCardCommand('kb', 'c');
    cmd.execute();
    cmd.undo();
    const c = columns()[1].tilePlacements.find((p) => p.tileId === 'c') as Record<string, unknown>;
    expect(c.pinned).toBe('yes');
    expect(c.coverImage).toBe('Proj/cover.png');
  });
});

describe('Mind Map removeTile', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    boardCacheStore.clear();
  });
  afterEach(() => boardCacheStore.clear());

  it('an inline tile takes its connections with it', () => {
    const mm: BoardFileData = {
      board: {
        id: 'mm', type: 'mindmap', name: 'mm', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
        placements: { t: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false } },
        inlineTiles: {
          l1: { x: 300, y: 0, width: 200, height: 100, locked: false, faded: false },
        },
        waypoints: [],
      } as unknown as MindMapBoard,
      tileDefs: {
        t: def('t', 'T.md'),
        l1: { id: 'l1', type: 'link', title: 'L', url: 'https://example.com', tags: [], style: {}, createdAt: 0, updatedAt: 0 } as unknown as TileDefinition,
      },
      connections: {
        c1: { id: 'c1', boardId: 'mm', fromTileId: 't', toTileId: 'l1' } as never,
      },
      frames: [],
    };
    boardCacheStore.hydrate({ mm }, { mm: 'mm.board.json' });
    boardCacheStore.persistRemoveTile('l1');
    expect(boardCacheStore.cache.mm.connections.c1).toBeUndefined();
    expect((boardCacheStore.cache.mm.board as MindMapBoard).inlineTiles?.l1).toBeUndefined();
  });
});

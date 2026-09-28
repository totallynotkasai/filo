import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import { cancelAllPendingWrites, resetWriteTracking, type BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TaskListBoard, TileDefinition } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

/**
 * A cascade redo that can't move its file into Filo's trash must not count
 * as done: the step stays where it was, and nothing it would have removed is
 * gone. Otherwise the next undo skips the restore and puts back placements
 * the board still holds.
 */

function textDef(id: string, filePath: string): TileDefinition {
  return {
    id,
    type: 'text',
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    createdAt: 0,
    updatedAt: 0,
    filePath,
  } as unknown as TileDefinition;
}

function makeKanban(id: string, tileId: string, filePath: string): BoardFileData {
  return {
    board: {
      id,
      type: 'kanban',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [{ id: 'col1', title: 'To Do', position: 0, collapsed: false, tilePlacements: [{ tileId, position: 0 }] }],
    } as unknown as KanbanBoard,
    tileDefs: { [tileId]: textDef(tileId, filePath) },
    connections: {},
    frames: [],
  };
}

function makeTaskList(id: string, tileId: string, filePath: string): BoardFileData {
  return {
    board: {
      id,
      type: 'tasklist',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      sections: [],
      tasks: [{ tileId, position: 0 }],
    } as unknown as TaskListBoard,
    tileDefs: { [tileId]: textDef(tileId, filePath) },
    connections: {},
    frames: [],
  };
}

function installBoardVault(files: Record<string, string>, root: string): MemoryVault {
  const vault = installMemoryVault(files, root);
  const base = window.filo.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>;
  window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
    if (channel === 'board:save') return { success: true };
    if (channel === 'vault:read-tree') return { ok: true, tree: [] };
    return base(channel, ...args);
  }) as typeof window.filo.invoke;
  return vault;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function kanbanCardIds(boardId: string): string[] {
  const kb = boardCacheStore.cache[boardId]?.board as KanbanBoard;
  return (kb.columns ?? []).flatMap((c) => (c.tilePlacements ?? []).map((p) => p.tileId));
}

describe('CascadeDeleteCommand redo whose trash move is refused', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    historyStore.setActiveBoard('mm');
    cancelAllPendingWrites();
    resetWriteTracking();
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    cancelAllPendingWrites();
    resetWriteTracking();
  });

  it('leaves the step on the redo stack and the card on its board; a later undo adds no duplicate', async () => {
    const vault = installBoardVault({ 'Card.md': 'body\n' }, '/v');
    vaultStore.setPath('/v');
    boardCacheStore.hydrate({ k: makeKanban('k', 't1', 'Card.md') }, { k: 'k.board.json' });

    const moved = (await window.filo.invoke('vault:trash-move', '/v', 'Card.md')) as { trashId: string };
    const tile = boardCacheStore.getFullTilesForBoard('k').t1;
    const cmd = new CascadeDeleteCommand({ k: [tile] }, [], { vaultRoot: '/v', trashed: { rel: 'Card.md', trashId: moved.trashId } });
    await historyStore.execute(cmd);
    expect(kanbanCardIds('k')).toEqual([]);

    await historyStore.undo();
    await settle();
    expect(kanbanCardIds('k')).toEqual(['t1']);
    expect(vault.read('Card.md')).toBe('body\n');

    vault.failNextTrashMove('Card.md', 'EBUSY');
    await historyStore.redo();
    await settle();

    // The redo did nothing, so it must still be a redo.
    expect(historyStore.canRedo).toBe(true);
    expect(historyStore.canUndo).toBe(false);
    expect(vault.read('Card.md')).toBe('body\n');
    expect(kanbanCardIds('k')).toEqual(['t1']);

    // Ctrl+Z has nothing to undo: no second copy of the card appears.
    await historyStore.undo();
    await settle();
    expect(kanbanCardIds('k')).toEqual(['t1']);

    // And once the file can move, the redo goes through.
    await historyStore.redo();
    await settle();
    expect(vault.read('Card.md')).toBeUndefined();
    expect(kanbanCardIds('k')).toEqual([]);
  });
});

describe('placement re-adds are idempotent', () => {
  beforeEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
  });
  afterEach(() => {
    boardCacheStore.clear();
  });

  it('persistAddKanbanPlacement twice leaves one card', () => {
    boardCacheStore.hydrate({ k: makeKanban('k', 't1', 'Card.md') }, { k: 'k.board.json' });
    boardCacheStore.persistAddKanbanPlacement('k', 'col1', textDef('t1', 'Card.md'), 0);
    expect(kanbanCardIds('k')).toEqual(['t1']);
  });

  it('persistAddTaskPlacement twice leaves one task', () => {
    boardCacheStore.hydrate({ tl: makeTaskList('tl', 't1', 'Task.md') }, { tl: 'tl.board.json' });
    boardCacheStore.persistAddTaskPlacement('tl', textDef('t1', 'Task.md'), 0);
    const tl = boardCacheStore.cache.tl?.board as TaskListBoard;
    expect((tl.tasks ?? []).map((p) => p.tileId)).toEqual(['t1']);
  });
});

/**
 * M3 (2026-05-28) — the Kanban column-slice and Task List slice snapshot
 * helpers used by structural undo commands previously did a one/two-level
 * spread, leaving each placement's nested `style` aliased to the live
 * `$state` proxy. An in-place mutation of that nested object between snapshot
 * and undo corrupted the retained snapshot, so the restore replayed the
 * mutated state rather than the snapshot-time state.
 *
 * The fix routes both helpers through the shared `cloneForSnapshot` JSON
 * deep-clone. These tests pin the behaviour: mutate a nested `style` after
 * the snapshot, then restore, and assert the original value comes back.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { DeleteColumnCommand } from '@renderer/commands/index';
import {
  snapshotTaskListSlice,
  restoreTaskListSlice,
} from '@renderer/commands/taskCommands';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TaskListBoard, TileDefinition } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function textDef(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    title,
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    tags: [],
    filePath: `${id}.md`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function makeKanbanWithStyledCard(): BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'col-1',
          title: 'Todo',
          position: 0,
          collapsed: false,
          tilePlacements: [
            { tileId: 't1', position: 0, style: { headerColor: '#aaaaaa' } },
          ],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { t1: textDef('t1', 'Card A') },
    connections: {},
    frames: [],
  };
}

function makeTaskListWithStyledTask(): BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'priority' },
      sections: [{ id: 'sec-1', title: 'Section', position: 0 }],
      tasks: [
        { tileId: 't1', position: 0, sectionId: 'sec-1', style: { headerColor: '#aaaaaa' } },
      ],
    } as unknown as TaskListBoard,
    tileDefs: { t1: textDef('t1', 'Task A') },
    connections: {},
    frames: [],
  };
}

describe('snapshot helpers — deep clone (M3)', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    historyStore.clear();
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    historyStore.clear();
  });

  it('DeleteColumnCommand undo restores the snapshot-time nested card style, not a later mutation', () => {
    boardCacheStore.hydrate({ kb: makeKanbanWithStyledCard() }, { kb: 'k.board.json' });

    // Snapshot captured at construction time.
    const cmd = new DeleteColumnCommand('kb', 'col-1', 'Todo');

    // Mutate the live placement's nested style in place — the race the
    // deep-clone defends against. A shallow snapshot would alias this object.
    const liveKb = boardCacheStore.cache.kb!.board as KanbanBoard;
    (liveKb.columns[0].tilePlacements[0] as { style: { headerColor: string } }).style.headerColor =
      '#000000';

    cmd.execute();
    cmd.undo();

    const restored = (boardCacheStore.cache.kb!.board as KanbanBoard).columns[0]
      .tilePlacements[0] as { style?: { headerColor?: string } };
    expect(restored.style?.headerColor).toBe('#aaaaaa');
  });

  it('restoreTaskListSlice restores the snapshot-time nested task style, not a later mutation', () => {
    boardCacheStore.hydrate({ tl: makeTaskListWithStyledTask() }, { tl: 'tasks.board.json' });

    const snap = snapshotTaskListSlice('tl');
    expect(snap).not.toBeNull();

    // Mutate the live task's nested style in place after the snapshot.
    const liveTl = boardCacheStore.cache.tl!.board as TaskListBoard;
    (liveTl.tasks![0] as { style: { headerColor: string } }).style.headerColor = '#000000';

    restoreTaskListSlice('tl', snap!);

    const restored = (boardCacheStore.cache.tl!.board as TaskListBoard).tasks![0] as {
      style?: { headerColor?: string };
    };
    expect(restored.style?.headerColor).toBe('#aaaaaa');
  });
});

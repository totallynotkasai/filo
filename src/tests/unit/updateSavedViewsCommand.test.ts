/**
 * Phase 7 / 7.4 + 7.5 — UpdateSavedViewsCommand round-trips the saved-views
 * array on both Kanban and Task List boards. The same command serves both
 * via a `kind` discriminator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { UpdateSavedViewsCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TaskListBoard } from '@renderer/schema/index';

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeKanbanFixture(): BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Kanban',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function makeTaskListFixture(): BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'priority' },
      tasks: [],
    } as unknown as TaskListBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function getSavedViews(boardId: 'kb' | 'tl'): unknown[] {
  const cached = boardCacheStore.cache[boardId];
  const settings = (cached.board.settings ?? {}) as Record<string, unknown>;
  const raw = settings.savedViews;
  return Array.isArray(raw) ? raw : [];
}

describe('UpdateSavedViewsCommand', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { kb: makeKanbanFixture(), tl: makeTaskListFixture() },
      { kb: 'kanban.board.json', tl: 'tasks.board.json' },
    );
  });
  afterEach(() => boardCacheStore.clear());

  it('Kanban: execute applies the after array, undo restores before', () => {
    const before: Array<{ id: string; name: string } & Record<string, unknown>> = [];
    const after = [
      { id: 'v1', name: 'My View', sortBy: 'manual', filterTags: [], filterProp: null },
    ];
    const cmd = new UpdateSavedViewsCommand('kb', 'kanban', before, after);
    cmd.execute();
    expect(getSavedViews('kb')).toHaveLength(1);
    expect((getSavedViews('kb')[0] as { name: string }).name).toBe('My View');
    cmd.undo();
    expect(getSavedViews('kb')).toHaveLength(0);
  });

  it('Task List: execute applies the after array, undo restores before', () => {
    const before: Array<{ id: string; name: string } & Record<string, unknown>> = [];
    const after = [
      {
        id: 'v1',
        name: 'High Priority',
        groupBy: 'status',
        sortBy: 'priority',
        filterTags: [],
        filterStatus: null,
        filterPriority: 'high',
        showCompleted: false,
        smartList: 'all',
      },
    ];
    const cmd = new UpdateSavedViewsCommand('tl', 'tasklist', before, after);
    cmd.execute();
    expect(getSavedViews('tl')).toHaveLength(1);
    cmd.undo();
    expect(getSavedViews('tl')).toHaveLength(0);
  });

  it('deep-clones the snapshots so caller mutation does not leak', () => {
    const before = [
      { id: 'v1', name: 'Old', sortBy: 'manual', filterTags: ['a'], filterProp: null },
    ];
    const after = [
      { id: 'v2', name: 'New', sortBy: 'manual', filterTags: ['b'], filterProp: null },
    ];
    const cmd = new UpdateSavedViewsCommand('kb', 'kanban', before, after);
    // Mutate the input arrays AND the inner per-view objects.
    before.length = 0;
    after.length = 0;
    cmd.execute();
    expect((getSavedViews('kb')[0] as { name: string }).name).toBe('New');
    cmd.undo();
    expect((getSavedViews('kb')[0] as { name: string }).name).toBe('Old');
  });

  it('exposes targetBoardId for the history dispatcher guard', () => {
    const cmd = new UpdateSavedViewsCommand('kb', 'kanban', [], []);
    expect(cmd.targetBoardId).toBe('kb');
  });

  it('describes the operation', () => {
    expect(new UpdateSavedViewsCommand('kb', 'kanban', [], [], 'Save view "X"').description).toBe(
      'Save view "X"',
    );
    expect(new UpdateSavedViewsCommand('kb', 'kanban', [], []).description).toBe(
      'Update saved views',
    );
  });
});

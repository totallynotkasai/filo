/**
 * Phase 7 / 7.2 — UpdateKanbanColumnCommand + SetAllKanbanColumnsCollapsedCommand.
 *
 * Each command captures the affected column slice's prior shape (collapsed
 * flag, WIP limit, width) so undo restores the exact prior state even if
 * the user toggled an adjacent column in between. The bulk command snapshots
 * the per-column flag so a mixed-state collapse-all → undo restores the
 * original mix rather than expanding everything.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import {
  UpdateKanbanColumnCommand,
  SetAllKanbanColumnsCollapsedCommand,
} from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeKanbanFixture(): V7BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Kanban',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'c1',
          title: 'Todo',
          position: 0,
          collapsed: false,
          tilePlacements: [],
        },
        {
          id: 'c2',
          title: 'Done',
          position: 1,
          collapsed: true,
          tilePlacements: [],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function getColumn(id: string): { collapsed: boolean; wipLimit?: number; style?: Record<string, unknown> } | undefined {
  const kb = boardCacheStore.cache.kb.board as KanbanBoard;
  return kb.columns?.find((c) => c.id === id);
}

describe('UpdateKanbanColumnCommand', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeKanbanFixture() }, { kb: 'kanban.board.json' });
  });
  afterEach(() => boardCacheStore.clear());

  it('execute applies the after-snapshot', () => {
    const cmd = new UpdateKanbanColumnCommand(
      'kb',
      'c1',
      { collapsed: false, wipLimit: null, width: null },
      { collapsed: true, wipLimit: 5, width: 320 },
    );
    cmd.execute();
    const col = getColumn('c1');
    expect(col?.collapsed).toBe(true);
    expect(col?.wipLimit).toBe(5);
    expect((col?.style as Record<string, unknown> | undefined)?.width).toBe(320);
  });

  it('undo restores the before-snapshot', () => {
    const cmd = new UpdateKanbanColumnCommand(
      'kb',
      'c1',
      { collapsed: false, wipLimit: null, width: null },
      { collapsed: true, wipLimit: 5, width: 320 },
    );
    cmd.execute();
    cmd.undo();
    const col = getColumn('c1');
    expect(col?.collapsed).toBe(false);
    expect(col?.wipLimit).toBeUndefined();
    expect((col?.style as Record<string, unknown> | undefined)?.width).toBeUndefined();
  });

  it('round-trip execute/undo/redo is stable', () => {
    const cmd = new UpdateKanbanColumnCommand(
      'kb',
      'c1',
      { collapsed: false, wipLimit: null, width: null },
      { collapsed: true, wipLimit: 3, width: 280 },
    );
    cmd.execute();
    expect(getColumn('c1')?.collapsed).toBe(true);
    cmd.undo();
    expect(getColumn('c1')?.collapsed).toBe(false);
    cmd.execute();
    expect(getColumn('c1')?.collapsed).toBe(true);
    expect(getColumn('c1')?.wipLimit).toBe(3);
  });

  it('exposes targetBoardId for the history dispatcher guard', () => {
    const cmd = new UpdateKanbanColumnCommand(
      'kb',
      'c1',
      { collapsed: false, wipLimit: null, width: null },
      { collapsed: true, wipLimit: null, width: null },
    );
    expect(cmd.targetBoardId).toBe('kb');
  });
});

describe('SetAllKanbanColumnsCollapsedCommand', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeKanbanFixture() }, { kb: 'kanban.board.json' });
  });
  afterEach(() => boardCacheStore.clear());

  it('execute collapses every column', () => {
    const cmd = new SetAllKanbanColumnsCollapsedCommand('kb', true, { c1: false, c2: true });
    cmd.execute();
    expect(getColumn('c1')?.collapsed).toBe(true);
    expect(getColumn('c2')?.collapsed).toBe(true);
  });

  it('undo restores the prior mixed state exactly', () => {
    const cmd = new SetAllKanbanColumnsCollapsedCommand('kb', true, { c1: false, c2: true });
    cmd.execute();
    cmd.undo();
    expect(getColumn('c1')?.collapsed).toBe(false);
    expect(getColumn('c2')?.collapsed).toBe(true);
  });

  it('description reflects the direction', () => {
    expect(new SetAllKanbanColumnsCollapsedCommand('kb', true, {}).description).toBe(
      'Collapse all columns',
    );
    expect(new SetAllKanbanColumnsCollapsedCommand('kb', false, {}).description).toBe(
      'Expand all columns',
    );
  });
});

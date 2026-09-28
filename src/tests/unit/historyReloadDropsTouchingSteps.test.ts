/**
 * A board read again from disk drops every undo step that holds a snapshot of
 * it, wherever the step is filed: a cascade delete filed on the Mind Map
 * stack that also removed a Kanban card, a batch whose child touches the
 * board, and a cascade whose undo only a toast offers. Undoing one of those
 * would write the version before the reload over the other change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reloadBoardFromDisk } from '@renderer/stores/boardDrift';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { BatchCommand, CascadeDeleteCommand, DeleteCardCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { cancelAllPendingWrites, resetWriteTracking, type BoardFileData } from '@renderer/lib/boards/boardSaver';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { fakeCommand } from '../helpers/fakeCommand';

const K_REL = 'k.board.json';

function makeKanban(cardIds: string[]): BoardFileData {
  const tileDefs: Record<string, TileDefinition> = {};
  for (const id of cardIds) {
    tileDefs[id] = {
      id,
      type: 'text',
      style: { headerColor: '', bodyColor: '', borderColor: '' },
      createdAt: 0,
      updatedAt: 0,
      filePath: `${id}.md`,
    } as unknown as TileDefinition;
  }
  return {
    version: 8,
    board: {
      id: 'k',
      type: 'kanban',
      name: 'k',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [{
        id: 'col1', title: 'To Do', position: 0, collapsed: false,
        tilePlacements: cardIds.map((tileId, position) => ({ tileId, position })),
      }],
    } as unknown as KanbanBoard,
    tileDefs,
    connections: {},
    frames: [],
  } as BoardFileData;
}

function installDisk(onDisk: BoardFileData): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string) => {
      if (channel === 'board:load') return onDisk;
      if (channel === 'vault:stat') return { success: true, ok: true, mtimeMs: 2000, size: 300 };
      return undefined;
    },
    on: () => () => {},
    send: () => {},
  };
}

describe('a board reload drops the steps that touch it', () => {
  beforeEach(() => {
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    cancelAllPendingWrites();
    resetWriteTracking();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    boardCacheStore.hydrate({ k: makeKanban(['c1', 'c2']) }, { k: K_REL });
    // The Mind Map is the active board: its stack files the cascade.
    historyStore.setActiveBoard('mm');
    installDisk(makeKanban(['c1', 'c2', 'c3']));
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    cancelAllPendingWrites();
    resetWriteTracking();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it('a cascade on the Mind Map stack that removed a card of K goes when K is reloaded', async () => {
    const tile = boardCacheStore.getFullTilesForBoard('k').c1!;
    const cascade = new CascadeDeleteCommand({ k: [tile] }, [], { vaultRoot: '/vault' });
    await historyStore.execute(cascade);
    expect(historyStore.canUndo).toBe(true);
    expect(cascade.touchedBoardIds().has('k')).toBe(true);

    expect(await reloadBoardFromDisk(K_REL, 'k')).toBe('reloaded');
    expect(historyStore.canUndo).toBe(false);
  });

  it('a batch filed on the Mind Map whose child touches K goes too; steps of other boards stay', async () => {
    const other = fakeCommand({ description: 'other', targetBoardId: 'mm', execute() {}, undo() {} });
    historyStore.pushWithoutExecute(other);
    const batch = new BatchCommand('mixed', [new DeleteCardCommand('k', 'c2')], 'mm');
    await historyStore.execute(batch);

    expect(await reloadBoardFromDisk(K_REL, 'k')).toBe('reloaded');
    // Only `other` is left: undo reaches it, and nothing after.
    let undone = 0;
    other.undo = () => { undone++; };
    await historyStore.undo();
    expect(undone).toBe(1);
    expect(historyStore.canUndo).toBe(false);
  });

  it('closing K (not a reload) keeps a cascade filed on another board', () => {
    const tile = boardCacheStore.getFullTilesForBoard('k').c1!;
    historyStore.pushWithoutExecute(new CascadeDeleteCommand({ k: [tile] }, [], { vaultRoot: '/vault' }));
    historyStore.clearBoard('k');
    expect(historyStore.canUndo).toBe(true);
  });

  it("a toast's off-stack undo is refused after K was reloaded", async () => {
    const tile = boardCacheStore.getFullTilesForBoard('k').c1!;
    const cascade = new CascadeDeleteCommand({ k: [tile] }, [], { vaultRoot: '/vault' });
    historyStore.holdOffStack(cascade);
    await historyStore.runOffStack(() => cascade.execute(), cascade.description);

    expect(await reloadBoardFromDisk(K_REL, 'k')).toBe('reloaded');
    let undone = false;
    cascade.undo = async () => { undone = true; };
    const before = uiStore.toasts.length;
    await historyStore.undoOffStack(cascade, 'Undo delete');
    expect(undone).toBe(false);
    expect(uiStore.toasts.length).toBeGreaterThan(before);
    expect(uiStore.toasts.at(-1)?.text).toContain('reloaded from disk');
  });

  it("a toast's off-stack undo runs once while nothing reloaded", async () => {
    const tile = boardCacheStore.getFullTilesForBoard('k').c1!;
    const cascade = new CascadeDeleteCommand({ k: [tile] }, [], { vaultRoot: '/vault' });
    historyStore.holdOffStack(cascade);
    let undone = 0;
    cascade.undo = async () => { undone++; };
    await historyStore.undoOffStack(cascade, 'Undo delete');
    await historyStore.undoOffStack(cascade, 'Undo delete');
    expect(undone).toBe(1);
  });
});

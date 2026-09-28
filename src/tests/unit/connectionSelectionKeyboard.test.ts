/**
 * Phase C / C.4 — connection selection contract.
 *
 * The selection scope's connection slice (selectConnection / toggle /
 * deselect / clear) was wired earlier but had no production caller —
 * Phase F's dead-code audit flagged it for removal. C.4 brings it
 * back into use: ConnectionPath now click-selects, and Delete in
 * AppShell iterates `selectedConnectionIds` to fire
 * DeleteConnectionCommand for each.
 *
 * Mounting ConnectionPath in vitest fails on style preprocess, so this
 * test exercises the selection scope + history command contract that
 * the wired UI delegates to. The click handler in ConnectionPath is a
 * one-liner over `selectionStore.selectConnection` — locking the scope
 * behaviour locks the user-facing contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { selectionStore } from '@renderer/stores/selection.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { DeleteConnectionCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Connection } from '@renderer/schema/index';

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeFixture(): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function makeConnection(id: string): Connection {
  return {
    id,
    boardId: 'mm',
    fromTileId: 't_a',
    toTileId: 't_b',
    fromBubble: 3,
    toBubble: 7,
    pathColor: '',
    arrowColor: '',
    visibility: 'visible',
    labelVisibility: 'visible',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Connection;
}

function activate(): void {
  const fixture = makeFixture();
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  boardStore.setBoard(fixture.board);
}

beforeEach(() => {
  installEmptyFiloStub();
  vaultStore.setPath('/vault');
  boardCacheStore.clear();
  boardStore.clearBoard();
  selectionStore.clear();
});

afterEach(() => {
  vaultStore.setPath('');
  boardCacheStore.clear();
  boardStore.clearBoard();
  selectionStore.clear();
});

describe('connection selection + delete (Phase C / C.4)', () => {
  it('selectConnection (additive=false) replaces the selection set', () => {
    activate();
    selectionStore.selectConnection('c1');
    selectionStore.selectConnection('c2'); // not additive
    expect([...selectionStore.selectedConnectionIds]).toEqual(['c2']);
  });

  it('selectConnection (additive=true) adds to the existing selection', () => {
    activate();
    selectionStore.selectConnection('c1');
    selectionStore.selectConnection('c2', true);
    expect([...selectionStore.selectedConnectionIds].sort()).toEqual(['c1', 'c2']);
  });

  it('DeleteConnectionCommand removes the connection and undo restores it', () => {
    activate();
    boardStore.addConnection(makeConnection('c1'));
    expect(boardStore.connections['c1']).toBeDefined();
    const cmd = new DeleteConnectionCommand('c1');
    cmd.execute();
    expect(boardStore.connections['c1']).toBeUndefined();
    cmd.undo();
    expect(boardStore.connections['c1']).toBeDefined();
  });

  it('iterating selectedConnectionIds and dispatching DeleteConnectionCommand removes them all', () => {
    activate();
    boardStore.addConnection(makeConnection('c1'));
    boardStore.addConnection(makeConnection('c2'));
    selectionStore.selectConnection('c1');
    selectionStore.selectConnection('c2', true);

    for (const id of [...selectionStore.selectedConnectionIds]) {
      new DeleteConnectionCommand(id).execute();
    }
    selectionStore.clearConnections();

    expect(boardStore.connections['c1']).toBeUndefined();
    expect(boardStore.connections['c2']).toBeUndefined();
    expect(selectionStore.selectedConnectionIds.size).toBe(0);
  });

  it('clear() drops both tile and connection selections', () => {
    activate();
    selectionStore.select('t_a');
    selectionStore.selectConnection('c1');
    selectionStore.clear();
    expect(selectionStore.selectedIds.size).toBe(0);
    expect(selectionStore.selectedConnectionIds.size).toBe(0);
  });
});

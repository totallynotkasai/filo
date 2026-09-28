import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { DeleteTilesCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Connection, MindMapBoard, TextTile, Tile } from '@renderer/schema/index';
import { seedBoard } from '../helpers/seedBoard';

/**
 * Audit 4.1 — `DeleteTilesCommand.undo()` re-adds the connections it
 * snapshotted (routing same-board edges through `boardStore.addConnection`
 * and other-board edges through `boardCacheStore.persistAddConnection`).
 * `execute()` / redo, however, only loops `boardStore.removeTile(...)` and
 * relies on each removeTile's cache-side connection sweep. That sweep only
 * touches the tile's OWN board cache (see `core/boardTileOps/mindmap.ts`),
 * so a connection that lives in a DIFFERENT board's cache while referencing
 * a deleted tile is never removed by execute — it survives delete → undo →
 * redo as a dangling edge in the inactive board's `.board.json`.
 *
 * Repro: tile `t1` on the active board `mm`; an edge `c1` parked in the
 * inactive board `mm2`'s cache (boardId `mm2`) that references `t1`. Deleting
 * `t1` must leave no `c1` in `mm2`'s cache after the redo.
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeRoute>): void {
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

function makeTextTile(id: string, title: string, boardId: string): TextTile {
  return {
    id,
    boardId,
    type: 'text',
    title,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {
      headerColor: '#fff', bodyColor: '#fff', borderColor: '#000',
      shape: 'rounded', borderStyle: 'solid', borderWidth: 1, shadowIntensity: 0.3,
    } as never,
    tags: [],
    locked: false,
    faded: false,
    filePath: `${title}.md`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TextTile;
}

function makeConnection(
  id: string,
  boardId: string,
  fromTileId: string,
  toTileId: string,
): Connection {
  return {
    id,
    boardId,
    fromTileId,
    toTileId,
    fromBubble: 3,
    toBubble: 7,
    pathColor: '',
    arrowColor: '',
    visibility: 'visible',
    labelVisibility: 'visible',
    label: { text: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Connection;
}

function makeMindMapFixture(
  boardId: string,
  name: string,
  tiles: Record<string, TextTile>,
  connections: Record<string, Connection> = {},
): BoardFileData {
  const placements: Record<string, unknown> = {};
  for (const id of Object.keys(tiles)) {
    placements[id] = { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false };
  }
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements,
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: tiles as unknown as BoardFileData['tileDefs'],
    connections: connections as unknown as BoardFileData['connections'],
    frames: [],
  };
}

describe('DeleteTilesCommand — cross-board connection redo (audit 4.1)', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
    installFiloStub({
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'vault:file-exists': async () => false,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
  });

  it('redo re-removes a cross-board connection that undo restored', () => {
    const t1 = makeTextTile('t1', 'Active tile', 'mm');
    const tB = makeTextTile('tB', 'Other-board tile', 'mm2');
    // c1 lives in the INACTIVE board mm2's cache but references t1 (on the
    // active board mm). This is the shape the command's all-boards snapshot
    // scan is built to capture and restore per-board.
    const c1 = makeConnection('c1', 'mm2', 't1', 'tB');

    const fixtureMm = makeMindMapFixture('mm', 'Map', { t1 });
    const fixtureMm2 = makeMindMapFixture('mm2', 'Map 2', { tB }, { c1 });

    boardCacheStore.hydrate(
      { mm: fixtureMm, mm2: fixtureMm2 },
      { mm: 'mm.board.json', mm2: 'mm2.board.json' },
    );
    seedBoard(boardStore, fixtureMm.board, { t1: t1 as unknown as Tile }, {}, []);

    // Sanity: the edge starts parked in mm2's cache.
    expect(boardCacheStore.cache.mm2.connections.c1).toBeDefined();

    const cmd = new DeleteTilesCommand(['t1']);

    cmd.execute(); // delete
    cmd.undo(); // restore — re-adds c1 into mm2's cache
    // After undo the cross-board edge is back (its endpoints both exist again).
    expect(boardCacheStore.cache.mm2.connections.c1).toBeDefined();

    cmd.execute(); // redo

    // The redo deleted t1 again, so the edge referencing it must be gone from
    // the inactive board's cache — otherwise mm2.board.json persists a
    // dangling connection.
    expect(boardCacheStore.cache.mm2.connections.c1).toBeUndefined();
  });
});

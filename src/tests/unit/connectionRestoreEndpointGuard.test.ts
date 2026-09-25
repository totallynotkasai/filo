import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { CascadeDeleteCommand, DeleteTilesCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile, Connection } from '@renderer/schema/index';

/**
 * DI-2 (2026-05-29) — connection-restore must not resurrect a dangling edge.
 *
 * When undo re-adds the connections that were snapshotted at delete time, an
 * endpoint tile may have been independently deleted in the interim (e.g. a
 * tile outside a cascade-deleted frame removed by a later action). Re-adding
 * the connection would leave it pointing at a tile that no longer exists.
 * Both restore sites — `DeleteTilesCommand.undo` and `CascadeDeleteCommand.undo`
 * — now skip-and-warn a connection whose `fromTileId` / `toTileId` is absent
 * from the (post-tile-restore) cache, while still restoring connections whose
 * endpoints all survive.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeConn(id: string, from: string, to: string): Connection {
  return {
    id,
    boardId: 'mm',
    fromTileId: from,
    toTileId: to,
    fromBubble: 0,
    toBubble: 0,
    pathColor: '',
    arrowColor: '',
    visibility: 'visible',
    labelVisibility: 'visible',
    label: { text: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
    createdAt: 0,
    updatedAt: 0,
  } as Connection;
}

function makeBoard(tileIds: string[], connections: Connection[]): BoardFileData {
  const placements: Record<string, unknown> = {};
  const tileDefs: Record<string, unknown> = {};
  for (const id of tileIds) {
    placements[id] = { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false };
    tileDefs[id] = {
      id,
      type: 'text',
      title: id,
      style: { headerColor: '', bodyColor: '', borderColor: '' },
      boardId: 'mm',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      locked: false,
      faded: false,
      filePath: `${id}.md`,
    };
  }
  const connRecord: Record<string, Connection> = {};
  for (const c of connections) connRecord[c.id] = c;
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements,
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: tileDefs as unknown as BoardFileData['tileDefs'],
    connections: connRecord,
    frames: [],
  };
}

/** Drains the async tail of `persistAddTile` so cache mutations settle. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function hydrateActive(fixture: BoardFileData): Record<string, Tile> {
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'mm.board.json' });
  const tiles = boardCacheStore.getFullTilesForBoard('mm');
  boardStore.setBoard(fixture.board, tiles, fixture.connections, []);
  return tiles;
}

describe('DI-2 — connection-restore endpoint guard', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    // Empty vault path skips persistAddTile's text-tile file-exists IPC branch
    // (same rationale as cascadeDeleteCommand.test.ts) — the cache-level
    // assertions don't need the backing file to exist.
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vi.spyOn(uiStore, 'toast').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('CascadeDeleteCommand.undo skips a connection whose endpoint was independently removed', async () => {
    const dangling = makeConn('c_dangling', 't1', 't2');
    const ok = makeConn('c_ok', 't1', 't3');
    const fixture = makeBoard(['t1', 't2', 't3'], [dangling, ok]);
    const tiles = hydrateActive(fixture);

    // Cascade-delete t1 (and, via the snapshot, both connections that touch it).
    const cmd = new CascadeDeleteCommand({ mm: [tiles.t1] }, [dangling, ok]);
    cmd.execute();
    expect(boardCacheStore.cache.mm.tileDefs.t1).toBeUndefined();
    // Removing t1 stripped both incident connections from the cache.
    expect(boardCacheStore.cache.mm.connections.c_dangling).toBeUndefined();
    expect(boardCacheStore.cache.mm.connections.c_ok).toBeUndefined();

    // Independently remove t2 — the surviving endpoint of the dangling edge.
    boardStore.removeTile('t2');
    expect(boardCacheStore.cache.mm.tileDefs.t2).toBeUndefined();

    await cmd.undo();
    await flushAsync();

    // t1 came back; the dangling edge did NOT; the still-valid edge did.
    expect(boardCacheStore.cache.mm.tileDefs.t1).toBeDefined();
    expect(boardCacheStore.cache.mm.connections.c_dangling).toBeUndefined();
    expect(boardCacheStore.cache.mm.connections.c_ok).toBeDefined();
  });

  it('DeleteTilesCommand.undo skips a connection whose endpoint no longer exists', async () => {
    const dangling = makeConn('c_dangling', 't1', 't2');
    const fixture = makeBoard(['t1', 't2'], [dangling]);
    hydrateActive(fixture);

    // Snapshot captures t1 + the connection that references it.
    const cmd = new DeleteTilesCommand(['t1']);
    cmd.execute();
    expect(boardCacheStore.cache.mm.tileDefs.t1).toBeUndefined();
    expect(boardCacheStore.cache.mm.connections.c_dangling).toBeUndefined();

    // Independently remove the other endpoint before undo.
    boardStore.removeTile('t2');

    await cmd.undo();
    await flushAsync();

    expect(boardCacheStore.cache.mm.tileDefs.t1).toBeDefined();
    expect(boardCacheStore.cache.mm.connections.c_dangling).toBeUndefined();
  });

  it('DeleteTilesCommand.undo restores a connection when both endpoints survive', async () => {
    const ok = makeConn('c_ok', 't1', 't2');
    const fixture = makeBoard(['t1', 't2'], [ok]);
    hydrateActive(fixture);

    const cmd = new DeleteTilesCommand(['t1']);
    cmd.execute();
    expect(boardCacheStore.cache.mm.connections.c_ok).toBeUndefined();

    // t2 survives — undo should bring the edge back.
    await cmd.undo();
    await flushAsync();

    expect(boardCacheStore.cache.mm.tileDefs.t1).toBeDefined();
    expect(boardCacheStore.cache.mm.connections.c_ok).toBeDefined();
  });
});

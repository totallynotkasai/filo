import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  __testRegisterFlusher as registerMarkdownFlusher,
  __resetMarkdownFileWriterForTests as __resetMarkdownFlushersForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type V7BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, ImageTile, Tile } from '@renderer/schema/index';

/**
 * Phase 8.2 + 8.3 (P1-3 + P1-4) integration: `vaultStore.rename` must
 *
 *   1. drain every registered markdown flusher BEFORE issuing the
 *      `vault:rename` IPC, so a debounced editor write armed against
 *      the OLD path lands on disk before the file moves — otherwise
 *      the write either races the atomic rename (Windows EBUSY) or
 *      resurrects the old file after the rename completes; and
 *   2. apply the in-memory `boardStore.propagateRename` cascade BEFORE
 *      the IPC, then REVERT the cascade if the IPC fails — so the cache
 *      never lingers in a half-renamed state pointing at a file that
 *      doesn't exist on disk.
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;
type InvokeRecord = { channel: string; args: unknown[]; orderIndex: number };

function installFiloStub(routes: Record<string, InvokeRoute>): InvokeRecord[] {
  const calls: InvokeRecord[] = [];
  let counter = 0;
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args, orderIndex: counter++ });
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
  return calls;
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

function makeImageBoardFixture(srcPath: string): V7BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'MM',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        i1: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      i1: {
        id: 'i1',
        type: 'image',
        title: 'Photo',
        src: srcPath,
        style: {} as never,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      } as never,
    },
    connections: {},
    frames: [],
  };
}

function makeImageRuntimeTile(srcPath: string): Tile {
  return {
    id: 'i1',
    boardId: 'mm',
    type: 'image',
    title: 'Photo',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {
      headerColor: '#fff',
      bodyColor: '#fff',
      borderColor: '#000',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    tags: [],
    locked: false,
    faded: false,
    src: srcPath,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as ImageTile as Tile;
}

describe('vaultStore.rename — Phase 8 transactional flow', () => {
  beforeEach(() => {
    uninstallFiloStub();
    __resetMarkdownFlushersForTests();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    cancelAllPendingWrites();
    uninstallFiloStub();
    __resetMarkdownFlushersForTests();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
  });

  it('drains markdown flushers BEFORE the vault:rename IPC fires', async () => {
    let flushOrder = -1;
    let renameOrder = -1;
    let counter = 0;

    const calls = installFiloStub({
      'vault:rename': async () => {
        renameOrder = counter++;
        return { success: true };
      },
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => null,
      'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
    });

    registerMarkdownFlusher('text-tile:t1', async () => {
      flushOrder = counter++;
    });

    const result = await vaultStore.rename('/vault/photo.jpg', '/vault/renamed.jpg');

    expect(result.success).toBe(true);
    expect(flushOrder).toBeGreaterThanOrEqual(0);
    expect(renameOrder).toBeGreaterThan(flushOrder);
    expect(calls.find((c) => c.channel === 'vault:rename')).toBeDefined();
  });

  it('on IPC failure, reverts the in-memory propagateRename cascade', async () => {
    installFiloStub({
      'vault:rename': async () => ({ success: false, code: 'EACCES' }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => null,
      'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
    });

    const oldRel = 'photo.jpg';
    const fixture = makeImageBoardFixture(oldRel);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'mm.board.json' });
    boardStore.setBoard(fixture.board, { i1: makeImageRuntimeTile(oldRel) }, {}, []);

    expect((boardStore.cache.mm.tileDefs.i1 as { src?: string }).src).toBe(oldRel);

    const result = await vaultStore.rename('/vault/photo.jpg', '/vault/renamed.jpg');

    expect(result.success).toBe(false);
    expect(result.code).toBe('EACCES');
    // Cache must be back to the old path — the cascade was reverted.
    expect((boardStore.cache.mm.tileDefs.i1 as { src?: string }).src).toBe(oldRel);
    expect((boardStore.tiles.i1 as { src?: string }).src).toBe(oldRel);
  });

  it('on IPC success, the propagateRename cascade lands in the cache (forward direction)', async () => {
    installFiloStub({
      'vault:rename': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => null,
      'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
    });

    const oldRel = 'photo.jpg';
    const newRel = 'renamed.jpg';
    const fixture = makeImageBoardFixture(oldRel);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'mm.board.json' });
    boardStore.setBoard(fixture.board, { i1: makeImageRuntimeTile(oldRel) }, {}, []);

    const result = await vaultStore.rename('/vault/photo.jpg', '/vault/renamed.jpg');

    expect(result.success).toBe(true);
    expect((boardStore.cache.mm.tileDefs.i1 as { src?: string }).src).toBe(newRel);
    expect((boardStore.tiles.i1 as { src?: string }).src).toBe(newRel);
  });

  it('Phase 22 M10 — multi-board cascade revert: every touched board is rolled back, not just the active one', async () => {
    installFiloStub({
      'vault:rename': async () => ({ success: false, code: 'EACCES' }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => null,
      'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
    });

    const oldRel = 'photo.jpg';
    // Two boards both referencing the same image — only the first is active,
    // but the cascade mutates both. Pre-Phase-22 the inverse-only revert
    // could leave the inactive board half-mutated when the inverse threw;
    // the snapshot-based revert restores every entry unconditionally.
    const fixtureA: V7BoardFileData = makeImageBoardFixture(oldRel);
    const fixtureB: V7BoardFileData = makeImageBoardFixture(oldRel);
    (fixtureB.board as { id: string }).id = 'mm-b';
    (fixtureB.tileDefs.i1 as { id: string }).id = 'i1-b';
    fixtureB.tileDefs['i1-b'] = fixtureB.tileDefs.i1 as never;
    delete (fixtureB.tileDefs as Record<string, unknown>).i1;
    (fixtureB.board as MindMapBoard).placements = {
      'i1-b': { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
    } as never;

    boardCacheStore.hydrate(
      { mm: fixtureA, 'mm-b': fixtureB },
      { mm: 'a.board.json', 'mm-b': 'b.board.json' },
    );
    // Active board is `mm`. `mm-b` is in the cache but not the active runtime.
    boardStore.setBoard(fixtureA.board, { i1: makeImageRuntimeTile(oldRel) }, {}, []);

    const result = await vaultStore.rename('/vault/photo.jpg', '/vault/renamed.jpg');

    expect(result.success).toBe(false);
    // Active board cache + runtime restored.
    expect((boardStore.cache.mm.tileDefs.i1 as { src?: string }).src).toBe(oldRel);
    expect((boardStore.tiles.i1 as { src?: string }).src).toBe(oldRel);
    // Inactive board's cache also restored — the snapshot revert covers
    // every board the forward cascade touched.
    expect((boardStore.cache['mm-b'].tileDefs['i1-b'] as { src?: string }).src).toBe(oldRel);
  });

  it('flusher that throws blocks the rename and surfaces an IO_ERROR', async () => {
    // Phase R2 — `vaultStore.rename` now wraps the cascade in
    // `withDrainedWrites`. A flusher that throws is reported in
    // `flushAllMarkdownWriters().failed[]`, which causes the drain to
    // throw `PendingWritesFailedError` BEFORE the IPC issues. The
    // rename helper catches that and returns `{ success: false, code:
    // 'IO_ERROR' }` so the sidebar caller doesn't optimistically remove
    // the source row from the tree.
    //
    // Replaces the pre-R2 "log and continue" behaviour — proceeding
    // with the rename while the flusher's write was guaranteed to fail
    // produced silent data loss when the editor's debounce content
    // never reached disk under either the OLD or NEW path.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    installFiloStub({
      'vault:rename': async () => ({ success: true }),
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
      'board:save': async () => null,
      'shell:path-join': async (...segs: unknown[]) => (segs as string[]).join('/'),
    });

    registerMarkdownFlusher('text-tile:doomed', async () => {
      throw new Error('flush failed');
    });

    const result = await vaultStore.rename('/vault/a.md', '/vault/b.md');

    // Drain failure short-circuits the rename — the IPC is never issued.
    expect(result.success).toBe(false);
    expect(result.code).toBe('IO_ERROR');
    consoleError.mockRestore();
  });
});

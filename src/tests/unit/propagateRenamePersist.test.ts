import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile, ImageTile } from '@renderer/schema/index';
import { seedBoard } from '../helpers/seedBoard';

/**
 * Regression: `boardStore.propagateRename` patches the active board's runtime
 * `tiles` proxy after the cache-side rewrite. The cache's `markDirty` already
 * fires inside `boardCacheStore.propagateRename`, but the active-board proxy
 * mutation is a separate `$state` reference per the project's proxy-pattern
 * invariant — without an explicit `boardCacheStore.touchBoard(boardId)` the
 * runtime mutation could land in memory while the dirty flag rolled off.
 *
 * This test exercises the full pipeline:
 *   1. Hydrate the cache with a board that holds a tile pointing at the old path.
 *   2. Activate the board via `setBoard`.
 *   3. Call `boardStore.propagateRename(oldRel, newRel)`.
 *   4. Advance the fake timer past the 300ms board-write debounce.
 *   5. Assert `board:save` IPC was called with a payload that mentions the
 *      new path and does NOT mention the old path — proof that the rewritten
 *      tileDefs actually reached disk through the scheduled write.
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type InvokeRecord = { channel: string; args: unknown[] };

function installFiloStub(routes: Record<string, InvokeHandler>): InvokeRecord[] {
  const calls: InvokeRecord[] = [];
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
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

function makeImageBoardFixture(srcPath: string): BoardFileData {
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

describe('boardStore.propagateRename — persists rewritten paths through the debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    uninstallFiloStub();
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    cancelAllPendingWrites();
    vi.useRealTimers();
    uninstallFiloStub();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
  });

  it('rewrites image src in the on-disk payload after the 300ms debounce', async () => {
    const calls = installFiloStub({
      'board:save': async () => null,
      'vault:write-file-text': async () => null,
      'vault:delete': async () => null,
      'shell:path-join': async (...segs: unknown[]) =>
        (segs as string[]).join('/'),
    });

    const oldRel = 'attachments/i1/photo.jpg';
    const newRel = 'attachments/i1/renamed.jpg';
    const fixture = makeImageBoardFixture(oldRel);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'mm.board.json' });
    seedBoard(boardStore, fixture.board, { i1: makeImageRuntimeTile(oldRel) }, {}, []);

    // Sanity: the cache holds the old path before the rename.
    expect(
      (boardStore.cache.mm.tileDefs.i1 as { src?: string }).src,
    ).toBe(oldRel);

    const changed = boardStore.propagateRename(oldRel, newRel);
    expect(changed).toContain('mm');

    // Cache was rewritten immediately by the cache-side propagation.
    expect(
      (boardStore.cache.mm.tileDefs.i1 as { src?: string }).src,
    ).toBe(newRel);
    // Active runtime tile was patched to match.
    expect((boardStore.tiles.i1 as { src?: string }).src).toBe(newRel);

    // Drain the 300ms board-write debounce and any awaited microtasks the
    // write pipeline schedules inside its .then handlers.
    await vi.advanceTimersByTimeAsync(500);

    const boardSaveCalls = calls.filter((c) => c.channel === 'board:save');
    expect(boardSaveCalls.length).toBeGreaterThanOrEqual(1);

    // The last save payload must reflect the rewritten path.
    const lastPayload = boardSaveCalls[boardSaveCalls.length - 1].args[2] as string;
    expect(lastPayload).toContain(newRel);
    expect(lastPayload).not.toContain(oldRel);

    // The IPC was targeted at the right board file.
    expect(boardSaveCalls[0].args[0]).toBe('/vault');
    expect(boardSaveCalls[0].args[1]).toBe('mm.board.json');
  });

  it('non-active board: cache-side rewrite still flushes via the debounce', async () => {
    const calls = installFiloStub({
      'board:save': async () => null,
      'vault:write-file-text': async () => null,
      'vault:delete': async () => null,
      'shell:path-join': async (...segs: unknown[]) =>
        (segs as string[]).join('/'),
    });

    const oldRel = 'attachments/k1/cover.png';
    const newRel = 'attachments/k1/renamed.png';

    // Hydrate one board with the reference but don't activate it.
    const fixture = makeImageBoardFixture(oldRel);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'mm.board.json' });
    // currentBoard is null — runtime patch branch is skipped, only the
    // cache-side markDirty drives the eventual disk write.

    const changed = boardStore.propagateRename(oldRel, newRel);
    expect(changed).toContain('mm');

    await vi.advanceTimersByTimeAsync(500);

    const boardSaveCalls = calls.filter((c) => c.channel === 'board:save');
    expect(boardSaveCalls.length).toBeGreaterThanOrEqual(1);
    const lastPayload = boardSaveCalls[boardSaveCalls.length - 1].args[2] as string;
    expect(lastPayload).toContain(newRel);
    expect(lastPayload).not.toContain(oldRel);
  });
});

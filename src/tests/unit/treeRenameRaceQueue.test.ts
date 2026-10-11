import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import {
  onError,
  __resetErrorBusForTests,
  type ReportedError,
} from '@renderer/lib/utils/errorBus';

/**
 * Verifies the rename queue serialises `vault:tree-updated`
 * + `vault:file-renamed` arrivals. An external `git mv` burst can produce
 * both events in the same tick; without queue ordering, the tree reconcile
 * runs before the rename handler rebinds `boardPaths`, sees the renamed
 * board as "missing", and calls `cleanupMissingBoard` — evicting the
 * board from the project. The queue forces the rename rebind to land
 * before any reconcile gets to walk `boardStore.paths`.
 */

function makeMindMap(boardId: string): BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: boardId,
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

describe('tree-updated vs file-renamed race', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
    vaultStore.setTree([]);
    __resetRenameCascadeSentinelForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreFiloDefault();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    vaultStore.setTree([]);
    __resetRenameCascadeSentinelForTests();
    vi.restoreAllMocks();
  });

  it('serialises rename + tree-update so the renamed board stays in paths', async () => {
    // Set up a single board mapped at the OLD path on disk.
    const a = makeMindMap('a');
    boardCacheStore.hydrate({ a }, { a: 'board.board.json' });

    // Simulate the file tree state AFTER the OS rename has landed but
    // BEFORE Filo's in-memory cache caught up. The tree contains
    // `Sub/board.board.json` (new), but boardStore.paths still says
    // `board.board.json` (old). A reconcile in this state would see the
    // mapped path as "missing" and call cleanupMissingBoard.
    vaultStore.setTree([
      {
        path: '/vault/Sub',
        name: 'Sub',
        isDirectory: true,
        children: [
          { path: '/vault/Sub/board.board.json', name: 'board.board.json', isDirectory: false },
        ],
      },
    ]);

    installFiloMock({
      'vault:read-tree': () => ({ ok: true, tree: vaultStore.rawTree }),
      'vault:read-file-text': () => ({ success: false, code: 'ENOENT' }),
      'vault:write-file-text': () => ({ success: true }),
      'vault:delete': () => ({ success: true }),
    });

    // Fire BOTH operations onto the shared queue in the order the IPC
    // bridge would produce them (rename first, tree-updated second), then
    // await the joint settlement.
    const renamePromise = vaultStore.enqueueRenameQueueWork(() =>
      vaultStore.handleExternalRename('board.board.json', 'Sub/board.board.json'),
    );
    const reconcilePromise = vaultStore.enqueueRenameQueueWork(() =>
      vaultStore.refreshTreeAndCleanup(),
    );

    await renamePromise;
    await reconcilePromise;

    // The renamed board must still be in the project.
    expect(boardCacheStore.paths.a).toBe('Sub/board.board.json');
    // (`cleanupMissingBoard` evicts; survival check is the contract.)
    expect('a' in boardCacheStore.cache).toBe(true);
  });

  it('does NOT evict the renamed board even when tree-update is enqueued first', async () => {
    // Inverse arrival order: tree-updated arrives BEFORE file-renamed in
    // the IPC queue. The serial queue guarantees both run in order, but
    // the dangerous case is when the tree handler reads `boardStore.paths`
    // before the rename handler has had a chance to rebind. With the
    // queue, the reconcile fully completes before the rename runs, so
    // cleanupMissingBoard correctly sees the OLD path on disk AND in
    // boardStore.paths — match, no eviction.
    const a = makeMindMap('a');
    boardCacheStore.hydrate({ a }, { a: 'board.board.json' });

    // Tree still shows the OLD path (the watcher fires tree-updated
    // before fs settles into the new shape on some platforms).
    vaultStore.setTree([
      { path: '/vault/board.board.json', name: 'board.board.json', isDirectory: false },
    ]);

    installFiloMock({
      'vault:read-tree': () => ({ ok: true, tree: vaultStore.rawTree }),
      'vault:read-file-text': () => ({ success: false, code: 'ENOENT' }),
      'vault:write-file-text': () => ({ success: true }),
      'vault:delete': () => ({ success: true }),
    });

    const reconcilePromise = vaultStore.enqueueRenameQueueWork(() =>
      vaultStore.refreshTreeAndCleanup(),
    );
    const renamePromise = vaultStore.enqueueRenameQueueWork(() =>
      vaultStore.handleExternalRename('board.board.json', 'Sub/board.board.json'),
    );

    await reconcilePromise;
    await renamePromise;

    expect(boardCacheStore.paths.a).toBe('Sub/board.board.json');
    expect('a' in boardCacheStore.cache).toBe(true);
  });

  it('reconcile runs FIFO: ordering is preserved when multiple operations are queued', async () => {
    const ticks: string[] = [];

    const t1 = vaultStore.enqueueRenameQueueWork(async () => {
      ticks.push('one-start');
      await new Promise((r) => setTimeout(r, 5));
      ticks.push('one-end');
    });
    const t2 = vaultStore.enqueueRenameQueueWork(async () => {
      ticks.push('two-start');
      await new Promise((r) => setTimeout(r, 5));
      ticks.push('two-end');
    });
    const t3 = vaultStore.enqueueRenameQueueWork(async () => {
      ticks.push('three');
    });

    await Promise.all([t1, t2, t3]);

    expect(ticks).toEqual([
      'one-start',
      'one-end',
      'two-start',
      'two-end',
      'three',
    ]);
  });

  // When the listener routes through the rename queue, a failure
  // in the queued task surfaces via reportError with the supplied label.
  // The next enqueued task still runs. Without the label, behaviour is
  // unchanged (caller is responsible for awaiting + handling the rejection).
  it('routes rejected task to reportError when a label is supplied', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: ReportedError[] = [];
    const off = onError((e) => errors.push(e));
    try {
      // First a task that rejects — labelled so the queue reports it.
      const failing = vaultStore
        .enqueueRenameQueueWork(
          async () => {
            throw new Error('rename failed');
          },
          { label: 'vault.testLabel', message: 'Failed in test fixture' },
        )
        .catch(() => undefined);

      // Then a labelless task — should still run, no extra reports.
      let secondRan = false;
      const second = vaultStore.enqueueRenameQueueWork(async () => {
        secondRan = true;
      });

      await failing;
      await second;

      expect(secondRan).toBe(true);
      expect(errors).toHaveLength(1);
      expect(errors[0].context).toBe('vault.testLabel');
    } finally {
      off();
    }
  });

  it('a single failing task does not poison the chain', async () => {
    const ticks: string[] = [];
    const t1 = vaultStore.enqueueRenameQueueWork(async () => {
      ticks.push('one');
    });
    const t2 = vaultStore
      .enqueueRenameQueueWork(async () => {
        throw new Error('boom');
      })
      .catch(() => {
        ticks.push('two-failed');
      });
    const t3 = vaultStore.enqueueRenameQueueWork(async () => {
      ticks.push('three');
    });

    await Promise.all([t1, t2, t3]);

    expect(ticks).toContain('one');
    expect(ticks).toContain('two-failed');
    expect(ticks).toContain('three');
    // Ordering preserved: 'one' before 'two-failed' before 'three'
    expect(ticks.indexOf('one')).toBeLessThan(ticks.indexOf('two-failed'));
    expect(ticks.indexOf('two-failed')).toBeLessThan(ticks.indexOf('three'));
  });
});

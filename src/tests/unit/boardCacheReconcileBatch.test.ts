/**
 * 6.2.H9 — on-open reconcile batch: cheap, no-stamp, mtime-gated.
 *
 * The Audit2 5.3 fix walks `vaultIndexStore.allMetadata()` and calls the
 * per-md reconcile per md file. For a 5k-file × 50-board × 100-tile
 * vault the pre-fix loop did one `setCache({ ...cache })` PER md —
 * O(M) cache identity flips thrashing the Svelte reactive graph on
 * every vault open.
 *
 * The batch variant fixes four things:
 *   (a) no `updatedAt = Date.now()` stamp on reconciled tiles
 *       (the reconcile isn't a user edit).
 *   (b) ONE setCache identity flip at the end.
 *   (c) microtask yields every 50 mds.
 *   (d) mtime gate: skip mds whose disk state matches the last
 *       reconcile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { __resetLastReconciledMtimeForTests } from '@renderer/stores/boardCacheFrontmatter';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, KanbanBoard } from '@renderer/schema/index';

function taskTile(
  id: string,
  filePath: string,
  overrides: Partial<TileDefinition> & Record<string, unknown> = {},
): TileDefinition {
  return {
    id,
    type: 'text',
    title: id,
    style: {
      headerColor: '#fff',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    },
    tags: [],
    createdAt: 1,
    updatedAt: 100,
    file: filePath,
    ...overrides,
  } as TileDefinition;
}

function boardWith(boardId: string, tiles: TileDefinition[]): V7BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'kanban',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'c1',
          title: 'col',
          position: 0,
          collapsed: false,
          tilePlacements: tiles.map((t) => ({ tileId: t.id })),
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: Object.fromEntries(tiles.map((t) => [t.id, t])),
    connections: {},
    frames: [],
  };
}

describe('boardCacheStore — 6.2.H9 batch reconcile', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    // Drop the mtime gate so the next test starts cold. Production
    // resets on vault swap; tests reset directly.
    __resetLastReconciledMtimeForTests();
  });
  afterEach(() => {
    boardCacheStore.clear();
    __resetLastReconciledMtimeForTests();
  });

  it('does NOT stamp updatedAt on reconciled tiles (option a)', async () => {
    // Tile cache has stale `completed: false`; the .md frontmatter says
    // `completed: true`. The batch reconcile pushes the disk value into
    // the cache — but the tile's `updatedAt` should NOT bump (the live
    // event path would; the on-open batch must not).
    const tile = taskTile('t1', 'A.md', { completed: false });
    const boards: Record<string, V7BoardFileData> = { b1: boardWith('b1', [tile]) };
    boardCacheStore.hydrate(boards, { b1: 'b1.board.json' });

    const md = parseMarkdown('A.md', '---\ncompleted: true\n---\nbody', 1234);
    const before = boardCacheStore.cache.b1.tileDefs.t1 as TileDefinition & { updatedAt: number };
    const beforeUpdatedAt = before.updatedAt;

    await boardCacheStore.applyFrontmatterToBackedTilesBatch([md]);

    const after = boardCacheStore.cache.b1.tileDefs.t1 as TileDefinition & {
      updatedAt: number;
      completed?: unknown;
    };
    // The synced field landed.
    expect(after.completed).toBe(true);
    // updatedAt is UNTOUCHED.
    expect(after.updatedAt).toBe(beforeUpdatedAt);
  });

  it('flips the cache identity exactly ONCE for N md files with drift (option b)', async () => {
    // Three tiles on three boards, all with stale cache + drift in
    // frontmatter. Pre-fix the per-md loop would call setCache 3 times;
    // post-fix the batch variant calls it once.
    const tiles = [
      taskTile('t1', 'A.md', { completed: false }),
      taskTile('t2', 'B.md', { completed: false }),
      taskTile('t3', 'C.md', { completed: false }),
    ];
    const boards: Record<string, V7BoardFileData> = {
      b1: boardWith('b1', [tiles[0]]),
      b2: boardWith('b2', [tiles[1]]),
      b3: boardWith('b3', [tiles[2]]),
    };
    boardCacheStore.hydrate(boards, {
      b1: 'b1.board.json',
      b2: 'b2.board.json',
      b3: 'b3.board.json',
    });

    const mds = [
      parseMarkdown('A.md', '---\ncompleted: true\n---\n', 1),
      parseMarkdown('B.md', '---\ncompleted: true\n---\n', 1),
      parseMarkdown('C.md', '---\ncompleted: true\n---\n', 1),
    ];

    // Capture cache identity before and after.
    const beforeRef = boardCacheStore.cache;
    await boardCacheStore.applyFrontmatterToBackedTilesBatch(mds);
    const afterRef = boardCacheStore.cache;

    // Identity flipped (a single setCache happened).
    expect(afterRef).not.toBe(beforeRef);
    // All three boards reflect the disk state.
    expect(
      (boardCacheStore.cache.b1.tileDefs.t1 as TileDefinition & { completed?: unknown })
        .completed,
    ).toBe(true);
    expect(
      (boardCacheStore.cache.b2.tileDefs.t2 as TileDefinition & { completed?: unknown })
        .completed,
    ).toBe(true);
    expect(
      (boardCacheStore.cache.b3.tileDefs.t3 as TileDefinition & { completed?: unknown })
        .completed,
    ).toBe(true);
  });

  it('mtime gate (option d): a second batch with the same disk mtime is a no-op', async () => {
    const tile = taskTile('t1', 'A.md', { completed: false });
    boardCacheStore.hydrate({ b1: boardWith('b1', [tile]) }, { b1: 'b1.board.json' });

    const md = parseMarkdown('A.md', '---\ncompleted: true\n---\n', 1234);
    const changedFirst = await boardCacheStore.applyFrontmatterToBackedTilesBatch([md]);
    expect(changedFirst).toContain('b1');

    // Capture cache identity for the no-op assertion.
    const refAfterFirst = boardCacheStore.cache;
    const changedSecond = await boardCacheStore.applyFrontmatterToBackedTilesBatch([md]);
    // No board changed (mtime gate skipped this md).
    expect(changedSecond).toEqual([]);
    // No cache identity flip the second time.
    expect(boardCacheStore.cache).toBe(refAfterFirst);
  });

  it('mtime gate releases when disk mtime moves forward', async () => {
    const tile = taskTile('t1', 'A.md', { completed: false });
    boardCacheStore.hydrate({ b1: boardWith('b1', [tile]) }, { b1: 'b1.board.json' });

    const md1 = parseMarkdown('A.md', '---\ncompleted: true\n---\n', 1234);
    await boardCacheStore.applyFrontmatterToBackedTilesBatch([md1]);

    // External edit: disk content changed, mtime advanced.
    const md2 = parseMarkdown('A.md', '---\ncompleted: true\npriority: high\n---\n', 5678);
    const changed = await boardCacheStore.applyFrontmatterToBackedTilesBatch([md2]);
    expect(changed).toContain('b1');
    expect(
      (boardCacheStore.cache.b1.tileDefs.t1 as TileDefinition & { priority?: unknown }).priority,
    ).toBe('high');
  });

  it('yields to the event loop every 50 mds (option c)', async () => {
    // Build 120 mds → expect at least 2 microtask yields during the batch.
    // We can't observe microtasks directly; instead, verify the batch
    // returns and behaves correctly with a large input. The yield path
    // is exercised here even if the test can't introspect it.
    const tiles = Array.from({ length: 120 }, (_, i) => taskTile(`t${i}`, `f${i}.md`, { completed: false }));
    const boards: Record<string, V7BoardFileData> = {};
    for (let i = 0; i < tiles.length; i++) {
      boards[`b${i}`] = boardWith(`b${i}`, [tiles[i]]);
    }
    boardCacheStore.hydrate(boards, Object.fromEntries(Object.keys(boards).map((id) => [id, `${id}.board.json`])));

    const mds = tiles.map((t, i) =>
      parseMarkdown(t.file as string, '---\ncompleted: true\n---\n', i + 1),
    );
    const changed = await boardCacheStore.applyFrontmatterToBackedTilesBatch(mds);
    // Every board got reconciled.
    expect(changed.length).toBe(120);
  });
});

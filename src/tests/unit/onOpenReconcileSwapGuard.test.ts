import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { __resetLastReconciledMtimeForTests } from '@renderer/stores/boardCacheFrontmatter';
import {
  beginVaultGeneration,
  captureVaultIdentity,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, KanbanBoard } from '@renderer/schema/index';

/**
 * Audit-12 M6 — the on-open FM→cache reconcile batch must not overwrite the new
 * vault's boards if a vault swap lands while it runs.
 *
 * `applyFrontmatterToBackedTilesBatch` captures `ctx.getCache()` once, yields
 * across microtasks, then does a terminal `ctx.setCache({ ...cache })`. The
 * captured cache belongs to the OUTGOING vault; on a swap mid-batch the terminal
 * setCache would inject vault A's boards into vault B. The fix threads the
 * caller's captured `VaultIdentity` and bails (no setCache) after every yield
 * AND before the terminal setCache. Observable: the cache map IDENTITY flips on a
 * proceed (`setCache` ran) and is unchanged on a bail.
 *
 * Real board fixtures (copied from boardCacheReconcileBatch.test.ts) so the
 * reconcile produces a genuine `completed: false → true` change.
 */
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

function completedField(boardId: string, tileId: string): unknown {
  return (boardCacheStore.cache[boardId]?.tileDefs[tileId] as { completed?: unknown }).completed;
}

describe('Audit-12 M6 — on-open reconcile batch bails on a vault swap', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    __resetLastReconciledMtimeForTests();
    __resetVaultIdentityForTests();
  });
  afterEach(() => {
    boardCacheStore.clear();
    __resetLastReconciledMtimeForTests();
    __resetVaultIdentityForTests();
  });

  it('control: reconciles + flips the cache when the vault is unchanged', async () => {
    boardCacheStore.hydrate({ b1: boardWith('b1', [taskTile('t1', 'A.md', { completed: false })]) }, { b1: 'b1.board.json' });
    beginVaultGeneration('/vaultA');
    const identity = captureVaultIdentity();
    const md = parseMarkdown('A.md', '---\ncompleted: true\n---\n', 1234);

    const before = boardCacheStore.cache;
    const changed = await boardCacheStore.applyFrontmatterToBackedTilesBatch([md], identity);

    expect(changed).toContain('b1');
    expect(boardCacheStore.cache).not.toBe(before); // setCache flipped the identity
    expect(completedField('b1', 't1')).toBe(true);
  });

  it('swap landing DURING the batch does not inject the outgoing vault into the new one', async () => {
    // Faithful repro: vault A is open with 60 stale-tile boards. The batch
    // captures vault A's cache, processes ~50 synchronously, then suspends at the
    // i=50 yield. WHILE it's parked, the vault swaps to B (generation bump + the
    // real cache replacement that openVault does). The batch resumes, its
    // post-yield guard sees the swap, and bails before the terminal setCache — so
    // vault A's boards are NOT spread onto vault B's cache.
    const tiles = Array.from({ length: 60 }, (_, i) => taskTile(`t${i}`, `f${i}.md`, { completed: false }));
    const vaultABoards: Record<string, V7BoardFileData> = {};
    for (let i = 0; i < 60; i++) vaultABoards[`b${i}`] = boardWith(`b${i}`, [tiles[i]]);
    boardCacheStore.hydrate(
      vaultABoards,
      Object.fromEntries(Object.keys(vaultABoards).map((id) => [id, `${id}.board.json`])),
    );
    beginVaultGeneration('/vaultA');
    const identity = captureVaultIdentity();
    const mds = tiles.map((t, i) => parseMarkdown(t.file as string, '---\ncompleted: true\n---\n', i + 1));

    // Async fn runs synchronously to its first await (the i=50 yield), then parks.
    const batchPromise = boardCacheStore.applyFrontmatterToBackedTilesBatch(mds, identity);

    // Swap to vault B while the batch is parked: bump generation AND replace the
    // cache with vault B's boards (what `openVault` does).
    beginVaultGeneration('/vaultB');
    boardCacheStore.hydrate(
      { vbBoard: boardWith('vbBoard', [taskTile('vt', 'V.md', { completed: false })]) },
      { vbBoard: 'vbBoard.board.json' },
    );
    const vaultBRef = boardCacheStore.cache;

    const changed = await batchPromise;

    // The outgoing batch bailed — no boards reported, vault B's cache identity is
    // intact, and vault A's boards were NOT injected into vault B.
    expect(changed).toEqual([]);
    expect(boardCacheStore.cache).toBe(vaultBRef);
    expect(boardCacheStore.cache.b0).toBeUndefined();
    expect(boardCacheStore.cache.vbBoard).toBeDefined();
    expect(Object.keys(boardCacheStore.cache)).toEqual(['vbBoard']);
  });

  it('without an identity argument, still reconciles (back-compat — no swap guard)', async () => {
    boardCacheStore.hydrate({ b1: boardWith('b1', [taskTile('t1', 'A.md', { completed: false })]) }, { b1: 'b1.board.json' });
    beginVaultGeneration('/vaultA');
    const md = parseMarkdown('A.md', '---\ncompleted: true\n---\n', 1234);

    const changed = await boardCacheStore.applyFrontmatterToBackedTilesBatch([md]);

    expect(changed).toContain('b1');
    expect(completedField('b1', 't1')).toBe(true);
  });
});

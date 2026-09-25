/**
 * Phase 1 / 1.3 — `cascadeDeleteByVaultPath` must clear a Kanban column's
 * own `coverImage` when the underlying file is deleted, even when that
 * file is referenced ONLY by the column header (no placement covers, no
 * tile content, no frame backgrounds).
 *
 * Pre-fix: `boardFrontmatterSync.cascadeDeleteByVaultPath` gated the
 * apply step on a hand-listed enumeration of style-clear categories that
 * silently missed `columnCoverImage` (added in Sprint C / C23). The
 * branch short-circuited, the cache stayed untouched, and the column
 * carried a dangling reference forward.
 *
 * Post-fix: the gate iterates `Object.values(targets.styleClears)`, so
 * any future style-clear category participates automatically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeKanbanWithColumnCover(
  id: string,
  columnId: string,
  columnCoverImage: string,
): V7BoardFileData {
  return {
    board: {
      id,
      type: 'kanban',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: columnId,
          title: 'To Do',
          position: 0,
          collapsed: false,
          coverImage: columnCoverImage,
          tilePlacements: [],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('cascadeDeleteByVaultPath — Phase 1.3 column coverImage', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('clears a column-only coverImage reference when the underlying file is cascade-deleted', () => {
    const deletedPath = 'attachments/banner.png';
    const kb = makeKanbanWithColumnCover('kb', 'col1', deletedPath);
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });

    // Sanity: the column starts with the reference set.
    const columnsBefore = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((columnsBefore[0] as { coverImage?: string }).coverImage).toBe(deletedPath);
    const cacheBefore = boardCacheStore.cache;

    boardStore.cascadeDeleteByVaultPath(deletedPath);

    // After the cascade the column's coverImage is empty — the bug-fix
    // gate now trips on `columnCoverImage` and `applyCascadeStyleClears`
    // runs as designed.
    const columnsAfter = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((columnsAfter[0] as { coverImage?: string }).coverImage ?? '').toBe('');
    // Cache identity changed (mutator path ran) — proxy for "markDirty
    // fired and the next debounce will persist the cleaned .board.json".
    expect(boardCacheStore.cache).not.toBe(cacheBefore);
  });

  it('still short-circuits cleanly when nothing matches the deleted path', () => {
    // Negative regression — the broadened gate must not start firing on
    // empty cascade plans.
    const kb = makeKanbanWithColumnCover('kb', 'col1', 'attachments/something-else.png');
    boardCacheStore.hydrate({ kb }, { kb: 'kb.board.json' });
    const cacheBefore = boardCacheStore.cache;

    const result = boardStore.cascadeDeleteByVaultPath(
      'attachments/nothing-references-this.png',
    );

    expect(result.removedTileIds).toEqual([]);
    // The column's coverImage survives because the path didn't match.
    const columnsAfter = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((columnsAfter[0] as { coverImage?: string }).coverImage).toBe(
      'attachments/something-else.png',
    );
    // Cache identity preserved — no spurious mutation.
    expect(boardCacheStore.cache).toBe(cacheBefore);
  });
});

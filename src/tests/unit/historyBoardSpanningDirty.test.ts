import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile } from '@renderer/schema/index';

/**
 * Audit 4.2 (REPRODUCE-FIRST) — claim: `historyStore.undo()/redo()` mark only
 * `command.targetBoardId || activeBoardId` dirty, so a board-spanning command
 * (CascadeDeleteCommand, whose `targetBoardId` is `''`) that restores tiles
 * into an INACTIVE board's cache never schedules that board's `.board.json`
 * write — "a restart could lose the cross-board restoration."
 *
 * This test dispatches a cascade through `historyStore` (exercising the exact
 * `dirtyId = command.targetBoardId || activeBoardId` line at
 * history.svelte.ts:442) and proves the on-disk consequence: after undo, the
 * inactive board's write IS scheduled (a `board:save` fires for it, carrying
 * the restored tile).
 *
 * If this passes against unmodified code the lead is refuted: every cache
 * writer already calls `ctx.markDirty(resolvedBoardId)` — tiles
 * (core/boardTileOps/mindmap.ts) and connections (core/boardConnectionsOps.ts)
 * — so the board actually mutated is flagged by the op itself, independent of
 * the history dispatcher's line.
 */

interface SavedBoard {
  path: string;
  data: { tileDefs?: Record<string, unknown> };
}

function installFiloStub(saved: SavedBoard[]): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === 'board:save') {
        saved.push({ path: String(args[1]), data: JSON.parse(String(args[2])) });
        return { ok: true };
      }
      if (channel === 'vault:stat') return { mtimeMs: 1, size: 1 };
      if (channel === 'vault:file-exists') return true;
      if (channel === 'vault:read-tree') return { ok: true, tree: [] };
      if (channel === 'vault:write-file-text') return { success: true };
      return null;
    },
    on: () => () => {},
    send: () => {},
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeMindMap(id: string, tileId: string): BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        [tileId]: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      [tileId]: {
        id: tileId,
        type: 'text',
        title: 'T',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        boardId: id,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
        filePath: `${tileId}.md`,
      },
    },
    connections: {},
    frames: [],
  };
}

describe('history dirty-marking for board-spanning commands (audit 4.2)', () => {
  let saved: SavedBoard[];
  beforeEach(() => {
    saved = [];
    installFiloStub(saved);
    vaultStore.setPath('/v');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    __resetDirtyTrackingForTests();
    vi.spyOn(uiStore, 'toast').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    __resetDirtyTrackingForTests();
  });

  it('cascade undo through historyStore schedules the inactive board write', async () => {
    const a = makeMindMap('a', 't_a');
    const b = makeMindMap('b', 't_b');
    boardCacheStore.hydrate({ a, b }, { a: 'a.board.json', b: 'b.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    const tilesB = boardCacheStore.getFullTilesForBoard('b');
    // a is active; b is inactive.
    boardStore.setBoard(a.board, tilesA, {}, []);
    historyStore.setActiveBoard('a');

    const cmd = new CascadeDeleteCommand(
      { a: [tilesA.t_a as Tile], b: [tilesB.t_b as Tile] },
      [],
    );

    // Dispatch the delete through history (this exercises the markDirty line).
    await historyStore.execute(cmd);
    await flushAsync();
    // Drain the delete's scheduled writes so the second flush only reflects
    // boards the UNDO marked dirty.
    await boardCacheStore.flushAllDirty();
    saved.length = 0;

    // Control: the drain cleared all pending writes, so a redundant flush
    // with no intervening mutation writes nothing. This guarantees any
    // `board:save` observed after the undo below was scheduled BY the undo,
    // not leftover from the delete.
    await boardCacheStore.flushAllDirty();
    expect(saved.length).toBe(0);

    // Undo — restores t_a on the active board and t_b into the inactive
    // board b's cache.
    await historyStore.undo();
    await flushAsync();
    await boardCacheStore.flushAllDirty();

    const savedPaths = saved.map((s) => s.path);
    // The crux: the INACTIVE board's write must have been scheduled by undo.
    expect(savedPaths).toContain('b.board.json');
    // …and it carries the restored tile, so a restart wouldn't lose it.
    const bSave = saved.find((s) => s.path === 'b.board.json');
    expect(bSave?.data.tileDefs?.t_b).toBeDefined();
  });
});

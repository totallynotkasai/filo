import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { BatchCommand, ToggleGroupCommand } from '@renderer/commands/index';
import type { Command } from '@renderer/stores/history.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile, TileGroup } from '@renderer/schema/index';

/**
 * Audit 4.3 (REPRODUCE-FIRST) — claim: a BatchCommand "mixing a whole-array
 * snapshot command (ToggleGroupCommand.replaceGroups) with element-level
 * add/delete can leave the groups array inconsistent with the surviving tiles
 * after a partial rollback." Rated MEDIUM (conf low); a sibling BatchCommand
 * claim was already withdrawn (Appendix A).
 *
 * The plan's own test spec: "Construct a batch (group + tile add) where a
 * later child throws; assert post-rollback groups/tiles are consistent." This
 * test does exactly that — a real `ToggleGroupCommand` (the whole-array
 * snapshot command the claim names) MERGED into an existing group, plus an
 * element-level tile delete, then a child that throws on execute, triggering
 * the FULL rollback. It asserts the post-rollback state is the pre-batch state
 * and that no group references a deleted tile.
 *
 * If this passes against unmodified code the lead is refuted for the scenario
 * described: the groups slice and the tiles slice are independent, and the
 * LIFO rollback restores each correctly (the whole-array snapshot restores the
 * exact pre-batch groups; the element-level undo restores its tile, and the
 * reverse order runs the tile-restore BEFORE the group-restore). The ONLY path
 * to a dangling group→tile reference is a PARTIAL rollback — a child's `undo()`
 * itself throwing — which BatchCommand already surfaces to the user via the
 * D.5 "Inconsistent state" modal (openBatchRollbackFailureModal). That is a
 * documented, surfaced limitation, not the silent corruption the lead implies.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeMindMapFixture(): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        a: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false },
        b: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false },
        c: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
      groups: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      a: { id: 'a', type: 'text', filePath: 'A.md', style: { headerColor: '', bodyColor: '', borderColor: '' }, boardId: 'mm', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, createdAt: 0, updatedAt: 0, locked: false, faded: false },
      b: { id: 'b', type: 'text', filePath: 'B.md', style: { headerColor: '', bodyColor: '', borderColor: '' }, boardId: 'mm', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, createdAt: 0, updatedAt: 0, locked: false, faded: false },
      c: { id: 'c', type: 'text', filePath: 'C.md', style: { headerColor: '', bodyColor: '', borderColor: '' }, boardId: 'mm', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, createdAt: 0, updatedAt: 0, locked: false, faded: false },
    },
    connections: {},
    frames: [],
  };
}

describe('BatchCommand — group (whole-array) + element-level tile op consistency (audit 4.3)', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    // Empty vault path so the element-level re-add's text-tile file-seed
    // branch is skipped (no IPC spin); the group/tile cache assertions don't
    // depend on the backing file.
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

  it('full rollback after a group merge + tile delete leaves groups consistent with surviving tiles', async () => {
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
    const tiles = boardCacheStore.getFullTilesForBoard('mm');
    boardStore.setBoard(fixture.board, tiles, {}, []);

    // Pre-batch: a + b are grouped (g0). c is ungrouped.
    boardStore.groupTiles(['a', 'b']);
    expect(boardStore.groups.length).toBe(1);
    const groupsBefore: TileGroup[] = boardStore.groups.map(
      (g) => ({ ...g, tileIds: [...g.tileIds] }) as TileGroup,
    );

    const snapshotC = boardCacheStore.getFullTilesForBoard('mm').c as Tile;

    // Child 1 (whole-array): group b + c — b is already in g0, so groupTiles
    // MERGES g0 into a new group [a, b, c]. undo() restores the snapshot via
    // replaceGroups (whole-array).
    const groupCmd = new ToggleGroupCommand(['b', 'c'], 'group', groupsBefore, 'mm');
    // Child 2 (element-level): delete c, restorable on undo.
    const deleteC: Command = {
      description: 'delete c',
      targetBoardId: 'mm',
      execute() { boardStore.removeTile('c'); },
      undo() { void boardStore.addTile(snapshotC); },
    };
    // Child 3: throws on execute → triggers full rollback of children 1 + 2.
    const bomb: Command = {
      description: 'bomb',
      targetBoardId: 'mm',
      execute() { throw new Error('bomb threw'); },
      undo() {},
    };

    const batch = new BatchCommand('group-merge + delete + bomb', [groupCmd, deleteC, bomb], 'mm');
    await expect(batch.execute()).rejects.toThrow('bomb threw');
    await flushAsync();

    // Post-rollback === pre-batch: c is back, and the merged group was
    // unwound to the original g0 = [a, b].
    expect(boardStore.getTile('c')).toBeDefined();
    expect(boardStore.getTile('a')).toBeDefined();
    expect(boardStore.getTile('b')).toBeDefined();
    expect(boardStore.groups.length).toBe(1);
    expect([...boardStore.groups[0].tileIds].sort()).toEqual(['a', 'b']);

    // The invariant the lead worries about: no group references a tile that
    // no longer exists.
    for (const g of boardStore.groups) {
      for (const id of g.tileIds) {
        expect(boardStore.getTile(id)).toBeDefined();
      }
    }
  });
});

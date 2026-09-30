import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import { holdBoardMoves, isBoardMoveHeld } from '@renderer/lib/boards/boardMoveHold';
import { boardHasUnsavedWrite } from '@renderer/lib/boards/boardWriteScheduler';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * While an in-app rename moves a board's file, the board's writes wait: a
 * write in that window could recreate the old file after the move, or make
 * the new folder first and turn the move into a name clash. A write that
 * comes due is armed again (still pending); one a save forces out is refused
 * and kept, and written once the move is done.
 */

function makeBoard(id: string): BoardFileData {
  return {
    board: {
      id, type: 'mindmap', name: 'Plan', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      placements: {}, inlineTiles: {}, waypoints: [],
    },
    tileDefs: {},
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
}

describe('a board whose file is being moved', () => {
  let saves: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
    boardCacheStore.hydrate({ b1: makeBoard('b1') }, { b1: 'Kanban 1/Plan.board.json' });
    saves = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'board:save') {
        saves.push(args[1] as string);
        return { ok: true };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 1 };
      return { success: true, ok: true };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetDirtyTrackingForTests();
    boardCacheStore.hydrate({}, {});
    restoreFiloDefault();
  });

  it('a write that comes due during the move waits, still pending, and lands after it', async () => {
    const release = holdBoardMoves(['b1']);
    boardCacheStore.markDirty('b1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toEqual([]);
    expect(boardHasUnsavedWrite('b1')).toBe(true);

    boardCacheStore.renameBoardPath('Kanban 1', 'Plan');
    release();
    expect(isBoardMoveHeld('b1')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toEqual(['Plan/Plan.board.json']);
    expect(boardHasUnsavedWrite('b1')).toBe(false);
  });

  it('a save during the move is refused and kept; the next save after it writes', async () => {
    const release = holdBoardMoves(['b1']);
    boardCacheStore.markDirty('b1');
    const first = await boardCacheStore.flushAllDirty();
    expect(first.failed).toEqual(['Kanban 1/Plan.board.json']);
    expect(saves).toEqual([]);
    expect(boardHasUnsavedWrite('b1')).toBe(true);

    // Still moving: a second save doesn't fire it into the same refusal.
    await boardCacheStore.flushAllDirty();
    expect(saves).toEqual([]);

    release();
    const after = await boardCacheStore.flushAllDirty();
    expect(after.failed).toEqual([]);
    expect(saves).toEqual(['Kanban 1/Plan.board.json']);
  });

  it('holds are counted: the board waits until every move holding it is done', async () => {
    const releaseA = holdBoardMoves(['b1']);
    const releaseB = holdBoardMoves(['b1']);
    releaseA();
    releaseA(); // a second call of the same release changes nothing
    expect(isBoardMoveHeld('b1')).toBe(true);
    releaseB();
    expect(isBoardMoveHeld('b1')).toBe(false);
  });
});

/**
 * Phase A.1 — `boardWriteScheduler` must reset its in-flight tracking on
 * vault swap.
 *
 * Peer schedulers (`configWriteScheduler`, `frontmatterWriteScheduler`,
 * `miscWriteScheduler`, `viewportCache`) all register a reset callback
 * via `registerResetCallback`. `boardWriteScheduler` was the lone
 * holdout: `inFlightBoardWrites` / `inFlightBoardFailures` survived
 * across `resetWriteTracking(oldVaultRoot)`. A new-vault Ctrl+S would
 * then await an old-vault IPC (potentially hanging) and count its
 * outcome against the new vault.
 *
 * The fix adds a `registerResetCallback` at module bottom that clears
 * the pending-timer map and both in-flight sets. The timer-fire
 * .then/.catch handlers also guard against the in-flight tracker being
 * cleared mid-IPC so a late settle doesn't leak the OLD vault's path
 * back into `inFlightBoardFailures`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  flushAllScheduledBoards,
} from '@renderer/lib/boards/boardWriteScheduler';
import {
  resetWriteTracking,
  __resetDirtyTrackingForTests,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { MindMapBoard } from '@renderer/schema/index';

function emptyMindmapBoard(id: string): BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
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

describe('boardWriteScheduler — vault-swap reset (Phase A.1)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    vi.useRealTimers();
  });

  it('clears the pending-timer map on resetWriteTracking', () => {
    vi.useFakeTimers();
    const saveSpy = vi.fn(async () => ({ success: true }));
    installFiloMock({ 'board:save': saveSpy });

    scheduleBoardWrite('A', () => ({
      vaultRoot: '/vault-A',
      boardPath: 'A.board.json',
      cached: emptyMindmapBoard('A'),
    }));

    // Vault swap before the debounce fires.
    resetWriteTracking('/vault-A');

    // Advance past the debounce window. The cancelled timer must not fire.
    vi.advanceTimersByTime(2000);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('post-swap flushAll does not hang on old-vault in-flight IPC', async () => {
    vi.useFakeTimers();

    // Vault A IPC stays pending — never resolves. Without the reset
    // clearing inFlightBoardWrites, flushAll on vault B would
    // Promise.all this tracker promise and hang forever.
    installFiloMock({ 'board:save': () => new Promise(() => {}) });

    scheduleBoardWrite('A', () => ({
      vaultRoot: '/vault-A',
      boardPath: 'A.board.json',
      cached: emptyMindmapBoard('A'),
    }));
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    // Vault swap — drains in-flight tracker.
    resetWriteTracking('/vault-A');

    // Vault B has no pending writes. flushAll must resolve immediately
    // even though vault A's IPC is still hanging.
    const flushPromise = flushAllScheduledBoards(() => null);
    const result = await Promise.race([
      flushPromise,
      new Promise<never>((_, rej) =>
        setTimeout(
          () =>
            rej(new Error('flushAll hung — reset did not clear in-flight map')),
          250,
        ),
      ),
    ]);
    expect(result.failed).toEqual([]);
  });

  it('old-vault IPC rejection after swap does not surface on new vault', async () => {
    // Scenario: vault A's write is in-flight when the user swaps to
    // vault B. Vault A's IPC then rejects (e.g. assertActiveVault
    // bounces it because the renderer is no longer attached to that
    // vault). Without the .then/.catch tracker guard, that rejection
    // would `inFlightBoardFailures.add('A.board.json')` and pollute
    // vault B's tracking state.
    vi.useFakeTimers();

    let rejectA!: (err: unknown) => void;
    const ipcA = new Promise<unknown>((_, rej) => {
      rejectA = rej;
    });
    installFiloMock({ 'board:save': () => ipcA });

    scheduleBoardWrite('A', () => ({
      vaultRoot: '/vault-A',
      boardPath: 'A.board.json',
      cached: emptyMindmapBoard('A'),
    }));
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    // Vault swap. The reset callback clears inFlightBoardWrites and
    // inFlightBoardFailures.
    resetWriteTracking('/vault-A');

    // Old IPC rejects AFTER the swap — without the .catch guard, this
    // would re-add 'A.board.json' to inFlightBoardFailures.
    rejectA(new Error('vault A bounced after swap'));
    // Drain microtasks so the .catch chain completes.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Vault B: schedule a write with the SAME boardPath. With the bug
    // unfixed, vault B's in-flight entry would look up 'A.board.json'
    // in inFlightBoardFailures, find vault A's stale entry, and surface
    // it as a phantom failure.
    let resolveB!: (val: unknown) => void;
    const ipcB = new Promise<unknown>((res) => {
      resolveB = res;
    });
    installFiloMock({ 'board:save': () => ipcB });

    vi.useFakeTimers();
    scheduleBoardWrite('B', () => ({
      vaultRoot: '/vault-B',
      boardPath: 'A.board.json',
      cached: emptyMindmapBoard('B'),
    }));
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    // Vault B is in-flight when flushAll runs.
    const flushPromise = flushAllScheduledBoards(() => null);

    // Resolve vault B's IPC successfully.
    resolveB({ success: true });

    const result = await flushPromise;
    expect(result.failed).toEqual([]);
  });
});

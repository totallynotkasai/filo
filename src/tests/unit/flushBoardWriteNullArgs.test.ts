/**
 * Polish phase 1.2 — `flushBoardWrite` must report failure when the
 * caller-supplied `getWriteArgs()` returns null (board cache entry
 * already cleared) or null `vaultRoot` / `boardPath`. The pre-fix
 * branch ended the sentinel with success and fell through to the
 * implicit `{ ok: true }`, swallowing the missed write — so callers
 * like `historyStore.flush()` had no signal to surface a save-error
 * toast.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  flushBoardWrite,
  cancelAllPendingWrites,
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

describe('flushBoardWrite — null-args surfaces failure (polish 1.2)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    vi.useRealTimers();
  });

  it('returns { ok: false } when getWriteArgs() returns null on flush', async () => {
    installFiloMock({ 'board:save': () => ({ success: true }) });

    // Schedule a pending write — getWriteArgs returns a real payload at
    // schedule time so the sentinel + pending entry exist.
    const cached = emptyMindmapBoard('B');
    scheduleBoardWrite('B', () => ({
      vaultRoot: '/vault',
      boardPath: 'B.board.json',
      cached,
    }));

    // Now flush, but simulate the cache-entry-removed race: getWriteArgs
    // returns null because the board was closed mid-debounce.
    const result = await flushBoardWrite('B', () => null);
    expect(result.ok).toBe(false);
  });

  it('returns { ok: false } when getWriteArgs() returns null vaultRoot', async () => {
    installFiloMock({ 'board:save': () => ({ success: true }) });

    const cached = emptyMindmapBoard('C');
    scheduleBoardWrite('C', () => ({
      vaultRoot: '/vault',
      boardPath: 'C.board.json',
      cached,
    }));

    // Partial-null: a cache lookup that returns args with an empty
    // vaultRoot must also surface as a failure.
    const result = await flushBoardWrite('C', () => ({
      vaultRoot: '',
      boardPath: 'C.board.json',
      cached,
    }));
    expect(result.ok).toBe(false);
  });

  it('returns { ok: true } when the pending write succeeds normally', async () => {
    installFiloMock({ 'board:save': () => ({ success: true }) });

    const cached = emptyMindmapBoard('D');
    scheduleBoardWrite('D', () => ({
      vaultRoot: '/vault',
      boardPath: 'D.board.json',
      cached,
    }));

    const result = await flushBoardWrite('D', () => ({
      vaultRoot: '/vault',
      boardPath: 'D.board.json',
      cached,
    }));
    expect(result.ok).toBe(true);
  });
});

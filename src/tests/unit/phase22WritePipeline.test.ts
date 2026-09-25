import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Board writes snapshot the cache at fire time: every change made within the
 * debounce window lands in the one write, and a change made after scheduling
 * is never lost to an earlier snapshot.
 */

function emptyMindmapBoard(id: string, label = 'b'): BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: label,
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

/**
 * Phase C / C.5 supersedes Phase 22 M6 — `scheduleBoardWrite` now snapshots
 * at FIRE TIME (inside the timer callback) rather than at every schedule
 * call. Coalesces N keystrokes within the 300ms debounce window into a
 * single deep-clone instead of N. The Phase 22 race remains closed
 * because the fire-time snapshot is taken synchronously immediately
 * before `writeBoardFile` — no microtask can interleave between
 * `JSON.parse(JSON.stringify(args.cached))` and the call that consumes it.
 *
 * The behavioural consequence: a mutation that lands AFTER the schedule
 * call but BEFORE the timer fires IS reflected on disk (the cache is
 * already the source of truth; the snapshot just captures whatever it
 * holds when the debounce expires).
 */
describe('Phase 22 M6 / Phase C C.5 — scheduleBoardWrite snapshots at fire time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    vi.useRealTimers();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('writes the latest cache state at fire time (was schedule-time before C.5)', async () => {
    let savedPayload: string | null = null;
    installFiloMock({
      'board:save': (..._args: unknown[]) => {
        savedPayload = String(_args[2]);
        return null;
      },
    });

    const live = emptyMindmapBoard('mm', 'before');

    scheduleBoardWrite('mm', () => ({
      vaultRoot: '/vault',
      boardPath: 'mm.board.json',
      cached: live,
    }));

    // Mutate the live proxy AFTER scheduling. Phase C / C.5 — the deferred
    // write now picks this up because the snapshot is taken at fire time.
    (live.board as { name: string }).name = 'after';

    await vi.advanceTimersByTimeAsync(500);

    expect(savedPayload).not.toBeNull();
    const out = JSON.parse(savedPayload!);
    expect(out.board.name).toBe('after');
  });

  it('re-scheduling within the debounce window collapses to a single fire-time snapshot', async () => {
    let savedPayload: string | null = null;
    let savesSeen = 0;
    installFiloMock({
      'board:save': (..._args: unknown[]) => {
        savedPayload = String(_args[2]);
        savesSeen += 1;
        return null;
      },
    });

    const live = emptyMindmapBoard('mm', 'v1');

    scheduleBoardWrite('mm', () => ({
      vaultRoot: '/vault',
      boardPath: 'mm.board.json',
      cached: live,
    }));

    (live.board as { name: string }).name = 'v2';
    scheduleBoardWrite('mm', () => ({
      vaultRoot: '/vault',
      boardPath: 'mm.board.json',
      cached: live,
    }));

    // Mutate again AFTER the second schedule but before the timer fires.
    // Phase C / C.5 — this lands on disk because the snapshot is taken at
    // fire time. (Pre-C.5 Phase 22 M6 would have frozen at the second
    // schedule call's v2.)
    (live.board as { name: string }).name = 'v3';

    await vi.advanceTimersByTimeAsync(500);

    expect(savesSeen).toBe(1);
    expect(savedPayload).not.toBeNull();
    const out = JSON.parse(savedPayload!);
    expect(out.board.name).toBe('v3');
  });
});

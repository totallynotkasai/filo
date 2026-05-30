import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type V7BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import { flushAllScheduledBoards } from '@renderer/lib/boards/boardWriteScheduler';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Phase 40 / 40.5 — regression for `flushAllScheduledBoards` interleaving.
 *
 * The Phase 25 L12 comment claims:
 *   "capture every pending (boardId, args, snapshot) tuple synchronously
 *    upfront before issuing any await."
 *
 * The audit (2026-05-22) wanted this verified — concretely, a cascade-rename
 * (or any other in-memory mutation) that lands MID-FLUSH must not affect the
 * boardPath or snapshot already written for any subsequent board. The
 * regression: a rebound `getWriteArgs` between iterations of the await loop
 * could swap one board's path onto another's payload, corrupting both files.
 *
 * The synchronous capture loop (`for (const [boardId, pending] of
 * pendingBoardWrites.entries())`) freezes both the path returned by
 * `getWriteArgs(boardId)` AND a fresh deep-cloned snapshot of `args.cached`
 * before any `await writeBoardFile(...)` runs. This test asserts that
 * invariant by mutating the getter between iterations and confirming each
 * captured (path, payload) pair is written intact.
 *
 * Phase C / C.5 — the snapshot is now taken at flush time (inside the
 * upfront capture loop), not at schedule time. The "freeze before await"
 * invariant is unchanged; only the moment of the deep-clone shifted.
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type InvokeRecord = { channel: string; args: unknown[] };

function installFiloStub(routes: Record<string, InvokeHandler>): InvokeRecord[] {
  const calls: InvokeRecord[] = [];
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
  return calls;
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

function emptyMindmapBoard(id: string, name: string): V7BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name,
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

describe('flushAllScheduledBoards — captures path + snapshot upfront', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDirtyTrackingForTests();
    uninstallFiloStub();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    vi.useRealTimers();
    __resetDirtyTrackingForTests();
    uninstallFiloStub();
  });

  it('uses the path returned at capture time, not at write time', async () => {
    const calls = installFiloStub({ 'board:save': async () => null });

    const liveA = emptyMindmapBoard('A', 'A');
    const liveB = emptyMindmapBoard('B', 'B');

    // Mutable "live" path map — represents what propagateRename would mutate
    // in the cache between iterations of the await loop.
    const livePaths: Record<string, string> = {
      A: 'A.board.json',
      B: 'B.board.json',
    };
    const livePayloads: Record<string, V7BoardFileData> = { A: liveA, B: liveB };

    function getArgs(boardId: string) {
      const path = livePaths[boardId];
      const cached = livePayloads[boardId];
      if (!path || !cached) return null;
      return { vaultRoot: '/vault', boardPath: path, cached };
    }

    scheduleBoardWrite('A', () => getArgs('A'));
    scheduleBoardWrite('B', () => getArgs('B'));

    // BEFORE calling flush, simulate a propagateRename that swaps B's path
    // AFTER scheduling but BEFORE flush. The capture loop should read the
    // current ("renamed") path, since that is what's true at flush time.
    livePaths.B = 'renamed-B.board.json';

    await flushAllScheduledBoards(getArgs);

    const saves = calls.filter((c) => c.channel === 'board:save');
    expect(saves).toHaveLength(2);

    const targets = saves.map((c) => c.args[1]);
    expect(targets).toContain('A.board.json');
    expect(targets).toContain('renamed-B.board.json');
  });

  it('a path mutation that lands AFTER the synchronous capture loop is ignored', async () => {
    let firstSaveStarted!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => {
      firstSaveStarted = resolve;
    });
    let releaseFirstSave!: () => void;
    const firstSaveRelease = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });

    // The mock blocks the first save until we resolve `firstSaveRelease`. The
    // second save resolves immediately. The mutation happens AFTER capture
    // (during the await) and must NOT be picked up.
    let savesSeen = 0;
    const calls = installFiloStub({
      'board:save': async () => {
        savesSeen += 1;
        if (savesSeen === 1) {
          firstSaveStarted();
          await firstSaveRelease;
        }
        return null;
      },
    });

    const liveA = emptyMindmapBoard('A', 'A');
    const liveB = emptyMindmapBoard('B', 'B');
    const livePaths: Record<string, string> = {
      A: 'A.board.json',
      B: 'B.board.json',
    };
    const livePayloads: Record<string, V7BoardFileData> = { A: liveA, B: liveB };

    function getArgs(boardId: string) {
      const path = livePaths[boardId];
      const cached = livePayloads[boardId];
      if (!path || !cached) return null;
      return { vaultRoot: '/vault', boardPath: path, cached };
    }

    scheduleBoardWrite('A', () => getArgs('A'));
    scheduleBoardWrite('B', () => getArgs('B'));

    // Real timers for the gate-coordination part of the test. Fake timers
    // were only used to suppress the 300 ms debounce; flush bypasses it.
    vi.useRealTimers();

    const flushPromise = flushAllScheduledBoards(getArgs);

    // Wait until the first save is in flight (after the synchronous capture
    // loop has completed), then mutate B's path. The mutation MUST be
    // ignored — the capture happened before this microtask landed.
    await firstSaveGate;
    livePaths.B = 'mutated-mid-flush.board.json';

    // Let the first save resolve so the loop proceeds to B.
    releaseFirstSave();
    await flushPromise;

    const saves = calls.filter((c) => c.channel === 'board:save');
    expect(saves).toHaveLength(2);
    const targets = saves.map((c) => c.args[1]);
    expect(targets).toContain('A.board.json');
    expect(targets).toContain('B.board.json');
    expect(targets).not.toContain('mutated-mid-flush.board.json');
  });

  it('writes the schedule-time snapshot even if the live cache is mutated mid-flush', async () => {
    let firstSaveStarted!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => {
      firstSaveStarted = resolve;
    });
    let releaseFirstSave!: () => void;
    const firstSaveRelease = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });

    let savesSeen = 0;
    const calls = installFiloStub({
      'board:save': async () => {
        savesSeen += 1;
        if (savesSeen === 1) {
          firstSaveStarted();
          await firstSaveRelease;
        }
        return null;
      },
    });

    const liveA = emptyMindmapBoard('A', 'a-schedule-time');
    const liveB = emptyMindmapBoard('B', 'b-schedule-time');

    function getArgs(boardId: string) {
      if (boardId === 'A') {
        return { vaultRoot: '/vault', boardPath: 'A.board.json', cached: liveA };
      }
      if (boardId === 'B') {
        return { vaultRoot: '/vault', boardPath: 'B.board.json', cached: liveB };
      }
      return null;
    }

    scheduleBoardWrite('A', () => getArgs('A'));
    scheduleBoardWrite('B', () => getArgs('B'));

    vi.useRealTimers();

    const flushPromise = flushAllScheduledBoards(getArgs);
    await firstSaveGate;

    // Mutate the live proxy mid-flush — must NOT leak into B's payload.
    (liveB.board as { name: string }).name = 'b-mutated-mid-flush';

    releaseFirstSave();
    await flushPromise;

    const saves = calls.filter((c) => c.channel === 'board:save');
    expect(saves).toHaveLength(2);
    const bSave = saves.find((c) => c.args[1] === 'B.board.json');
    expect(bSave).toBeDefined();
    const bPayload = JSON.parse(String(bSave!.args[2]));
    expect(bPayload.board.name).toBe('b-schedule-time');
  });
});

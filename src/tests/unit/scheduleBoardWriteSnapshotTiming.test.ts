import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Phase C / C.5 — `scheduleBoardWrite` deep-clones the cache at FIRE
 * TIME rather than at every schedule call.
 *
 *  - N keystrokes within the 300ms debounce window now produce a single
 *    deep-clone (previously N clones, each on the full board JSON).
 *  - The on-disk payload reflects whatever the cache holds when the
 *    timer fires — i.e. the user's latest edit, not the state at first
 *    schedule.
 *
 * Pinned via the second invariant: a mutation to the live cache between
 * schedule and fire is reflected on disk. (Path bookkeeping for the
 * sentinel still happens at schedule time; only the JSON payload moved
 * to fire time.)
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

function emptyMindmapBoard(id: string, name: string): BoardFileData {
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

describe('Phase C / C.5 — scheduleBoardWrite snapshots at fire time', () => {
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

  it('writes the latest cache state at fire time, not the schedule-time state', async () => {
    const calls = installFiloStub({ 'board:save': async () => null });

    const live = emptyMindmapBoard('A', 'initial-name');
    const args = { vaultRoot: '/vault', boardPath: 'A.board.json', cached: live };

    // First schedule snapshots conceptually at fire time only — the cache
    // mutation below should be reflected because the timer hasn't fired yet.
    scheduleBoardWrite('A', () => args);

    // Mutate the live cache between schedule and fire (the user types more).
    (live.board as { name: string }).name = 'latest-name';

    // Fire the debounce timer.
    await vi.advanceTimersByTimeAsync(500);

    const saves = calls.filter((c) => c.channel === 'board:save');
    expect(saves).toHaveLength(1);
    const payload = JSON.parse(String(saves[0].args[2]));
    expect(payload.board.name).toBe('latest-name');
  });

  it('coalesces N rapid schedule calls into a single deep-clone at fire time', async () => {
    const calls = installFiloStub({ 'board:save': async () => null });

    const live = emptyMindmapBoard('B', 'name-0');
    const args = { vaultRoot: '/vault', boardPath: 'B.board.json', cached: live };

    // Spy on JSON.stringify to count clones (deep clone uses
    // JSON.parse(JSON.stringify(...))). The cached object holds shallow
    // primitives, so per-call cost dominates regardless of size.
    const stringifySpy = vi.spyOn(JSON, 'stringify');

    // 50 rapid schedule calls within the debounce window — simulates a typing
    // burst on a Kanban card title.
    for (let i = 0; i < 50; i++) {
      (live.board as { name: string }).name = `name-${i}`;
      scheduleBoardWrite('B', () => args);
    }

    // Exactly zero deep-clones should have run during the schedule loop
    // (Phase C / C.5 moved them to fire time).
    expect(stringifySpy).not.toHaveBeenCalled();
    stringifySpy.mockClear();

    // Fire the debounce.
    await vi.advanceTimersByTimeAsync(500);

    const saves = calls.filter((c) => c.channel === 'board:save');
    expect(saves).toHaveLength(1);

    // The single fire produces one deep-clone snapshot + one `board:save`
    // stringify. Spy fires at least twice (clone + stringify for the IPC),
    // but never 50x — the schedule-time clones are gone.
    expect(stringifySpy.mock.calls.length).toBeLessThanOrEqual(4);

    const payload = JSON.parse(String(saves[0].args[2]));
    expect(payload.board.name).toBe('name-49');
  });
});

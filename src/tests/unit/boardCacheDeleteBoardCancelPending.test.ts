import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  scheduleBoardWrite,
  type BoardWriteArgs,
} from '@renderer/lib/boards/boardWriteScheduler';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

/**
 * Phase 1.3 regression — deleteBoard now cancels any pending debounced write
 * BEFORE the delete IPC fires. Previously a 300ms-old write would fire after
 * the main process unlinked the file and resurrect it on disk.
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler> = {}): {
  calls: Array<{ channel: string; args: unknown[] }>;
} {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
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
  return { calls };
}

function makeKanbanFixture(): V7BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('boardCacheStore.deleteBoard cancels pending write', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('does not fire a board:save when the debounce window elapses mid-delete', async () => {
    // Hold board:delete in-flight until we manually resolve it, so the
    // 300ms debounce can fire DURING the await — this is the exact race
    // the resurrection bug exploits.
    let resolveDelete!: () => void;
    const deleteHeld = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });

    const { calls } = installFiloStub({
      'board:save': async () => ({ success: true }),
      'board:delete': async () => {
        await deleteHeld;
        return { success: true };
      },
    });

    boardCacheStore.hydrate(
      { kb: makeKanbanFixture() },
      { kb: 'tasks.board.json' },
    );

    // Schedule a pending board write (300ms debounce).
    scheduleBoardWrite('kb', (): BoardWriteArgs | null => ({
      vaultRoot: '/vault',
      boardPath: 'tasks.board.json',
      cached: boardCacheStore.cache.kb,
    }));

    // Start the delete but DON'T resolve it yet — its `await` is parked.
    const deletePromise = boardCacheStore.deleteBoard('kb');

    // Race window: advance past the 300ms debounce. Without the fix,
    // the scheduled write's setTimeout fires here and board:save is invoked
    // with the doomed board's snapshot.
    await vi.advanceTimersByTimeAsync(500);

    // Now resolve board:delete and let removeBoardFromCache run.
    resolveDelete();
    const deletedOk = await deletePromise;
    expect(deletedOk).toBe(true);

    // Final flush — also covers any stray write scheduled after the cancel.
    await vi.advanceTimersByTimeAsync(500);

    const saveCalls = calls.filter((c) => c.channel === 'board:save');
    expect(saveCalls.length).toBe(0);
  });
});

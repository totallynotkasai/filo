import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  scheduleBoardWrite,
  type BoardWriteArgs,
} from '@renderer/lib/boards/boardWriteScheduler';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

/**
 * deleteBoard writes any pending debounced change BEFORE the board file moves
 * to Filo's trash, so the trashed copy (what Undo brings back) holds it, and
 * then cancels anything armed since. Otherwise a 300ms-old write would fire
 * after the move and recreate the file on disk. A move that fails keeps the
 * board's changes tracked for the next save.
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

function makeKanbanFixture(): BoardFileData {
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

  it('writes the pending change before the move, and none after it', async () => {
    // Hold the trash move in-flight until we manually resolve it, so the
    // 300ms debounce can fire DURING the await — this is the exact race
    // the resurrection bug exploits.
    let resolveDelete!: () => void;
    const deleteHeld = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });

    const { calls } = installFiloStub({
      'board:save': async () => ({ success: true }),
      'vault:trash-move': async () => {
        await deleteHeld;
        return { success: true, trashId: 'tid', kind: 'file' };
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

    // Now resolve the move and let removeBoardFromCache run.
    resolveDelete();
    const deleted = await deletePromise;
    expect(deleted).toMatchObject({ boardPath: 'tasks.board.json', trashId: 'tid' });

    // Final flush — also covers any stray write scheduled after the cancel.
    await vi.advanceTimersByTimeAsync(500);

    const channels = calls.map((c) => c.channel).filter((c) => c === 'board:save' || c === 'vault:trash-move');
    expect(channels).toEqual(['board:save', 'vault:trash-move']);
    const moves = calls.filter((c) => c.channel === 'vault:trash-move');
    expect(moves.map((c) => c.args)).toEqual([['/vault', 'tasks.board.json']]);
  });

  it('a last save that fails keeps a rescue copy before the move, and the result names it', async () => {
    const { calls } = installFiloStub({
      'board:save': async () => ({ success: false, code: 'EACCES', error: 'denied' }),
      'recovery:keep-unsaved': async (...args: unknown[]) => {
        const items = args[1] as Array<{ relPath: string }>;
        return { ok: true, dir: '.filo/recovery/2026-unsaved', kept: items.map((i) => i.relPath), failed: [] };
      },
      'vault:trash-move': async () => ({ success: true, trashId: 'tid', kind: 'file' }),
    });
    boardCacheStore.hydrate({ kb: makeKanbanFixture() }, { kb: 'tasks.board.json' });
    scheduleBoardWrite('kb', (): BoardWriteArgs | null => ({
      vaultRoot: '/vault',
      boardPath: 'tasks.board.json',
      cached: boardCacheStore.cache.kb,
    }));

    const deleted = await boardCacheStore.deleteBoard('kb');

    expect(deleted).toMatchObject({ trashId: 'tid', rescueDir: '.filo/recovery/2026-unsaved' });
    const order = calls.map((c) => c.channel).filter((c) => c === 'recovery:keep-unsaved' || c === 'vault:trash-move');
    expect(order).toEqual(['recovery:keep-unsaved', 'vault:trash-move']);
    const kept = calls.find((c) => c.channel === 'recovery:keep-unsaved')!.args[1] as Array<{ relPath: string; text: string }>;
    expect(kept[0]!.relPath).toBe('tasks.board.json');
    expect(JSON.parse(kept[0]!.text).board.id).toBe('kb');
  });

  it('a last save that fails with no rescue copy either: the board is not deleted', async () => {
    const { calls } = installFiloStub({
      'board:save': async () => ({ success: false, code: 'EACCES', error: 'denied' }),
      'recovery:keep-unsaved': async () => ({ ok: false, code: 'EACCES', error: 'denied' }),
      'vault:trash-move': async () => ({ success: true, trashId: 'tid', kind: 'file' }),
    });
    boardCacheStore.hydrate({ kb: makeKanbanFixture() }, { kb: 'tasks.board.json' });
    scheduleBoardWrite('kb', (): BoardWriteArgs | null => ({
      vaultRoot: '/vault',
      boardPath: 'tasks.board.json',
      cached: boardCacheStore.cache.kb,
    }));

    expect(await boardCacheStore.deleteBoard('kb')).toBeNull();
    expect(calls.some((c) => c.channel === 'vault:trash-move')).toBe(false);
    expect(boardCacheStore.cache.kb).toBeDefined();
  });

  it('a move that fails leaves the board with a write armed for its changes', async () => {
    const { calls } = installFiloStub({
      'board:save': async () => ({ success: true }),
      'vault:trash-move': async () => ({ success: false, code: 'EBUSY', error: 'busy' }),
    });
    boardCacheStore.hydrate({ kb: makeKanbanFixture() }, { kb: 'tasks.board.json' });

    const deleted = await boardCacheStore.deleteBoard('kb');
    expect(deleted).toBeNull();
    expect(boardCacheStore.cache.kb).toBeDefined();
    const before = calls.filter((c) => c.channel === 'board:save').length;
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.filter((c) => c.channel === 'board:save').length).toBe(before + 1);
  });
});

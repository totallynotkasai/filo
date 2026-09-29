import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { scheduleBoardWrite, setBoardExternalEditHandler, type BoardWriteArgs } from '@renderer/lib/boards/boardWriteScheduler';
import { unsavedWork, __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { noteBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { isBoardDriftHeld } from '@renderer/lib/boards/boardDriftHold';
import { vaultPath } from '@shared/vaultPath';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';

/**
 * Deleting a board whose last save didn't land (a locked file kept for Retry,
 * or a board held for a Reload / Keep local answer) keeps the board as it is
 * in memory in `.filo/recovery/` before the move, since the trashed file lacks
 * those changes; and once the board is in the trash, nothing is left owed for
 * it (quit doesn't warn about a board that is gone).
 */

type Route = (...args: unknown[]) => unknown;

function stub(routes: Record<string, Route>): string[] {
  const calls: string[] = [];
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push(channel);
      const handler = routes[channel];
      return handler ? handler(...args) : null;
    },
    on: () => () => {},
    send: () => {},
  };
  return calls;
}

function fixture(): BoardFileData {
  return {
    board: { id: 'kb', type: 'kanban', name: 'Tasks', emoji: '', createdAt: 0, updatedAt: 0, settings: {}, columns: [] },
    tileDefs: {},
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
}

const getArgs = (): BoardWriteArgs | null => {
  const cached = boardCacheStore.cache.kb;
  return cached ? { vaultRoot: '/vault', boardPath: 'tasks.board.json', cached } : null;
};

const keepUnsaved: Route = (...a: unknown[]) => ({
  success: true,
  dir: '.filo/recovery/1-unsaved',
  kept: (a[1] as Array<{ relPath: string }>).map((i) => i.relPath),
  failed: [],
});

describe('deleting a board whose last save did not land', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });
  afterEach(() => {
    setBoardExternalEditHandler(null);
    vi.useRealTimers();
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
  });

  it('a save kept for Retry that fails again: keeps a rescue copy, and nothing is owed after the move', async () => {
    const calls = stub({
      'board:save': () => ({ success: false, code: 'EBUSY', error: 'locked' }),
      'recovery:keep-unsaved': keepUnsaved,
      'vault:trash-move': () => ({ success: true, trashId: 'tid', kind: 'file' }),
    });
    boardCacheStore.hydrate({ kb: fixture() }, { kb: 'tasks.board.json' });
    scheduleBoardWrite('kb', getArgs);
    await vi.advanceTimersByTimeAsync(400);
    expect(unsavedWork().failed).toContain(vaultPath('tasks.board.json'));

    const deleted = await boardCacheStore.deleteBoard('kb');
    expect(deleted?.rescueDir).toBe('.filo/recovery/1-unsaved');
    expect(calls).toContain('recovery:keep-unsaved');
    await vi.advanceTimersByTimeAsync(400);
    expect(unsavedWork().failed).toEqual([]);
    expect(unsavedWork().pending).toEqual([]);
  });

  it('a save kept for Retry that lands now: the trashed file has the changes, no rescue copy needed', async () => {
    let saveOk = false;
    const calls = stub({
      'board:save': () => (saveOk ? { success: true } : { success: false, code: 'EBUSY', error: 'locked' }),
      'recovery:keep-unsaved': keepUnsaved,
      'vault:trash-move': () => ({ success: true, trashId: 'tid', kind: 'file' }),
    });
    boardCacheStore.hydrate({ kb: fixture() }, { kb: 'tasks.board.json' });
    scheduleBoardWrite('kb', getArgs);
    await vi.advanceTimersByTimeAsync(400);
    saveOk = true;

    const deleted = await boardCacheStore.deleteBoard('kb');
    expect(deleted).toBeTruthy();
    expect(deleted?.rescueDir).toBeUndefined();
    expect(calls.filter((c) => c === 'board:save')).toHaveLength(2);
    expect(calls).not.toContain('recovery:keep-unsaved');
    expect(unsavedWork().failed).toEqual([]);
  });

  it('a board held for a drift answer: keeps a rescue copy, never writes over the other version, and leaves nothing owed', async () => {
    const calls = stub({
      'vault:stat': () => ({ success: true, mtimeMs: 2000, size: 50 }),
      'board:save': () => ({ success: true }),
      'recovery:keep-unsaved': keepUnsaved,
      'vault:trash-move': () => ({ success: true, trashId: 'tid', kind: 'file' }),
    });
    setBoardExternalEditHandler(() => new Promise(() => {}));
    boardCacheStore.hydrate({ kb: fixture() }, { kb: 'tasks.board.json' });
    noteBaseline('tasks.board.json', 1000, 200);
    scheduleBoardWrite('kb', getArgs);
    await vi.advanceTimersByTimeAsync(400);
    expect(isBoardDriftHeld('tasks.board.json')).toBe(true);

    const deleted = await boardCacheStore.deleteBoard('kb');
    expect(deleted?.rescueDir).toBe('.filo/recovery/1-unsaved');
    expect(calls).not.toContain('board:save');
    expect(isBoardDriftHeld('tasks.board.json')).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(unsavedWork().failed).toEqual([]);
    expect(unsavedWork().pending).toEqual([]);
  });
});

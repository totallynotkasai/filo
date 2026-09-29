/**
 * A board whose load couldn't pin its version on disk (the stats around the
 * read disagreed, or the first stat failed) gets no baseline. Its first save
 * reads the file before writing over it, as if it had drifted: bytes that are
 * already Filo's are written over, anything else goes to the Reload / Keep
 * local question instead of being overwritten silently.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBoard } from '@renderer/lib/boards/boardLoader';
import { adoptLoadedBoardBaseline } from '@renderer/lib/boards/boardBaseline';
import { scheduleBoardWrite, setBoardExternalEditHandler, type BoardWriteArgs } from '@renderer/lib/boards/boardWriteScheduler';
import { isBoardDriftHeld } from '@renderer/lib/boards/boardDriftHold';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { unsavedWork, __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { getBaseline, isBaselineUnverified, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import { vaultPath } from '@shared/vaultPath';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

const REL = 'k.board.json';

function makeBoard(emoji: string): BoardFileData {
  return {
    version: 8,
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'k',
      emoji,
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  } as BoardFileData;
}

interface Routes {
  /** What `board:load` returns (or throws). */
  load: () => unknown;
}

function install(routes: Routes): string[] {
  const calls: string[] = [];
  let statCount = 0;
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string) => {
      calls.push(channel);
      if (channel === 'board:load') return routes.load();
      // Every stat moves: a write lands around every read.
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1000 + ++statCount, size: 100 + statCount };
      if (channel === 'board:save') return { success: true };
      return undefined;
    },
    on: () => () => {},
    send: () => {},
  };
  return calls;
}

const getArgs = (): BoardWriteArgs | null => {
  const cached = boardCacheStore.cache.kb;
  return cached ? { vaultRoot: '/vault', boardPath: REL, cached } : null;
};

/** Loads the board the way the open does: load, then adopt into the cache. */
async function openBoard(): Promise<void> {
  const result = await loadBoard('/vault', REL);
  if (!result.ok) throw new Error(result.message);
  boardCacheStore.hydrate({ kb: result.data }, { kb: REL });
  adoptLoadedBoardBaseline(REL, result.baseline);
}

describe('a board loaded without a baseline', () => {
  let asked: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    asked = [];
    setBoardExternalEditHandler(async (path) => {
      asked.push(path);
      return 'defer';
    });
  });
  afterEach(() => {
    setBoardExternalEditHandler(null);
    vi.useRealTimers();
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it('is marked unverified when its stats disagree around the read', async () => {
    install({ load: () => makeBoard('loaded') });
    await openBoard();
    expect(getBaseline(REL)).toBeUndefined();
    expect(isBaselineUnverified(REL)).toBe(true);
  });

  it('its first save asks when the file holds another version, and writes nothing', async () => {
    let disk = makeBoard('loaded');
    const calls = install({ load: () => disk });
    await openBoard();
    disk = makeBoard('someone else');
    (boardCacheStore.cache.kb!.board as KanbanBoard).emoji = 'mine';
    scheduleBoardWrite('kb', getArgs);
    await vi.advanceTimersByTimeAsync(400);
    expect(asked).toEqual([REL]);
    expect(calls).not.toContain('board:save');
    expect(isBoardDriftHeld(REL)).toBe(true);
  });

  it('its first save writes when the file still holds the version it loaded', async () => {
    const calls = install({ load: () => makeBoard('loaded') });
    await openBoard();
    (boardCacheStore.cache.kb!.board as KanbanBoard).emoji = 'mine';
    scheduleBoardWrite('kb', getArgs);
    await vi.advanceTimersByTimeAsync(400);
    expect(asked).toEqual([]);
    expect(calls).toContain('board:save');
  });

  it('a file that can\'t be read to check is kept for Retry, not written over', async () => {
    let locked = false;
    const calls = install({
      load: () => {
        if (locked) return { success: false, code: 'EBUSY', error: 'locked' };
        return makeBoard('loaded');
      },
    });
    await openBoard();
    locked = true;
    (boardCacheStore.cache.kb!.board as KanbanBoard).emoji = 'mine';
    scheduleBoardWrite('kb', getArgs);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).not.toContain('board:save');
    expect(asked).toEqual([]);
    expect(unsavedWork().failed).toContain(vaultPath(REL));
  });
});

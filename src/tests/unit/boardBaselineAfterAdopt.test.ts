/**
 * A board's drift baseline moves only when its loaded data is adopted into
 * the cache. A load that fails (a newer or older format, a schema error), or
 * a silent reload set aside because an edit landed during the read, keeps the
 * old baseline, so the next save's drift check still finds the outside version
 * and asks instead of overwriting it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadBoard } from '@renderer/lib/boards/boardLoader';
import { adoptLoadedBoardBaseline } from '@renderer/lib/boards/boardBaseline';
import { reloadBoardFromDisk } from '@renderer/stores/boardDrift';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { getBaseline, noteBaseline, baselineSeq, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

const REL = 'k.board.json';
const OLD = { mtimeMs: 1000, size: 100 };
const DISK = { mtimeMs: 2000, size: 250 };

function makeBoard(emoji: string, version = 8): BoardFileData {
  return {
    version,
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

function installRoutes(load: () => unknown): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string) => {
      if (channel === 'board:load') return load();
      if (channel === 'vault:stat') return { success: true, ok: true, ...DISK };
      return undefined;
    },
    on: () => () => {},
    send: () => {},
  };
}

describe('board drift baseline: stamped only on adopt', () => {
  beforeEach(() => {
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    noteBaseline(REL, OLD.mtimeMs, OLD.size, { ifUnchangedSince: baselineSeq(REL) });
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetBaselinesForTests();
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it('a board from a newer Filo (version 9) leaves the baseline alone', async () => {
    installRoutes(() => makeBoard('v9', 9));
    const result = await loadBoard('/vault', REL);
    expect(result).toMatchObject({ ok: false, error: 'from-future' });
    expect(getBaseline(REL)).toEqual(OLD);
  });

  it('a board with no baseline yet stays without one after a failed load', async () => {
    __resetBaselinesForTests();
    installRoutes(() => makeBoard('v9', 9));
    await loadBoard('/vault', REL);
    expect(getBaseline(REL)).toBeUndefined();
  });

  it('a schema-invalid board leaves the baseline alone', async () => {
    installRoutes(() => ({ ...makeBoard('bad'), connections: 'not a map' }));
    const result = await loadBoard('/vault', REL);
    expect(result).toMatchObject({ ok: false, error: 'schema-invalid' });
    expect(getBaseline(REL)).toEqual(OLD);
  });

  it('a successful load hands the stat back; only adopting it stamps', async () => {
    installRoutes(() => makeBoard('fine'));
    const result = await loadBoard('/vault', REL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getBaseline(REL)).toEqual(OLD);
    expect(result.baseline).toMatchObject(DISK);
    adoptLoadedBoardBaseline(REL, result.baseline);
    expect(getBaseline(REL)).toEqual(DISK);
  });

  it('a failed reload keeps the old baseline and Filo\'s copy', async () => {
    boardCacheStore.hydrate({ kb: makeBoard('mine') }, { kb: REL });
    installRoutes(() => makeBoard('v9', 9));
    expect(await reloadBoardFromDisk(REL, 'kb')).toBe('failed');
    expect(getBaseline(REL)).toEqual(OLD);
    expect((boardCacheStore.cache.kb!.board as KanbanBoard).emoji).toBe('mine');
  });

  it('a silent reload set aside by an edit during the read keeps the old baseline', async () => {
    boardCacheStore.hydrate({ kb: makeBoard('mine') }, { kb: REL });
    installRoutes(() => makeBoard('disk'));
    expect(await reloadBoardFromDisk(REL, 'kb', { guardPending: () => true })).toBe('pending');
    expect(getBaseline(REL)).toEqual(OLD);
    expect((boardCacheStore.cache.kb!.board as KanbanBoard).emoji).toBe('mine');
  });

  it('a reload that is adopted moves the baseline to the version read', async () => {
    boardCacheStore.hydrate({ kb: makeBoard('mine') }, { kb: REL });
    installRoutes(() => makeBoard('disk'));
    expect(await reloadBoardFromDisk(REL, 'kb')).toBe('reloaded');
    expect(getBaseline(REL)).toEqual(DISK);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeBoardFile,
  writeConfigs,
  setWriteErrorListener,
  setWriteStateListener,
  trackComponentWrite,
  seedConfigSnapshots,
  markPathFailed,
  scheduleBoardWrite,
  flushAll,
  isRecentSelfWrite,
  __clearRecentSelfWritesForTests,
  __resetDirtyTrackingForTests,
  type WriteErrorInfo,
  type WriteStateInfo,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';
import {
  installFiloMock,
  restoreFiloDefault,
  type InvokeHandler,
} from '../helpers/filoBridge';

let lastBoardSavePayload: string | null = null;

function captureBoardSave(): InvokeHandler {
  return (..._args: unknown[]) => {
    lastBoardSavePayload = String(_args[2]);
    return null;
  };
}

describe('boardSaver.writeBoardFile', () => {
  beforeEach(() => {
    lastBoardSavePayload = null;
    restoreFiloDefault();
  });
  afterEach(() => restoreFiloDefault());

  it('writes a media tile def verbatim (caption title, src)', async () => {
    installFiloMock({ 'board:save': captureBoardSave() });

    const cached: BoardFileData = {
      board: {
        id: 'mm',
        type: 'mindmap',
        name: 'MM',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        placements: { i1: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false } },
        inlineTiles: {},
        connections: [],
        frames: [],
        waypoints: [],
        groups: [],
      } as unknown as BoardFileData['board'],
      tileDefs: {
        i1: {
          id: 'i1',
          type: 'image',
          title: 'Photo',
          src: 'attachments/i1/photo.jpg',
          style: {} as never,
          createdAt: 0,
          updatedAt: 0,
        } as unknown as BoardFileData['tileDefs'][string],
      },
      connections: {},
      frames: [],
    };

    await writeBoardFile('/vault', 'mm.board.json', cached);
    const out = JSON.parse(lastBoardSavePayload!);
    expect(out.tileDefs.i1).toMatchObject({ type: 'image', title: 'Photo', src: 'attachments/i1/photo.jpg' });
  });

  it('writes mind-map boards intact (placements, inlineTiles)', async () => {
    installFiloMock({ 'board:save': captureBoardSave() });

    const cached: BoardFileData = {
      board: {
        id: 'mm',
        type: 'mindmap',
        name: 'MM',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        placements: {},
        inlineTiles: {},
        connections: [],
        frames: [],
        waypoints: [],
        groups: [],
      } as unknown as BoardFileData['board'],
      tileDefs: {},
      connections: {},
      frames: [],
    };

    await writeBoardFile('/vault', 'mm.board.json', cached);
    const out = JSON.parse(lastBoardSavePayload!);
    expect(out.board.type).toBe('mindmap');
    expect(out.board.placements).toEqual({});
  });
});

describe('boardSaver write error propagation', () => {
  beforeEach(() => {
    restoreFiloDefault();
    setWriteErrorListener(null);
  });
  afterEach(() => {
    restoreFiloDefault();
    setWriteErrorListener(null);
  });

  it('writeBoardFile rethrows IPC failure and fires write-error listener', async () => {
    installFiloMock({
      'board:save': () => { throw new Error('disk full'); },
    });

    const observed: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => observed.push(info));

    const cached: BoardFileData = {
      board: { id: 'b', type: 'mindmap', name: 'B', emoji: '', createdAt: 0, updatedAt: 0, settings: {}, placements: {}, inlineTiles: {}, connections: [], frames: [], waypoints: [], groups: [] } as unknown as BoardFileData['board'],
      tileDefs: {},
      connections: {},
      frames: [],
    };

    await expect(writeBoardFile('/vault', 'b.board.json', cached)).rejects.toThrow('disk full');
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'board', path: 'b.board.json' });
  });

  it('trackComponentWrite surfaces IPC failures via the write-error listener with kind=component', async () => {
    installFiloMock({
      'vault:write-file-text': () => { throw new Error('disk full'); },
      // markDirty writes the sentinel — stub it so the tracking pipeline succeeds.
      'vault:delete': () => null,
    });

    const observed: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => observed.push(info));

    await expect(
      trackComponentWrite('/vault', 'Tasks/foo.md', async () => {
        await window.filo.invoke('vault:write-file-text', '/vault', 'Tasks/foo.md', 'content');
      }),
    ).rejects.toThrow('disk full');

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'component', path: 'Tasks/foo.md' });
  });

  it('trackComponentWrite does not fire listener on success', async () => {
    installFiloMock({
      'vault:write-file-text': () => null,
      'vault:delete': () => null,
    });

    const observed: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => observed.push(info));

    await trackComponentWrite('/vault', 'Tasks/foo.md', async () => {
      await window.filo.invoke('vault:write-file-text', '/vault', 'Tasks/foo.md', 'content');
    });

    expect(observed).toHaveLength(0);
  });

  it('trackComponentWrite registers markRecentSelfWrite BEFORE running writeFn (Phase A.2a)', async () => {
    // The OS-level watcher event for our own write can fire before the IPC
    // promise resolves. Marking suppression after the await let the renderer
    // surface "External edit replaced 'New Tile'" for every freshly-created
    // file. The fix moves the mark to before the await; this test guards it.
    __clearRecentSelfWritesForTests();

    let suppressedAtFireTime: boolean | null = null;
    installFiloMock({
      // Sample isRecentSelfWrite the moment the IPC handler runs — i.e.
      // before the writeFn promise has resolved. If the mark happens after
      // the await, this read sees false and the test fails.
      'vault:write-file-text': () => {
        suppressedAtFireTime = isRecentSelfWrite('Tasks/foo.md');
        return null;
      },
      'vault:delete': () => null,
    });

    await trackComponentWrite('/vault', 'Tasks/foo.md', async () => {
      await window.filo.invoke('vault:write-file-text', '/vault', 'Tasks/foo.md', 'content');
    });

    expect(suppressedAtFireTime).toBe(true);
  });

  it('trackComponentWrite drives the write-state listener (inflight → failed) on rejection', async () => {
    __resetDirtyTrackingForTests();
    installFiloMock({
      'vault:write-file-text': () => { throw new Error('boom'); },
      'vault:delete': () => null,
    });

    const states: WriteStateInfo[] = [];
    setWriteStateListener((info) => states.push({ ...info }));

    await expect(
      trackComponentWrite('/vault', 'Tasks/bar.md', async () => {
        await window.filo.invoke('vault:write-file-text', '/vault', 'Tasks/bar.md', 'content');
      }),
    ).rejects.toThrow('boom');

    // First push: inflight=1 (beginWrite). Last push: inflight=0, failed=1 (endWrite on rejection).
    // Phase C / C.10 — WriteStateInfo now carries `failedPaths`; use
    // toMatchObject so the expected shape only pins the counters.
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[0]).toMatchObject({ inflight: 1, failed: 0 });
    expect(states[states.length - 1]).toMatchObject({ inflight: 0, failed: 1 });

    setWriteStateListener(null);
    __resetDirtyTrackingForTests();
  });

  it('markPathFailed moves a path into the failed set without changing inflight', async () => {
    __resetDirtyTrackingForTests();

    const states: WriteStateInfo[] = [];
    setWriteStateListener((info) => states.push({ ...info }));

    markPathFailed('/vault', 'Notes/foo.md');
    expect(states[states.length - 1]).toMatchObject({ inflight: 0, failed: 1 });

    // Calling markPathFailed twice on the same path is idempotent — Set
    // semantics keep `failed` at 1.
    markPathFailed('/vault', 'Notes/foo.md');
    expect(states[states.length - 1]).toMatchObject({ inflight: 0, failed: 1 });

    setWriteStateListener(null);
    __resetDirtyTrackingForTests();
  });

  it('writeConfigs attempts every file even when one fails, then returns failures (A1.1)', async () => {
    __resetDirtyTrackingForTests();
    const seen: string[] = [];
    installFiloMock({
      'config:save-workspace': (..._args: unknown[]) => { seen.push('workspace'); return null; },
      'config:save': (...args: unknown[]) => {
        const target = String(args[1]);
        seen.push(target);
        if (target === 'defaults.json') throw new Error('disk full');
        return null;
      },
    });

    const observed: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => observed.push(info));

    const settings: ProjectSettings = {} as unknown as ProjectSettings;
    const workspace: WorkspaceState = { openTabs: [], activeTabId: null } as unknown as WorkspaceState;

    // A1.1: failures are returned, not thrown — every other file still
    // attempted, every failed target collected in `failed`.
    const res = await writeConfigs('/vault', settings, 'light', workspace);
    expect(res.failed).toEqual(['defaults.json']);
    expect(seen).toEqual(['workspace', 'defaults.json', 'app.json', 'appearance.json']);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'config', path: 'defaults.json' });
  });
});

describe('boardSaver writeConfigs per-target dirty tracking', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  const makeSettings = (overrides: Partial<ProjectSettings['general']> = {}): ProjectSettings => ({
    general: {
      globalFont: '',
      systemFonts: [],
      globalToolbarScale: 1,
      boardToolbarScale: 1,
      tabBarScale: 1,
      minimapScale: 1,
      waypointScale: 1,
      toolbarColor: '',
      tabBarColor: '',
      radarEnabled: true,
      recentColors: [],
      ...overrides,
    },
    mindmap: {},
    kanban: {},
    tasklist: {},
    document: {},
  } as unknown as ProjectSettings);

  const emptyWorkspace: WorkspaceState = { openTabs: [], activeTabId: null } as unknown as WorkspaceState;

  it('skips identical writeConfigs calls after the first', async () => {
    const seen: string[] = [];
    installFiloMock({
      'config:save-workspace': () => { seen.push('workspace'); return null; },
      'config:save': (...args: unknown[]) => { seen.push(String(args[1])); return null; },
    });

    const settings = makeSettings();
    await writeConfigs('/vault', settings, 'light', emptyWorkspace);
    expect(seen).toEqual(['workspace', 'defaults.json', 'app.json', 'appearance.json']);

    seen.length = 0;
    await writeConfigs('/vault', settings, 'light', emptyWorkspace);
    // All four payloads matched the cache — nothing written.
    expect(seen).toEqual([]);
  });

  it('writes only the changed file when a single field flips (theme → appearance.json)', async () => {
    const seen: string[] = [];
    installFiloMock({
      'config:save-workspace': () => { seen.push('workspace'); return null; },
      'config:save': (...args: unknown[]) => { seen.push(String(args[1])); return null; },
    });

    const settings = makeSettings();
    await writeConfigs('/vault', settings, 'light', emptyWorkspace);
    seen.length = 0;

    await writeConfigs('/vault', settings, 'dark', emptyWorkspace);
    expect(seen).toEqual(['appearance.json']);
  });

  it('seedConfigSnapshots primes the cache so an unchanged first save writes nothing', async () => {
    const seen: string[] = [];
    installFiloMock({
      'config:save-workspace': () => { seen.push('workspace'); return null; },
      'config:save': (...args: unknown[]) => { seen.push(String(args[1])); return null; },
    });

    const settings = makeSettings();
    seedConfigSnapshots(settings, 'light', emptyWorkspace);

    await writeConfigs('/vault', settings, 'light', emptyWorkspace);
    expect(seen).toEqual([]);
  });

  it('a failed write does not poison the cache — retry still attempts the file', async () => {
    let failNext = true;
    const seen: string[] = [];
    installFiloMock({
      'config:save-workspace': () => { seen.push('workspace'); return null; },
      'config:save': (...args: unknown[]) => {
        const target = String(args[1]);
        seen.push(target);
        if (target === 'defaults.json' && failNext) {
          throw new Error('disk full');
        }
        return null;
      },
    });

    const settings = makeSettings();
    // A1.1: writeConfigs no longer throws on per-target failure; the failed
    // target lives in `failed`.
    const firstRes = await writeConfigs('/vault', settings, 'light', emptyWorkspace);
    expect(firstRes.failed).toEqual(['defaults.json']);
    seen.length = 0;

    // Retry with the same payload — defaults.json must be attempted again
    // because its first write failed and was NOT cached. The other three
    // succeeded the first time and should be skipped.
    failNext = false;
    const secondRes = await writeConfigs('/vault', settings, 'light', emptyWorkspace);
    expect(secondRes.failed).toEqual([]);
    expect(seen).toEqual(['defaults.json']);
  });
});

describe('boardSaver.flushAll — Phase 31 A1.1 aggregate failure surfacing', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('returns the failing board paths so the caller can drop the success toast', async () => {
    installFiloMock({
      'board:save': (...args: unknown[]) => {
        const boardPath = String(args[1]);
        if (boardPath === 'broken.board.json') {
          return { ok: false, code: 'EACCES', error: 'denied' };
        }
        return { ok: true };
      },
      'config:save-workspace': () => ({ ok: true }),
      'config:save': () => ({ ok: true }),
    });

    const cached = (path: string): BoardFileData => ({
      board: {
        id: path,
        type: 'mindmap',
        name: path,
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        placements: {},
        inlineTiles: {},
        connections: [],
        frames: [],
        waypoints: [],
        groups: [],
      } as unknown as BoardFileData['board'],
      tileDefs: {},
      connections: {},
      frames: [],
    });

    // Schedule one healthy + one failing board.
    scheduleBoardWrite('ok', () => ({ vaultRoot: '/vault', boardPath: 'ok.board.json', cached: cached('ok') }));
    scheduleBoardWrite('broken', () => ({ vaultRoot: '/vault', boardPath: 'broken.board.json', cached: cached('broken') }));

    const result = await flushAll(
      (boardId) => {
        if (boardId === 'ok') return { vaultRoot: '/vault', boardPath: 'ok.board.json', cached: cached('ok') };
        if (boardId === 'broken') return { vaultRoot: '/vault', boardPath: 'broken.board.json', cached: cached('broken') };
        return null;
      },
      () => null,
    );

    expect(result.boardFailed).toEqual(['broken.board.json']);
    expect(result.configFailed).toEqual([]);
  });
});

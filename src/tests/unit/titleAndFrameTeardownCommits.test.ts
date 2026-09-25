import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { resolveTitleCommitValues } from '@renderer/lib/editor/titleCommit';
import { UpdateTitleCommand } from '@renderer/commands/updateTitleCommand';
import { revertFrameDragOnTeardown } from '@renderer/lib/frames/frameDragCancel';
import { flushLastViewForBoard } from '@renderer/lib/boards/lastViewFlush';
import {
  createCoarsePersistGate,
  TIMER_COARSE_PERSIST_MS,
} from '@renderer/lib/utils/coarsePersistGate';
import { TaskListFiltersAndViews } from '@renderer/lib/tasklist/filtersAndViews.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Frame, Tile } from '@renderer/schema/index';

/**
 * Audit-17 Phase 4 — UI/UX silent-loss paper cuts.
 *
 *  4.1 Tile title rename silently discarded when the tile unmounted inside
 *      the 200 ms blur→commit window (clicking another tab/board blurs AND
 *      unmounts within ms; the Audit-11 R3 teardown cancelled, never
 *      committed). Fix: snapshot the editor BEFORE destroy and commit; the
 *      rename helper gained a home-board cache fallback because by teardown
 *      time the pane's scope already points at the switched-in board.
 *  4.2 Frame title twin: same unmount loss + the blur setTimeout was
 *      anonymous and uncleared (stacked on repeated blur/focus).
 *  4.3 Frame drag-end's "flush final position" was dead code — the flag was
 *      flipped BEFORE the flush, whose first guard is `if (!isDragging)`.
 *  4.4 The Audit-16 6.1 unmount-mid-drag teardown left the incrementally
 *      persisted frame+tile moves in place with NO undo command. Fix: true
 *      cancel (revert to drag-start positions), mirroring tileDrag.destroy().
 *  4.5 lastView persist debounce was cancelled-without-flush on every board
 *      switch (TaskListBoard + KanbanBoard) — a filter change within 300 ms
 *      of switching was never written (the hydratedForBoardId guard blocks
 *      any re-fire after the switch). Fix: flush the ARM-time snapshot for
 *      the CAPTURED board id through the cache (teardown-safe).
 *  4.6 Running TimerTile countdown was unrecoverable on quit (no unmount)
 *      and vault swap (cache cleared pre-unmount). Fix: 45 s coarse persist
 *      while running — far above the 300 ms board debounce, so the Audit2
 *      4.1 re-arm-forever bug is not reintroduced.
 *
 * The jsdom suite has no Svelte component-mount harness, so component wiring
 * is pinned via source-shape assertions (same pattern as audit11Phase1 /
 * audit12L5) and the behavior lives in the extracted lib helpers + the
 * detached cache write paths the teardowns rely on.
 */

const ROOT = process.cwd();
const TILE_HEADER_SRC = readFileSync(
  join(ROOT, 'src/renderer/components/tiles/TileHeader.svelte'),
  'utf8',
);
const FRAME_SRC = readFileSync(
  join(ROOT, 'src/renderer/components/frames/Frame.svelte'),
  'utf8',
);
const TASKLIST_SRC = readFileSync(
  join(ROOT, 'src/renderer/components/boards/TaskListBoard.svelte'),
  'utf8',
);
const KANBAN_SRC = readFileSync(
  join(ROOT, 'src/renderer/components/boards/KanbanBoard.svelte'),
  'utf8',
);
const TIMER_SRC = readFileSync(
  join(ROOT, 'src/renderer/components/tiles/TimerTile.svelte'),
  'utf8',
);

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapFixture(id: string, name: string): BoardFileData {
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

/** Hydrates two boards; activates `activeId`. The other stays cache-only. */
function activateTwoBoards(activeId: 'mm' | 'other'): {
  mm: BoardFileData;
  other: BoardFileData;
} {
  const mm = makeMindMapFixture('mm', 'Map');
  const other = makeMindMapFixture('other', 'Other');
  boardCacheStore.hydrate(
    { mm, other },
    { mm: 'map.board.json', other: 'other.board.json' },
  );
  const fixture = activeId === 'mm' ? mm : other;
  boardStore.setBoard(fixture.board, {}, {}, []);
  return { mm, other };
}

function makeTextTile(id: string, boardId: string, title: string): Tile {
  return {
    id,
    boardId,
    type: 'text',
    title,
    position: { x: 10, y: 10 },
    size: { width: 100, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    locked: false,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    filePath: `${title}.md`,
  } as unknown as Tile;
}

beforeEach(() => {
  installEmptyFiloStub();
  vaultStore.setPath('');
  boardCacheStore.clear();
  boardStore.clearBoard();
});

afterEach(() => {
  vaultStore.setPath('');
  boardCacheStore.clear();
  boardStore.clearBoard();
});

// ── 4.1 — tile title commit-on-unmount ──────────────────────────────────

describe('Audit-17 4.1 — resolveTitleCommitValues (shared blur-commit resolution)', () => {
  it('falls back when the user emptied the editor and suppresses identity HTML', () => {
    expect(resolveTitleCommitValues('   ', '<p></p>', 'New Tile')).toEqual({
      plain: 'New Tile',
      titleHtml: undefined,
    });
    // Unstyled title → no titleHtml stored (avoids `<p>foo</p>` in the schema).
    expect(resolveTitleCommitValues('Plain', '<p>Plain</p>', 'New Tile')).toEqual({
      plain: 'Plain',
      titleHtml: undefined,
    });
  });

  it('keeps rich-text HTML when the user added marks', () => {
    const html = '<p><strong>Bold</strong> title</p>';
    expect(resolveTitleCommitValues('Bold title', html, 'Frame')).toEqual({
      plain: 'Bold title',
      titleHtml: html,
    });
  });
});

describe('Audit-17 4.1 — a teardown title commit resolves through the home board cache', () => {
  function makeLinkTile(id: string, boardId: string, title: string): Tile {
    return {
      ...makeTextTile(id, boardId, title),
      type: 'link',
      url: 'https://example.com',
      filePath: undefined,
    } as unknown as Tile;
  }

  function titleCommand(tileId: string, boardId: string): UpdateTitleCommand {
    return new UpdateTitleCommand({
      tileId,
      boardId,
      notePath: null,
      oldTitle: 'Before',
      newTitle: 'After',
      oldTitleHtml: undefined,
      newTitleHtml: undefined,
    });
  }

  it('updates a tile whose board is NO LONGER active', async () => {
    activateTwoBoards('other');
    boardStore.addTile(makeLinkTile('t-h', 'other', 'Before'));
    // Simulate the tab switch that unmounts TileHeader: the pane's scope now
    // points at 'mm', so the active-tiles lookup misses 't-h'.
    const mm = boardCacheStore.cache['mm'] as unknown as { board: MindMapBoard };
    boardStore.setBoard(mm.board, {}, {}, []);
    expect(boardStore.getTile('t-h')).toBeUndefined();

    await titleCommand('t-h', 'other').execute();
    expect(boardCacheStore.getFullTilesForBoard('other')['t-h']?.title).toBe('After');
  });

  it('still routes through the active scope when the board is active', async () => {
    activateTwoBoards('other');
    boardStore.addTile(makeLinkTile('t-a', 'other', 'Before'));
    await titleCommand('t-a', 'other').execute();
    expect(boardStore.getTile('t-a')?.title).toBe('After');
  });
});

describe('Audit-17 4.1 — TileHeader teardown commits instead of cancelling (source shape)', () => {
  /** The unmount `$effect` cleanup region of TileHeader. */
  const teardownStart = TILE_HEADER_SRC.indexOf('const snap = blurCommitTimer !== null ? snapshotEditorTitle() : null;');

  it('snapshots the editor BEFORE destroy, clears the timer, and commits', () => {
    expect(teardownStart).toBeGreaterThan(-1);
    const region = TILE_HEADER_SRC.slice(teardownStart, teardownStart + 400);
    // Order matters: snapshot → clearTimeout → destroy → commit.
    const clearIdx = region.indexOf('clearTimeout(blurCommitTimer)');
    const destroyIdx = region.indexOf('destroyTitleEditor()');
    const commitIdx = region.indexOf('applyTitleCommit(snap, true)');
    expect(clearIdx).toBeGreaterThan(-1);
    expect(destroyIdx).toBeGreaterThan(clearIdx);
    expect(commitIdx).toBeGreaterThan(destroyIdx);
  });

  it('the teardown commit threads the home board into the title command', () => {
    // The command resolves a detached tile through its home board's cache
    // (pinned behaviourally above), so it must be handed that board.
    const idx = TILE_HEADER_SRC.indexOf('new UpdateTitleCommand({');
    expect(idx).toBeGreaterThan(-1);
    const region = TILE_HEADER_SRC.slice(idx, idx + 200);
    expect(region).toContain('tileId: tile.id,');
    expect(region).toContain('boardId: tile.boardId,');
  });
});

// ── 4.2 — frame title twin ───────────────────────────────────────────────

describe('Audit-17 4.2 — Frame title blur timer is tracked and commits on unmount', () => {
  it('declares the handle, arms it in onBlur, and clears it in destroyTitleEditor', () => {
    expect(FRAME_SRC).toContain('let blurCommitTimer: ReturnType<typeof setTimeout> | null = null;');
    expect(FRAME_SRC).toContain('blurCommitTimer = setTimeout(() => {');
  });

  it('the unmount teardown snapshots then commits via the teardown-safe path', () => {
    const idx = FRAME_SRC.indexOf('const snap = blurCommitTimer !== null ? snapshotEditorTitle() : null;');
    expect(idx).toBeGreaterThan(-1);
    const region = FRAME_SRC.slice(idx, idx + 400);
    expect(region).toContain('clearTimeout(blurCommitTimer)');
    expect(region).toContain('applyFrameTitleCommit(snap, true)');
  });

  it('the teardown commit writes through the cache (persistUpdateFrame), not history', () => {
    const fn = FRAME_SRC.slice(
      FRAME_SRC.indexOf('function applyFrameTitleCommit'),
      FRAME_SRC.indexOf('function cancelTitleEdit'),
    );
    expect(fn).toContain('boardCacheStore.persistUpdateFrame(');
  });

  it('persistUpdateFrame resolves a frame whose board is not active (the cache fact the fix relies on)', () => {
    activateTwoBoards('other');
    const frame = {
      id: 'f-d',
      boardId: 'other',
      title: 'Before',
      position: { x: 0, y: 0 },
      size: { width: 200, height: 200 },
      style: { backgroundImage: '', borderColor: '' },
      collapsed: false,
      tileIds: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Frame;
    boardStore.addFrame(frame);
    const mm = boardCacheStore.cache['mm'] as unknown as { board: MindMapBoard };
    boardStore.setBoard(mm.board, {}, {}, []);

    boardCacheStore.persistUpdateFrame('f-d', { ...frame, title: 'After', updatedAt: 1 } as Frame);
    const cached = boardCacheStore.cache['other'] as unknown as { frames: Frame[] };
    expect(cached.frames.find((f) => f.id === 'f-d')?.title).toBe('After');
  });
});

// ── 4.3 — drag-end flush ordering ────────────────────────────────────────

describe('Audit-17 4.3 — Frame drag-end flushes the RAF-pending move BEFORE flipping isDragging', () => {
  it('flushDragMove() precedes `isDragging = false` in handleDragEnd', () => {
    const start = FRAME_SRC.indexOf('function handleDragEnd()');
    expect(start).toBeGreaterThan(-1);
    const end = FRAME_SRC.indexOf('function handleResizeStart', start);
    const body = FRAME_SRC.slice(start, end);
    const flushIdx = body.indexOf('flushDragMove();');
    const flipIdx = body.indexOf('isDragging = false;');
    expect(flushIdx).toBeGreaterThan(-1);
    expect(flipIdx).toBeGreaterThan(-1);
    // The old order (flip first) made the flush dead code behind
    // flushDragMove's `if (!isDragging) return` guard.
    expect(flushIdx).toBeLessThan(flipIdx);
  });
});

// ── 4.4 — unmount-mid-drag true cancel ──────────────────────────────────

describe('Audit-17 4.4 — revertFrameDragOnTeardown (true cancel, mirrors tileDrag.destroy)', () => {
  interface Call { id: string; pos: { x: number; y: number } }

  function makeDeps(tiles: Record<string, Tile>) {
    const frameWrites: Call[] = [];
    const tileWrites: Call[] = [];
    return {
      frameWrites,
      tileWrites,
      deps: {
        updateFramePosition: (id: string, pos: { x: number; y: number }) =>
          frameWrites.push({ id, pos }),
        getTile: (id: string) => tiles[id],
        moveTile: (id: string, pos: { x: number; y: number }) =>
          tileWrites.push({ id, pos }),
      },
    };
  }

  function tileAt(id: string, x: number, y: number, locked = false): Tile {
    return { ...makeTextTile(id, 'mm', id), position: { x, y }, locked } as Tile;
  }

  it('reverts the frame and moves unlocked contained tiles back by the inverse delta', () => {
    // Drag start (100,100) → last RAF wrote (160,180): delta (+60,+80).
    // Tiles moved with the drag, so their CURRENT positions include it.
    const tiles = {
      t1: tileAt('t1', 260, 280),
      t2: tileAt('t2', 60, 90),
    };
    const { frameWrites, tileWrites, deps } = makeDeps(tiles);
    revertFrameDragOnTeardown(
      { frameId: 'f1', startX: 100, startY: 100, lastX: 160, lastY: 180, containedTileIds: ['t1', 't2'] },
      deps,
    );
    expect(frameWrites).toEqual([{ id: 'f1', pos: { x: 100, y: 100 } }]);
    expect(tileWrites).toEqual([
      { id: 't1', pos: { x: 200, y: 200 } },
      { id: 't2', pos: { x: 0, y: 10 } },
    ]);
  });

  it('skips locked tiles (they never moved with the drag) and missing tiles', () => {
    const tiles = { tLocked: tileAt('tLocked', 50, 50, true) };
    const { tileWrites, deps } = makeDeps(tiles);
    revertFrameDragOnTeardown(
      { frameId: 'f1', startX: 0, startY: 0, lastX: 30, lastY: 0, containedTileIds: ['tLocked', 'tGone'] },
      deps,
    );
    expect(tileWrites).toEqual([]);
  });

  it('a jitter / never-moved drag reverts nothing', () => {
    const { frameWrites, tileWrites, deps } = makeDeps({ t1: tileAt('t1', 5, 5) });
    revertFrameDragOnTeardown(
      { frameId: 'f1', startX: 10, startY: 10, lastX: 10, lastY: 10, containedTileIds: ['t1'] },
      deps,
    );
    expect(frameWrites).toEqual([]);
    expect(tileWrites).toEqual([]);
  });

  it('Frame.svelte wires the revert into the unmount teardown BEFORE endBatch (source shape)', () => {
    const idx = FRAME_SRC.indexOf('revertFrameDragOnTeardown(');
    expect(idx).toBeGreaterThan(-1);
    const endBatchAfter = FRAME_SRC.indexOf('spatialStore.endBatch()', idx);
    expect(endBatchAfter).toBeGreaterThan(idx);
    // The wrong Audit-16 comment claimed tileDrag "cancels-not-commits" as a
    // justification for committing — the teardown must not push history.
    const teardown = FRAME_SRC.slice(idx - 2500, endBatchAfter);
    expect(teardown).not.toContain('historyStore.');
  });
});

// ── 4.5 — lastView flush-on-teardown ────────────────────────────────────

describe('Audit-17 4.5 — flushLastViewForBoard (teardown-safe lastView sink)', () => {
  it('writes the slice onto the CAPTURED board even when another board is active', () => {
    activateTwoBoards('mm');
    const next = { filterTags: ['urgent'], smartList: 'today', showCompleted: false };
    expect(flushLastViewForBoard('other', next)).toBe(true);
    const other = boardCacheStore.cache['other'] as unknown as {
      board: { settings: Record<string, unknown> };
    };
    expect(other.board.settings.lastView).toEqual(next);
    // The active board is untouched.
    const mm = boardCacheStore.cache['mm'] as unknown as {
      board: { settings: Record<string, unknown> };
    };
    expect(mm.board.settings.lastView).toBeUndefined();
  });

  it('no-ops (returns false) when the persisted slice already matches', () => {
    activateTwoBoards('mm');
    const slice = { filterTags: [], smartList: 'all' };
    expect(flushLastViewForBoard('other', slice)).toBe(true);
    expect(flushLastViewForBoard('other', { filterTags: [], smartList: 'all' })).toBe(false);
  });

  it('returns false for an unknown / already-evicted board id', () => {
    activateTwoBoards('mm');
    expect(flushLastViewForBoard('gone', { smartList: 'all' })).toBe(false);
  });

  it('TaskListFiltersAndViews.dispose() flushes the pending slice for the hydrated board', () => {
    activateTwoBoards('mm');
    const filters = new TaskListFiltersAndViews({
      getSavedViewsRaw: () => [],
      updateSettings: () => {},
      setSavedViews: () => {},
      tickAndPersist: () => {},
      getGroupBy: () => 'none' as never,
      getSortBy: () => 'manual' as never,
      announce: () => {},
      getBoardId: () => 'other',
    });
    filters.hydrateFromLastView('other', null);
    filters.applyFilterTags(['urgent']);
    // Arm the debounce as the host effect would; unmount (dispose) lands
    // inside the 300 ms window.
    filters.lastViewPersistTimer = setTimeout(() => {}, 300);
    filters.dispose();
    expect(filters.lastViewPersistTimer).toBeNull();
    const other = boardCacheStore.cache['other'] as unknown as {
      board: { settings: { lastView?: { filterTags?: string[] } } };
    };
    expect(other.board.settings.lastView?.filterTags).toEqual(['urgent']);
  });

  it('TaskListBoard + KanbanBoard teardowns flush the ARM-time snapshot for the captured id (source shape)', () => {
    for (const src of [TASKLIST_SRC, KANBAN_SRC]) {
      // The slice is snapshotted when the debounce is ARMED (not at flush
      // time — the next board's hydrate may have re-seeded the filter state
      // by teardown), and both the timer body and the cleanup flush it for
      // the CAPTURED id.
      const armIdx = src.indexOf('const nextLastView =');
      expect(armIdx).toBeGreaterThan(-1);
      const matches = src.match(/flushLastViewForBoard\(id, nextLastView\)/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
      // The old shape — clearTimeout with no flush in the cleanup — is gone:
      // every cleanup that clears the lastView timer also flushes.
      expect(src).not.toContain('boardStore.updateSettings({ lastView');
    }
  });
});

// ── 4.6 — TimerTile coarse persist ──────────────────────────────────────

describe('Audit-17 4.6 — coarse persist gate bounds countdown loss on quit/swap', () => {
  it('fires at most ⌈elapsed/interval⌉ times: 2 writes across a 90 s run', () => {
    const gate = createCoarsePersistGate(0);
    const fireTimes: number[] = [];
    // Simulate the 100 ms tick cadence for 90 s.
    for (let now = 100; now <= 90_000; now += 100) {
      if (gate(now)) fireTimes.push(now);
    }
    expect(fireTimes).toEqual([45_000, 90_000]);
  });

  it('on-disk staleness never exceeds the 45 s cadence (≤ 60 s of truth)', () => {
    expect(TIMER_COARSE_PERSIST_MS).toBeLessThanOrEqual(60_000);
    const gate = createCoarsePersistGate(0);
    let lastPersist = 0;
    let maxGap = 0;
    for (let now = 100; now <= 300_000; now += 100) {
      if (gate(now)) {
        maxGap = Math.max(maxGap, now - lastPersist);
        lastPersist = now;
      }
    }
    maxGap = Math.max(maxGap, 300_000 - lastPersist);
    expect(maxGap).toBeLessThanOrEqual(TIMER_COARSE_PERSIST_MS + 100);
  });

  it('never fires before one full interval after arming (no immediate write on resume)', () => {
    const gate = createCoarsePersistGate(10_000);
    expect(gate(10_100)).toBe(false);
    expect(gate(54_999)).toBe(false);
    expect(gate(55_000)).toBe(true);
  });

  it('TimerTile arms the gate per running countdown and persists `remaining` through it (source shape)', () => {
    expect(TIMER_SRC).toContain('createCoarsePersistGate(Date.now())');
    const idx = TIMER_SRC.indexOf('coarsePersistDue?.(now)');
    expect(idx).toBeGreaterThan(-1);
    const region = TIMER_SRC.slice(idx, idx + 500);
    expect(region).toContain('{ remaining: liveRemaining }');
  });
});

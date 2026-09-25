import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { sectionIdForPlacementIndex } from '@renderer/lib/tasklist/sectionMath';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, TaskListBoard, TaskListSection } from '@renderer/schema/index';

/**
 * Phase C — Task List placement CRUD on the board cache store.
 *
 * Mirrors the Phase B Kanban suite. Each test re-hydrates a clean fixture
 * so module-level state can't leak between cases.
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler> = {}): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function makeTaskListFixture(): BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'priority' },
      tasks: [],
    } as unknown as TaskListBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function defOf(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    // No frontmatter behind it, so the task's title is the filename stem.
    filePath: `${title}.md`,
    // `persistAddTaskPlacement` safeParses the def, so it needs the style
    // block's required colours and the text variant's `filePath`.
    style: {
      headerColor: '#000',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    createdAt: 0,
    updatedAt: 0,
  } as TileDefinition;
}

describe('boardCache — Task List CRUD', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture() },
      { tl: 'tasks.board.json' },
    );
  });
  afterEach(() => boardCacheStore.clear());

  it('persistAddTaskPlacement adds the def + placement and renumbers position', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 0); // insert at top

    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(tasks.map((p) => p.tileId)).toEqual(['t2', 't1']);
    expect(tasks[0].position).toBe(0);
    expect(tasks[1].position).toBe(1);
    expect(boardCacheStore.cache.tl.tileDefs.t1).toBeDefined();
    expect(boardCacheStore.cache.tl.tileDefs.t2).toBeDefined();
  });

  it('removeTaskPlacement drops both the placement and its tileDef', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);

    boardCacheStore.removeTaskPlacement('tl', 't1');
    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(tasks.map((p) => p.tileId)).toEqual(['t2']);
    expect(tasks[0].position).toBe(0);
    expect(boardCacheStore.cache.tl.tileDefs.t1).toBeUndefined();
    expect(boardCacheStore.cache.tl.tileDefs.t2).toBeDefined();
  });

  it('reorderTaskPlacement moves an existing placement to the target index', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t3', 'C'), 2);

    // Move t3 to position 0.
    boardCacheStore.reorderTaskPlacement('tl', 't3', 0);
    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(tasks.map((p) => p.tileId)).toEqual(['t3', 't1', 't2']);
    expect(tasks.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it('reorderTaskPlacement clamps targetPosition into bounds', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);

    boardCacheStore.reorderTaskPlacement('tl', 't1', 999);
    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(tasks.map((p) => p.tileId)).toEqual(['t2', 't1']);
  });

  it('reorderTaskPlacement is a no-op when the tile is not present', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.reorderTaskPlacement('tl', 'missing', 0);
    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(tasks.map((p) => p.tileId)).toEqual(['t1']);
  });

  it('DRAG-5: reorderTaskPlacement refuses (no-op + warn) on a sectioned board', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t3', 'C'), 2);
    // A real section means the helper (which doesn't adjust section ranges)
    // would desync the slices — it must bail rather than corrupt the board.
    boardCacheStore.persistTaskListStructure('tl', [
      { id: 'S', title: 'S', position: 0, collapsed: false },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    boardCacheStore.reorderTaskPlacement('tl', 't3', 0);

    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(tasks.map((p) => p.tileId)).toEqual(['t1', 't2', 't3']); // unchanged
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing on a sectioned board'));
    warn.mockRestore();
  });

  it('getFullTasksForBoard returns tile defs fused with synthetic placement', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);

    const tiles = boardCacheStore.getFullTasksForBoard('tl');
    expect(Object.keys(tiles).sort()).toEqual(['t1', 't2']);
    expect(tiles.t1.title).toBe('A');
    expect(tiles.t1.position).toEqual({ x: 0, y: 0 });
    expect(tiles.t1.boardId).toBe('tl');
  });

  it('getFullTasksForBoard returns {} for non-TaskList boards', () => {
    const empty = boardCacheStore.getFullTasksForBoard('does-not-exist');
    expect(empty).toEqual({});
  });

  it('findTileBoardId resolves Task List tileDefs', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    expect(boardCacheStore.findTileBoardId('t1')).toBe('tl');
  });

  it('setTaskListSavedViews replaces the savedViews array on the board settings', () => {
    const v1 = {
      id: 'v1',
      name: 'Today focus',
      groupBy: 'priority',
      sortBy: 'dueDate',
      filterTags: ['work'],
      filterStatus: null,
      filterPriority: 'high',
      showCompleted: false,
      smartList: 'today',
    };
    boardCacheStore.setTaskListSavedViews('tl', [v1]);
    const settings = (boardCacheStore.cache.tl.board as TaskListBoard).settings as Record<string, unknown>;
    expect(settings.savedViews).toEqual([v1]);

    // Replacing — the helper does not append, callers compose the new list.
    boardCacheStore.setTaskListSavedViews('tl', []);
    const cleared = (boardCacheStore.cache.tl.board as TaskListBoard).settings as Record<string, unknown>;
    expect(cleared.savedViews).toEqual([]);
  });

  it('setTaskListSavedViews is a no-op on non-tasklist boards', () => {
    // Bring a fresh non-task board into the cache and confirm the setter
    // doesn't mutate it. We re-hydrate to seed; the existing 'tl' fixture
    // stays present.
    const before = JSON.stringify(boardCacheStore.cache.tl.board);
    boardCacheStore.setTaskListSavedViews('does-not-exist', []);
    const after = JSON.stringify(boardCacheStore.cache.tl.board);
    expect(after).toBe(before);
  });
});

describe('boardCache — Task List hardening (parity with Kanban)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture() },
      { tl: 'tasks.board.json' },
    );
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    boardCacheStore.clear();
    warnSpy.mockRestore();
  });

  it('persistAddTaskPlacement rejects an invalid TileDefinition (no cache change, console warn)', () => {
    const badDef = { id: 'bad', type: 'text', title: 'x' } as unknown as TileDefinition;
    boardCacheStore.persistAddTaskPlacement('tl', badDef, 0);
    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(tasks).toEqual([]);
    expect(boardCacheStore.cache.tl.tileDefs.bad).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0];
    expect(typeof msg === 'string' && msg.includes('persistAddTaskPlacement')).toBe(true);
  });

  it('persistAddTaskPlacement self-heals an empty boardId via findBoardIdForTask', () => {
    // Seed: tile t1 lives on board 'tl'. A second insert that targets the
    // SAME tileId with an empty boardId should still land on 'tl' — the
    // cache-scan fallback recovers the owning board (re-add path).
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('', defOf('t1', 'A'), 0);
    // Self-heal targets the existing tileId; total task placements unchanged
    // structurally but the call did NOT warn.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(boardCacheStore.cache.tl.tileDefs.t1).toBeDefined();
  });

  it('persistAddTaskPlacement warns when no resolution is possible', () => {
    boardCacheStore.persistAddTaskPlacement('does-not-exist', defOf('orphan', 'X'), 0);
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0];
    expect(typeof msg === 'string' && msg.includes('tasklist:persistAddTaskPlacement')).toBe(true);
    // Cache untouched: no def written, no placement created.
    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(tasks).toEqual([]);
  });

  it('removeTaskPlacement warns when boardId resolves to nothing', () => {
    boardCacheStore.removeTaskPlacement('does-not-exist', 'missing');
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0];
    expect(typeof msg === 'string' && msg.includes('tasklist:removeTaskPlacement')).toBe(true);
  });

  it('reorderTaskPlacement warns on an unknown boardId instead of silent no-op', () => {
    boardCacheStore.reorderTaskPlacement('does-not-exist', 't1', 0);
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0];
    expect(typeof msg === 'string' && msg.includes('tasklist:reorderTaskPlacement')).toBe(true);
  });

  it('setTaskPlacementLocked warns on an unknown boardId', () => {
    boardCacheStore.setTaskPlacementLocked('does-not-exist', 't1', true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('updateTaskPlacementStyle warns on an unknown boardId', () => {
    boardCacheStore.updateTaskPlacementStyle('does-not-exist', 't1', { headerColor: '#abc' });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('persistTaskListStructure warns on an unknown boardId', () => {
    boardCacheStore.persistTaskListStructure('does-not-exist', []);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('boardCache — Task List previously-untested mutators', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture() },
      { tl: 'tasks.board.json' },
    );
  });
  afterEach(() => boardCacheStore.clear());

  it('setTaskPlacementLocked stamps `locked: true` and removes the field when unlocked', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);

    boardCacheStore.setTaskPlacementLocked('tl', 't1', true);
    let placements = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(placements[0].locked).toBe(true);

    boardCacheStore.setTaskPlacementLocked('tl', 't1', false);
    placements = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(placements[0].locked).toBeUndefined();
  });

  it('updateTaskPlacementStyle merges partial style and clears the field when null/empty', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);

    boardCacheStore.updateTaskPlacementStyle('tl', 't1', { headerColor: '#abc' });
    let placements = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(placements[0].style).toEqual({ headerColor: '#abc' });

    // Merge a second partial — both fields persist.
    boardCacheStore.updateTaskPlacementStyle('tl', 't1', { bodyColor: '#def' });
    placements = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(placements[0].style).toEqual({ headerColor: '#abc', bodyColor: '#def' });

    // Null clears.
    boardCacheStore.updateTaskPlacementStyle('tl', 't1', null);
    placements = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(placements[0].style).toBeUndefined();

    // Empty partial also clears (defensive parity).
    boardCacheStore.updateTaskPlacementStyle('tl', 't1', { headerColor: '#abc' });
    boardCacheStore.updateTaskPlacementStyle('tl', 't1', {});
    placements = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(placements[0].style).toBeUndefined();
  });

  it('updateTaskPlacementStyle persists borderColor and fontSizeBody overrides', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);

    boardCacheStore.updateTaskPlacementStyle('tl', 't1', {
      borderColor: '#abc',
      fontSizeTitle: 18,
      fontSizeBody: 14,
    });
    const placements = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    expect(placements[0].style).toEqual({
      borderColor: '#abc',
      fontSizeTitle: 18,
      fontSizeBody: 14,
    });
  });

  it('persistTaskListStructure normalises section positions into [0, taskCount]', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);

    boardCacheStore.persistTaskListStructure('tl', [
      { id: 's-neg', title: 'Past start', position: -5, collapsed: false },
      { id: 's-mid', title: 'Mid', position: 1, collapsed: false },
      { id: 's-end', title: 'Past end', position: 99, collapsed: false },
    ]);

    const sections = (boardCacheStore.cache.tl.board as TaskListBoard).sections ?? [];
    // Sorted in ascending position order; clamped to [0, 2] (taskCount = 2).
    expect(sections.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(sections.map((s) => s.id)).toEqual(['s-neg', 's-mid', 's-end']);
  });

  it('persistTaskListStructure PRESERVES an in-range tie (empty section before a populated one)', () => {
    // Cross-section drag regression guard. Three sections, one task each; the
    // middle task is dragged up so section 2 is emptied. The drag pipeline
    // persists the (correct) tied positions [s1:0, s2:2, s3:2] — s2 owns the
    // empty [2,2) slice, s3 owns [2,3). The OLD strict-increasing normalization
    // bumped s3 → 3, re-partitioning the array so s2 stole s3's task. An in-range
    // tie must survive (schema/board.ts: "Empty sections are representable (two
    // consecutive section positions)").
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t3', 'C'), 2);

    boardCacheStore.persistTaskListStructure('tl', [
      { id: 's1', title: 'One', position: 0, collapsed: false },
      { id: 's2', title: 'Two', position: 2, collapsed: false },
      { id: 's3', title: 'Three', position: 2, collapsed: false },
    ]);

    const sections = (boardCacheStore.cache.tl.board as TaskListBoard).sections ?? [];
    // s1 → [0,2)={A,B}, s2 → [2,2)={} (empty), s3 → [2,3)={C}. The tie at 2 stays.
    expect(sections.map((s) => s.position)).toEqual([0, 2, 2]);
    expect(sections.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('persistTaskListStructure PINS empty TAIL ties at taskCount (SEC-2: no position > taskCount)', () => {
    // Trailing empty sections are all zero-length regardless of order, so they
    // pin at taskCount rather than being bumped to taskCount+1, taskCount+2, …
    // A position > taskCount is not a valid index into `tasks`: it can't own a
    // task and silently misroutes a later add-to-section (SEC-1). The bump used
    // to emit [0, 3, 4]; the on-disk invariant now holds at [0, 3, 3].
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t3', 'C'), 2);

    boardCacheStore.persistTaskListStructure('tl', [
      { id: 's1', title: 'One', position: 0, collapsed: false },
      { id: 's2', title: 'Tail A', position: 3, collapsed: false },
      { id: 's3', title: 'Tail B', position: 3, collapsed: false },
    ]);

    const sections = (boardCacheStore.cache.tl.board as TaskListBoard).sections ?? [];
    expect(sections.map((s) => s.position)).toEqual([0, 3, 3]);
    expect(sections.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('SEC-1: adds a task into the 2nd empty tail section, not an earlier neighbour', () => {
    // One populated section A owning [t1,t2,t3]; B and C are empty tail sections.
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t3', 'C'), 2);
    boardCacheStore.persistTaskListStructure('tl', [
      { id: 'A', title: 'A', position: 0, collapsed: false },
      { id: 'B', title: 'B', position: 3, collapsed: false },
      { id: 'C', title: 'C', position: 3, collapsed: false },
    ]);

    // Add a task explicitly targeting the SECOND empty section (C). The insert
    // index (3) is what endOfSectionIndex(C) computes; targetSectionId='C'
    // pins it into C.
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t4', 'D'), 3, undefined, 'C');

    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    const sections = (boardCacheStore.cache.tl.board as TaskListBoard).sections ?? [];
    const t4Idx = tasks.findIndex((p) => p.tileId === 't4');
    expect(t4Idx).toBeGreaterThanOrEqual(0);
    // The new task lands in C (the targeted section), NOT in A (the misroute).
    expect(sectionIdForPlacementIndex(sections as TaskListSection[], t4Idx)).toBe('C');
    // B stays empty — no placement index resolves to it.
    const ownedByB = tasks
      .map((_, i) => sectionIdForPlacementIndex(sections as TaskListSection[], i))
      .filter((id) => id === 'B');
    expect(ownedByB).toEqual([]);
  });

  it('SEC-1: adds a task into the 1st empty tail section, bumping the later tie', () => {
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t3', 'C'), 2);
    boardCacheStore.persistTaskListStructure('tl', [
      { id: 'A', title: 'A', position: 0, collapsed: false },
      { id: 'B', title: 'B', position: 3, collapsed: false },
      { id: 'C', title: 'C', position: 3, collapsed: false },
    ]);

    // Target the FIRST empty section (B): the later tie (C) must shift to 4 so
    // B owns the new slot and C stays empty.
    boardCacheStore.persistAddTaskPlacement('tl', defOf('t4', 'D'), 3, undefined, 'B');

    const tasks = (boardCacheStore.cache.tl.board as TaskListBoard).tasks ?? [];
    const sections = (boardCacheStore.cache.tl.board as TaskListBoard).sections ?? [];
    const t4Idx = tasks.findIndex((p) => p.tileId === 't4');
    expect(sectionIdForPlacementIndex(sections as TaskListSection[], t4Idx)).toBe('B');
    expect(sections.map((s) => s.position)).toEqual([0, 3, 4]);
  });

  it('setTaskListCollapsedSubtasks round-trips a tile-id array', () => {
    boardCacheStore.setTaskListCollapsedSubtasks('tl', ['t1', 't2']);
    const tl = boardCacheStore.cache.tl.board as TaskListBoard;
    expect(tl.collapsedSubtasks).toEqual(['t1', 't2']);

    // Replace — full replacement, not append.
    boardCacheStore.setTaskListCollapsedSubtasks('tl', []);
    expect((boardCacheStore.cache.tl.board as TaskListBoard).collapsedSubtasks).toEqual([]);
  });
});

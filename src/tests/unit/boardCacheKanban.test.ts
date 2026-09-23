import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, KanbanBoard } from '@renderer/schema/index';

/**
 * Phase B — Kanban placement CRUD on the board cache store.
 *
 * Each test re-hydrates a clean fixture so module-level state can't leak
 * between cases. We don't go through the debounced disk writer here —
 * `markDirty` schedules a setTimeout, but the cache mutation we care about
 * has already happened synchronously by the time it fires.
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
      columns: [
        { id: 'c1', title: 'To Do', position: 0, collapsed: false, tilePlacements: [] },
        { id: 'c2', title: 'Done', position: 1, collapsed: false, tilePlacements: [] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function defOf(id: string, title: string, type = 'text'): TileDefinition {
  // R5 — `TileDefinitionSchema` is a discriminated union; each variant
  // requires its own type-specific fields. Seed the minimum payload for
  // text (the only `type` callers use here) so `persistAddKanbanPlacement`'s
  // safeParse doesn't drop the def for a missing `contentId`.
  const base = {
    id,
    type,
    title,
    style: {
      headerColor: '#000',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
  if (type === 'text') {
    return { ...base, contentId: `doc_${id}`, content: '' } as TileDefinition;
  }
  return base as TileDefinition;
}

describe('boardCache — Kanban CRUD', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { kb: makeKanbanFixture() },
      { kb: 'tasks.board.json' },
    );
  });
  afterEach(() => boardCacheStore.clear());

  it('addKanbanColumn appends a column with default placement-array', () => {
    boardCacheStore.addKanbanColumn('kb', { id: 'c3', title: 'In Review' });
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect(cols).toHaveLength(3);
    expect(cols[2].id).toBe('c3');
    expect(cols[2].tilePlacements).toEqual([]);
    expect(cols[2].collapsed).toBe(false);
  });

  it('renameKanbanColumn rewrites the title without touching placements', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'Tile A'), 0);
    boardCacheStore.renameKanbanColumn('kb', 'c1', 'Backlog');
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect(cols[0].title).toBe('Backlog');
    expect((cols[0].tilePlacements ?? []).length).toBe(1);
  });

  it('removeKanbanColumn drops the column and leaves the rest intact', () => {
    boardCacheStore.removeKanbanColumn('kb', 'c1');
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect(cols).toHaveLength(1);
    expect(cols[0].id).toBe('c2');
  });

  it('reorderKanbanColumns swaps columns by id and renumbers position', () => {
    boardCacheStore.reorderKanbanColumns('kb', ['c2', 'c1']);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect(cols.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(cols[0].position).toBe(0);
    expect(cols[1].position).toBe(1);
  });

  it('setAllKanbanColumnsCollapsed flips collapsed on every column', () => {
    boardCacheStore.setAllKanbanColumnsCollapsed('kb', true);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect(cols.every((c) => c.collapsed === true)).toBe(true);

    boardCacheStore.setAllKanbanColumnsCollapsed('kb', false);
    const cols2 = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect(cols2.every((c) => c.collapsed === false)).toBe(true);
  });

  it('persistAddKanbanPlacement adds the def + placement and renumbers position', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t2', 'B'), 0); // insert at top

    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    const placements = cols[0].tilePlacements ?? [];
    expect(placements.map((p) => p.tileId)).toEqual(['t2', 't1']);
    expect(placements[0].position).toBe(0);
    expect(placements[1].position).toBe(1);
    expect(boardCacheStore.cache.kb.tileDefs.t1).toBeDefined();
    expect(boardCacheStore.cache.kb.tileDefs.t2).toBeDefined();
  });

  it('persistAddKanbanPlacement clamps a negative position to the head, not the tail (L9)', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t2', 'B'), 1);
    // A stray negative position must floor to 0 (insert at head). The old
    // high-end-only clamp `Math.min(position, len)` left -1 as `splice(-1, …)`,
    // which inserts BEFORE the last element → ['t1','t3','t2'].
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t3', 'C'), -1);

    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    const placements = cols[0].tilePlacements ?? [];
    expect(placements.map((p) => p.tileId)).toEqual(['t3', 't1', 't2']);
    expect(placements.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it('removeKanbanPlacement drops both the placement and its tileDef', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t2', 'B'), 1);

    boardCacheStore.removeKanbanPlacement('kb', 't1');
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    const placements = cols[0].tilePlacements ?? [];
    expect(placements.map((p) => p.tileId)).toEqual(['t2']);
    expect(placements[0].position).toBe(0);
    expect(boardCacheStore.cache.kb.tileDefs.t1).toBeUndefined();
    expect(boardCacheStore.cache.kb.tileDefs.t2).toBeDefined();
  });

  it('moveKanbanPlacement transfers the placement between columns', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t2', 'B'), 1);
    boardCacheStore.moveKanbanPlacement('kb', 't1', 'c2', 0);

    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0].tilePlacements ?? []).map((p) => p.tileId)).toEqual(['t2']);
    expect((cols[1].tilePlacements ?? []).map((p) => p.tileId)).toEqual(['t1']);
    // tileDefs unchanged.
    expect(boardCacheStore.cache.kb.tileDefs.t1).toBeDefined();
  });

  it('moveKanbanPlacement reorders within the same column when target == source column', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t3', 'C'), 2);

    // Move t3 to position 0.
    boardCacheStore.moveKanbanPlacement('kb', 't3', 'c1', 0);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0].tilePlacements ?? []).map((p) => p.tileId)).toEqual(['t3', 't1', 't2']);
  });

  it('moveKanbanPlacements bulk-moves cards from multiple columns into a target column', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c2', defOf('t3', 'C'), 0);

    // Move t1 + t3 to column c2 at position 0 — they should land contiguous
    // in the order given.
    boardCacheStore.moveKanbanPlacements('kb', ['t1', 't3'], 'c2', 0);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0].tilePlacements ?? []).map((p) => p.tileId)).toEqual(['t2']);
    expect((cols[1].tilePlacements ?? []).map((p) => p.tileId)).toEqual(['t1', 't3']);
    // Positions are reindexed.
    expect((cols[1].tilePlacements ?? []).map((p) => p.position)).toEqual([0, 1]);
  });

  it('moveKanbanPlacements preserves caller order even when input is shuffled', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t3', 'C'), 2);

    // Caller passes the IDs in reverse: t3, t2, t1 — the destination should
    // honour that ordering.
    boardCacheStore.moveKanbanPlacements('kb', ['t3', 't2', 't1'], 'c2', 0);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[1].tilePlacements ?? []).map((p) => p.tileId)).toEqual(['t3', 't2', 't1']);
  });

  it('moveKanbanPlacements within the same column does a contiguous reorder', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t2', 'B'), 1);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t3', 'C'), 2);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t4', 'D'), 3);

    // Drag t1 + t4 to land at the start.
    boardCacheStore.moveKanbanPlacements('kb', ['t1', 't4'], 'c1', 0);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0].tilePlacements ?? []).map((p) => p.tileId)).toEqual(['t1', 't4', 't2', 't3']);
  });

  it('moveKanbanPlacements silently skips tile IDs that are not on the board', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);

    // 'ghost' doesn't exist; t1 should still move.
    boardCacheStore.moveKanbanPlacements('kb', ['ghost', 't1'], 'c2', 0);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0].tilePlacements ?? []).map((p) => p.tileId)).toEqual([]);
    expect((cols[1].tilePlacements ?? []).map((p) => p.tileId)).toEqual(['t1']);
  });

  it('moveKanbanPlacements is a no-op when given an empty list', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);

    boardCacheStore.moveKanbanPlacements('kb', [], 'c2', 0);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0].tilePlacements ?? []).map((p) => p.tileId)).toEqual(['t1']);
    expect((cols[1].tilePlacements ?? []).map((p) => p.tileId)).toEqual([]);
  });

  it('getFullTilesForKanbanBoard returns tile defs fused with synthetic placement', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c2', defOf('t2', 'B'), 0);

    const tiles = boardCacheStore.getFullTilesForKanbanBoard('kb');
    expect(Object.keys(tiles).sort()).toEqual(['t1', 't2']);
    expect(tiles.t1.title).toBe('A');
    expect(tiles.t1.position).toEqual({ x: 0, y: 0 });
    expect(tiles.t1.boardId).toBe('kb');
  });

  it('getFullTilesForKanbanBoard returns {} for non-Kanban boards', () => {
    const empty = boardCacheStore.getFullTilesForKanbanBoard('does-not-exist');
    expect(empty).toEqual({});
  });

  it('findTileBoardId resolves Kanban tileDefs even though there is no MindMap placement', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    expect(boardCacheStore.findTileBoardId('t1')).toBe('kb');
  });

  it('setKanbanPlacementCoverImage stores and clears the cover-image path on the placement', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);

    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', 'media/cover.png');
    let cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    let placement = (cols[0].tilePlacements ?? [])[0] as Record<string, unknown>;
    expect(placement.coverImage).toBe('media/cover.png');

    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', null);
    cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    placement = (cols[0].tilePlacements ?? [])[0] as Record<string, unknown>;
    expect(placement.coverImage).toBeUndefined();

    // Empty string also clears (matches the helper's contract).
    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', 'a/b.png');
    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', '');
    cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    placement = (cols[0].tilePlacements ?? [])[0] as Record<string, unknown>;
    expect(placement.coverImage).toBeUndefined();
  });

  it('setKanbanPlacementCoverImage is a no-op for unknown tile ids', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.setKanbanPlacementCoverImage('kb', 'unknown', 'x.png');
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    const placement = (cols[0].tilePlacements ?? [])[0] as Record<string, unknown>;
    expect(placement.coverImage).toBeUndefined();
  });

  it('setKanbanColumnWipLimit stores a positive integer and clears with null / 0', () => {
    boardCacheStore.setKanbanColumnWipLimit('kb', 'c1', 5);
    let cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0] as Record<string, unknown>).wipLimit).toBe(5);

    boardCacheStore.setKanbanColumnWipLimit('kb', 'c1', null);
    cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0] as Record<string, unknown>).wipLimit).toBeUndefined();

    // Zero is treated as "no limit" — strips the field rather than storing 0.
    boardCacheStore.setKanbanColumnWipLimit('kb', 'c1', 3);
    boardCacheStore.setKanbanColumnWipLimit('kb', 'c1', 0);
    cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0] as Record<string, unknown>).wipLimit).toBeUndefined();

    // Fractional values are floored.
    boardCacheStore.setKanbanColumnWipLimit('kb', 'c1', 4.9);
    cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0] as Record<string, unknown>).wipLimit).toBe(4);
  });

  it('setKanbanColumnWidth stores per-column width and clears with null', () => {
    boardCacheStore.setKanbanColumnWidth('kb', 'c1', 320);
    let cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    let style = (cols[0] as Record<string, unknown>).style as Record<string, unknown> | undefined;
    expect(style?.width).toBe(320);

    // null clears the override and removes the (now-empty) style object.
    boardCacheStore.setKanbanColumnWidth('kb', 'c1', null);
    cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0] as Record<string, unknown>).style).toBeUndefined();

    // Zero / non-positive widths are treated as a clear.
    boardCacheStore.setKanbanColumnWidth('kb', 'c1', 240);
    boardCacheStore.setKanbanColumnWidth('kb', 'c1', 0);
    cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect((cols[0] as Record<string, unknown>).style).toBeUndefined();

    // Fractional widths are rounded.
    boardCacheStore.setKanbanColumnWidth('kb', 'c1', 280.6);
    cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    style = (cols[0] as Record<string, unknown>).style as Record<string, unknown> | undefined;
    expect(style?.width).toBe(281);

    // Preserves other style fields when clearing only the width override.
    (boardCacheStore.cache.kb.board as KanbanBoard).columns[0].style = {
      headerColor: '#abc',
      width: 320,
    };
    boardCacheStore.setKanbanColumnWidth('kb', 'c1', null);
    cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    style = (cols[0] as Record<string, unknown>).style as Record<string, unknown> | undefined;
    expect(style).toEqual({ headerColor: '#abc' });
  });

  it('getFullTilesForKanbanBoard preserves def-level locked / faded flags (H3)', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', defOf('t1', 'A'), 0);
    boardCacheStore.persistAddKanbanPlacement('kb', 'c2', defOf('t2', 'B'), 0);

    // Simulate Mind Map's TileHeader lock toggle / fade affordance stamping
    // these flags directly onto the tileDef. The Kanban view must surface
    // them so the flow-layout card honours the lock (H4 drag guard reads
    // tile.locked).
    const defs = boardCacheStore.cache.kb.tileDefs as Record<string, Record<string, unknown>>;
    defs.t1.locked = true;
    defs.t2.faded = true;

    const tiles = boardCacheStore.getFullTilesForKanbanBoard('kb');
    expect(tiles.t1.locked).toBe(true);
    expect(tiles.t1.faded).toBe(false);
    expect(tiles.t2.locked).toBe(false);
    expect(tiles.t2.faded).toBe(true);
  });

  it('setKanbanSavedViews replaces the savedViews list on board settings', () => {
    boardCacheStore.setKanbanSavedViews('kb', [
      { id: 'v1', name: 'My Work', sortBy: 'priority', filterTags: ['urgent'], filterProp: null },
      {
        id: 'v2',
        name: 'Blocked',
        sortBy: 'manual',
        filterTags: [],
        filterProp: { key: 'status', value: 'blocked' },
      },
    ]);
    const settings = (boardCacheStore.cache.kb.board as KanbanBoard).settings as Record<string, unknown>;
    const views = settings.savedViews as Array<Record<string, unknown>>;
    expect(views).toHaveLength(2);
    expect(views[0].name).toBe('My Work');
    expect(views[1].filterProp).toEqual({ key: 'status', value: 'blocked' });

    // Subsequent calls replace the list outright.
    boardCacheStore.setKanbanSavedViews('kb', []);
    const after = (boardCacheStore.cache.kb.board as KanbanBoard).settings as Record<string, unknown>;
    expect(after.savedViews).toEqual([]);
  });
});

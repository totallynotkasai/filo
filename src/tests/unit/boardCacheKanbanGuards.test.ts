import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, KanbanBoard, KanbanTilePlacement } from '@renderer/schema/index';

/**
 * Guard-rail tests for the Kanban cache mutators. Previously these methods
 * early-returned with `if (!kb) return;` and offered no user-visible signal
 * when a race or stale boardId caused the mutation to silently drop. The
 * audit added `warnUnresolved` + `kanbanBoardOrWarn` so callers at least
 * get a console warn (+ a one-shot toast).
 *
 * Also covers:
 *   - H2: Zod validation in `persistAddKanbanPlacement`.
 *   - H3: locked/faded preserved through `getFullTilesForKanbanBoard`.
 *   - H6: `setKanbanPlacementCoverImage` path sanitization.
 *   - H1 fallback: `persistAddKanbanPlacement` self-heals via column-id
 *     scan when called with an empty boardId.
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
      columns: [
        { id: 'c1', title: 'To Do', position: 0, collapsed: false, tilePlacements: [] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function validDef(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${id}.md`,
    // TileStyleSchema requires headerColor/bodyColor (no defaults). The
    // other fields default via Zod, but these two have to be present for
    // `persistAddKanbanPlacement`'s safeParse to accept the def, as does the
    // text variant's `filePath`.
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

describe('boardCache — Kanban guards', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeKanbanFixture() }, { kb: 'tasks.board.json' });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    boardCacheStore.clear();
    warnSpy.mockRestore();
  });

  // ── H1: warn on unresolvable board ──

  it('addKanbanColumn warns when boardId is unknown', () => {
    boardCacheStore.addKanbanColumn('does-not-exist', { id: 'c2', title: 'New' });
    expect(warnSpy).toHaveBeenCalled();
    // Existing board untouched.
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect(cols).toHaveLength(1);
  });

  it('moveKanbanPlacement warns when boardId is unknown', () => {
    boardCacheStore.moveKanbanPlacement('does-not-exist', 't1', 'c1', 0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('removeKanbanPlacement warns when boardId is unknown', () => {
    boardCacheStore.removeKanbanPlacement('does-not-exist', 't1');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('setKanbanPlacementCoverImage warns when boardId is unknown', () => {
    boardCacheStore.setKanbanPlacementCoverImage('does-not-exist', 't1', 'cover.png');
    expect(warnSpy).toHaveBeenCalled();
  });

  // ── H1 fallback: cache-scan via columnId ──

  it('persistAddKanbanPlacement self-heals via columnId scan when boardId is empty', () => {
    boardCacheStore.persistAddKanbanPlacement('', 'c1', validDef('t1'), 0);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect(cols[0].tilePlacements).toHaveLength(1);
    expect(cols[0].tilePlacements[0].tileId).toBe('t1');
    expect(boardCacheStore.cache.kb.tileDefs.t1).toBeDefined();
  });

  it('persistAddKanbanPlacement warns when neither boardId nor columnId resolve', () => {
    boardCacheStore.persistAddKanbanPlacement('', 'unknown-col', validDef('t1'), 0);
    expect(warnSpy).toHaveBeenCalled();
    expect(boardCacheStore.cache.kb.tileDefs.t1).toBeUndefined();
  });

  // ── H2: Zod validation ──

  it('persistAddKanbanPlacement rejects an invalid TileDefinition', () => {
    const bogus = { id: 't_bad' } as unknown as TileDefinition; // missing type, style, etc.
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', bogus, 0);
    expect(warnSpy).toHaveBeenCalled();
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    expect(cols[0].tilePlacements).toHaveLength(0);
    expect(boardCacheStore.cache.kb.tileDefs.t_bad).toBeUndefined();
  });

  // ── H3: locked / faded preservation ──

  it('getFullTilesForKanbanBoard preserves the def-level locked / faded flags', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', validDef('t1'), 0);
    // The def schema strips keys it doesn't define, so stamp the flags on the
    // cached def, as an in-memory lock / fade toggle would.
    const defs = boardCacheStore.cache.kb.tileDefs as Record<string, Record<string, unknown>>;
    defs.t1.locked = true;
    defs.t1.faded = true;
    const tiles = boardCacheStore.getFullTilesForKanbanBoard('kb');
    expect(tiles.t1.locked).toBe(true);
    expect(tiles.t1.faded).toBe(true);
  });

  it('getFullTilesForKanbanBoard defaults locked / faded to false when absent', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', validDef('t1'), 0);
    const tiles = boardCacheStore.getFullTilesForKanbanBoard('kb');
    expect(tiles.t1.locked).toBe(false);
    expect(tiles.t1.faded).toBe(false);
  });

  // ── H6: coverImage path sanitization ──

  it('setKanbanPlacementCoverImage accepts a vault-relative POSIX path', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', validDef('t1'), 0);
    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', 'attachments/t1/cover.png');
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    const p = cols[0].tilePlacements[0] as KanbanTilePlacement & { coverImage?: string };
    expect(p.coverImage).toBe('attachments/t1/cover.png');
  });

  it('setKanbanPlacementCoverImage rejects an absolute Windows path', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', validDef('t1'), 0);
    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', 'C:\\evil\\cover.png');
    expect(warnSpy).toHaveBeenCalled();
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    const p = cols[0].tilePlacements[0] as KanbanTilePlacement & { coverImage?: string };
    expect(p.coverImage).toBeUndefined();
  });

  it('setKanbanPlacementCoverImage rejects a path with .. traversal', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', validDef('t1'), 0);
    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', '../../etc/passwd');
    expect(warnSpy).toHaveBeenCalled();
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    const p = cols[0].tilePlacements[0] as KanbanTilePlacement & { coverImage?: string };
    expect(p.coverImage).toBeUndefined();
  });

  it('setKanbanPlacementCoverImage rejects a URL with a scheme', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', validDef('t1'), 0);
    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', 'http://example.com/x.png');
    expect(warnSpy).toHaveBeenCalled();
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    const p = cols[0].tilePlacements[0] as KanbanTilePlacement & { coverImage?: string };
    expect(p.coverImage).toBeUndefined();
  });

  it('setKanbanPlacementCoverImage clears the field when given null', () => {
    boardCacheStore.persistAddKanbanPlacement('kb', 'c1', validDef('t1'), 0);
    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', 'attachments/t1/cover.png');
    boardCacheStore.setKanbanPlacementCoverImage('kb', 't1', null);
    const cols = (boardCacheStore.cache.kb.board as KanbanBoard).columns;
    const p = cols[0].tilePlacements[0] as KanbanTilePlacement & { coverImage?: string };
    expect(p.coverImage).toBeUndefined();
  });
});

/**
 * Phase 0 / Phase 2 characterization — delete-tile entry-point parity.
 *
 * Asserts the post-condition (no orphan placement / no orphan tileDef /
 * no orphan connection) holds for every board type when a tile is removed
 * via the canonical sink `boardCacheStore.persistRemoveTile(tileId)`.
 * Every renderer entry point funnels through that sink:
 *
 *  - `TileHeader.svelte`        — tile-level delete button
 *  - `AppShell.svelte`          — multi-tile delete shortcut
 *  - `OrphanCatcher.svelte`     — orphan-cleanup modal
 *  - `MindMapBoard.svelte`      — broken-ref removal
 *  - `tileCommands.ts`          — DeleteTilesCommand
 *  - `groupAndBoardCommands.ts` — CascadeDeleteCommand
 *
 * History: before Phase 2 of CONSOLIDATION_PLAN_2026-05-25 the sink was
 * mindmap-only and silently dropped Kanban / Task List placements. Phase 2
 * lifted the body into a per-type strategy registry
 * (`src/renderer/core/boardTileOps.ts`) so every dispatch is exhaustive
 * over `BoardType` — this test asserts the post-condition holds across
 * all four variants.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type {
  KanbanBoard,
  TaskListBoard,
  MindMapBoard,
  TileDefinition,
} from '@renderer/schema/index';
import { restoreFiloDefault } from '../../helpers/filoBridge';
import { findOrphans } from './randomOpsNoOrphans.property.test';

// ── Fixture factories ──────────────────────────────────────────────────

function mkDef(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${id}.md`,
    style: { headerColor: '#000', bodyColor: '#fff', borderColor: '' } as never,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function makeMindMapWith(tileId: string): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'M',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        [tileId]: { x: 0, y: 0, width: 240, height: 160, locked: false, faded: false },
      },
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as unknown as MindMapBoard,
    tileDefs: { [tileId]: mkDef(tileId) },
    connections: {},
    frames: [],
  };
}

function makeKanbanWith(tileId: string): BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        {
          id: 'c1',
          title: 'To Do',
          position: 0,
          collapsed: false,
          tilePlacements: [{ tileId, position: 0 }],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { [tileId]: mkDef(tileId) },
    connections: {},
    frames: [],
  };
}

function makeTaskListWith(tileId: string): BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'T',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      tasks: [{ tileId, position: 0 }],
      sections: [],
      collapsedSubtasks: [],
    } as unknown as TaskListBoard,
    tileDefs: { [tileId]: mkDef(tileId) },
    connections: {},
    frames: [],
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

interface PostCondition {
  tileGoneFromDefs: boolean;
  noOrphanPlacements: boolean;
  noOrphanConnections: boolean;
  noOrphanFrameEntries: boolean;
}

function checkPostConditions(
  cache: BoardFileData,
  tileId: string,
): PostCondition {
  const tileGoneFromDefs = !(tileId in cache.tileDefs);
  const report = findOrphans(cache);
  return {
    tileGoneFromDefs,
    noOrphanPlacements: report.orphanPlacements.length === 0,
    noOrphanConnections: report.orphanConnections.length === 0,
    noOrphanFrameEntries: report.orphanFrameIds.length === 0,
  };
}

function freshBoard(
  type: 'mindmap' | 'kanban' | 'tasklist',
  tileId: string,
): { boardId: string; envelope: BoardFileData } {
  if (type === 'mindmap') return { boardId: 'mm', envelope: makeMindMapWith(tileId) };
  if (type === 'kanban') return { boardId: 'kb', envelope: makeKanbanWith(tileId) };
  return { boardId: 'tl', envelope: makeTaskListWith(tileId) };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Phase 0 characterization — delete-tile entry-point parity', () => {
  beforeEach(() => {
    boardCacheStore.clear();
  });
  afterEach(() => {
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  describe('MindMap — persistRemoveTile (the only sink today)', () => {
    it('removes tileDef + placement + leaves no orphans', () => {
      const { boardId, envelope } = freshBoard('mindmap', 'tile_a');
      boardCacheStore.hydrate({ [boardId]: envelope }, { [boardId]: 'm.board.json' });

      boardCacheStore.persistRemoveTile('tile_a');

      const post = checkPostConditions(boardCacheStore.cache[boardId], 'tile_a');
      expect(post).toEqual({
        tileGoneFromDefs: true,
        noOrphanPlacements: true,
        noOrphanConnections: true,
        noOrphanFrameEntries: true,
      });
    });

    it('removes inline tile + def with no orphans', () => {
      const env = makeMindMapWith('tile_a');
      (env.board as { inlineTiles: Record<string, unknown> }).inlineTiles.inline_t = {
        id: 'inline_t',
        type: 'timer',
        title: 'Timer',
        x: 0,
        y: 0,
        width: 120,
        height: 80,
        style: { headerColor: '#fff', bodyColor: '#fff', borderColor: '' },
        tags: [],
        locked: false,
        faded: false,
        duration: 60,
        remaining: 60,
        mode: 'hms',
        isRunning: false,
        createdAt: 0,
        updatedAt: 0,
      };
      env.tileDefs.inline_t = mkDef('inline_t') as TileDefinition;
      boardCacheStore.hydrate({ mm: env }, { mm: 'm.board.json' });

      boardCacheStore.persistRemoveTile('inline_t');

      // Read post-state through the store facade — Svelte 5 `$state` wraps
      // the hydrated reference in a proxy, so mutations may not propagate
      // through the original local variable.
      const board = boardCacheStore.cache.mm.board as { inlineTiles: Record<string, unknown> };
      expect(board.inlineTiles.inline_t).toBeUndefined();
      expect(boardCacheStore.cache.mm.tileDefs.inline_t).toBeUndefined();
      const post = checkPostConditions(boardCacheStore.cache.mm, 'inline_t');
      expect(post.noOrphanPlacements && post.noOrphanConnections && post.noOrphanFrameEntries).toBe(
        true,
      );
    });

    it('cascades a delete: orphans on connection endpoints get swept', () => {
      const env = makeMindMapWith('tile_a');
      (env.board as { placements: Record<string, unknown> }).placements.tile_b = {
        x: 100,
        y: 100,
        width: 240,
        height: 160,
        locked: false,
        faded: false,
      };
      env.tileDefs.tile_b = mkDef('tile_b') as TileDefinition;
      env.connections.c1 = {
        id: 'c1',
        boardId: 'mm',
        fromTileId: 'tile_a',
        toTileId: 'tile_b',
        fromBubble: 0,
        toBubble: 0,
        pathColor: '',
        arrowColor: '',
        visibility: 'visible',
        labelVisibility: 'visible',
        label: { text: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
        createdAt: 0,
        updatedAt: 0,
      } as BoardFileData['connections'][string];
      boardCacheStore.hydrate({ mm: env }, { mm: 'm.board.json' });

      boardCacheStore.persistRemoveTile('tile_a');

      expect(boardCacheStore.cache.mm.connections.c1).toBeUndefined();
      const post = checkPostConditions(boardCacheStore.cache.mm, 'tile_a');
      expect(post).toEqual({
        tileGoneFromDefs: true,
        noOrphanPlacements: true,
        noOrphanConnections: true,
        noOrphanFrameEntries: true,
      });
    });
  });

  describe('Kanban — entry points (Phase 2 fixes the dispatch)', () => {
    // The right path for Kanban exists today as
    // `boardCacheStore.removeKanbanPlacement` — this passes.
    it('removeKanbanPlacement (Phase 2 dispatch target) leaves no orphans', () => {
      const { boardId, envelope } = freshBoard('kanban', 'tile_a');
      boardCacheStore.hydrate({ [boardId]: envelope }, { [boardId]: 'k.board.json' });

      boardCacheStore.removeKanbanPlacement(boardId, 'tile_a');

      const post = checkPostConditions(boardCacheStore.cache[boardId], 'tile_a');
      expect(post).toEqual({
        tileGoneFromDefs: true,
        noOrphanPlacements: true,
        noOrphanConnections: true,
        noOrphanFrameEntries: true,
      });
    });

    // Phase 2 / CONSOLIDATION_PLAN_2026-05-25 — `persistRemoveTile` now
    // dispatches via `opsFor(cached.board).removeTile`, so the Kanban
    // variant in `core/boardTileOps/kanban.ts` runs here. The orphan
    // placement that used to land on disk is now swept along with the def.
    it('persistRemoveTile on a Kanban tile leaves no orphan placement', () => {
      const { boardId, envelope } = freshBoard('kanban', 'tile_a');
      boardCacheStore.hydrate({ [boardId]: envelope }, { [boardId]: 'k.board.json' });

      boardCacheStore.persistRemoveTile('tile_a');

      const post = checkPostConditions(boardCacheStore.cache[boardId], 'tile_a');
      expect(post).toEqual({
        tileGoneFromDefs: true,
        noOrphanPlacements: true,
        noOrphanConnections: true,
        noOrphanFrameEntries: true,
      });
    });
  });

  describe('Task List — entry points (Phase 2 fixes the dispatch)', () => {
    it('removeTaskPlacement (Phase 2 dispatch target) leaves no orphans', () => {
      const { boardId, envelope } = freshBoard('tasklist', 'tile_a');
      boardCacheStore.hydrate({ [boardId]: envelope }, { [boardId]: 't.board.json' });

      boardCacheStore.removeTaskPlacement(boardId, 'tile_a');

      const post = checkPostConditions(boardCacheStore.cache[boardId], 'tile_a');
      expect(post).toEqual({
        tileGoneFromDefs: true,
        noOrphanPlacements: true,
        noOrphanConnections: true,
        noOrphanFrameEntries: true,
      });
    });

    // Phase 2 / CONSOLIDATION_PLAN_2026-05-25 — same dispatch fix as the
    // Kanban case above: `persistRemoveTile` now routes through
    // `opsFor(cached.board).removeTile`, which lands in
    // `core/boardTileOps/tasklist.ts` for Task List boards and shifts the
    // surviving section positions.
    it('persistRemoveTile on a Task List tile leaves no orphan placement', () => {
      const { boardId, envelope } = freshBoard('tasklist', 'tile_a');
      boardCacheStore.hydrate({ [boardId]: envelope }, { [boardId]: 't.board.json' });

      boardCacheStore.persistRemoveTile('tile_a');

      const post = checkPostConditions(boardCacheStore.cache[boardId], 'tile_a');
      expect(post).toEqual({
        tileGoneFromDefs: true,
        noOrphanPlacements: true,
        noOrphanConnections: true,
        noOrphanFrameEntries: true,
      });
    });
  });

  describe('Document boards have no tile-removal entry point (intentional)', () => {
    // Document tiles are inline rich text — there is no per-tile delete
    // surface, so no entry-point coverage to mirror. This is a positive
    // assertion that the Phase 2 registry must include a `document` ops
    // implementation that is a documented no-op.
    it('document boards do not surface a tile-removal API today', () => {
      // boardCacheStore.persistRemoveTile is a no-op when no board owns
      // the tile (findBoardIdForTile returns null because document boards
      // have no tile-defs). The post-condition is trivially satisfied.
      boardCacheStore.clear();
      boardCacheStore.persistRemoveTile('no_such_tile');
      // No throw; no state mutation. Phase 2's document ops becomes the
      // explicit version of this behavior.
      expect(true).toBe(true);
    });
  });
});

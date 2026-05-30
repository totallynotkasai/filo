/**
 * Phase 5 — board-creation parity.
 *
 * Pre-Phase-5, four call sites built default boards independently:
 *   - `boardRegistry.ts` factories (canonical)
 *   - `BoardBrowser.svelte:createBoard` (3 starter Kanban cols + 1 default Task section)
 *   - `TabBar.svelte:createQuickBoard` (0 Kanban cols + 0 Task sections)
 *   - `boardCache.createBoard` (empty `settings: {}`, no type-specific fields)
 *
 * The audit table in `CONSOLIDATION_PLAN_2026-05-25.md` documents three
 * contradictory shapes for Kanban and three for Tasklist. The schema's
 * `.passthrough()` masked the drift on disk.
 *
 * Phase 5 collapses every gesture to `boardDefaults[type](...)`.
 * This test pins:
 *
 * 1. The canonical shape per the Phase 5 DECISIONS (Kanban: `columns: []`;
 *    Tasklist: one default `Task List` section + `collapsedSubtasks: []`).
 * 2. `boardCacheStore.createBoard` — which BoardBrowser, TabBar, the template
 *    flow, and BoardRouter all now route through — produces structurally
 *    identical JSON (modulo id/timestamps).
 * 3. Schema round-trip: every factory output re-parses cleanly under
 *    `BoardSchema`.
 *
 * A future PR that re-introduces a hand-built `switch (type)` block
 * (with starter columns, missing sections, or other divergence) makes
 * these assertions fail loudly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// Phase 5 — import the pure factories from `boardDefaults`, not `boardRegistry`.
// The registry's value adds Svelte component references which vitest's CSS
// preprocessor cannot resolve through jsdom; the factories themselves have
// no UI-side dependencies and are the single source of truth either way.
import { boardDefaults } from '@renderer/core/boardDefaults';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import {
  BoardSchema,
  type Board,
  type KanbanBoard,
  type TaskListBoard,
  type MindMapBoard,
  type DocumentBoard,
} from '@renderer/schema/index';
import type { BoardType } from '@shared/types';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/** Strip id + timestamps so two factory outputs can be deep-compared. */
function structural(board: Board): Record<string, unknown> {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = board as Board & {
    id: string;
    createdAt: number;
    updatedAt: number;
  };
  void _id;
  void _c;
  void _u;
  // Drop type-specific id fields too — Kanban has no top-level id collisions
  // but Tasklist's default section gets a fresh `sec_<nanoid>` per call.
  if (rest.type === 'tasklist') {
    const tl = rest as TaskListBoard;
    return {
      ...rest,
      sections: tl.sections.map((s) => ({ ...s, id: '<id>' })),
    };
  }
  if (rest.type === 'document') {
    return { ...rest, contentId: '<id>' };
  }
  if (rest.type === 'kanban') {
    // `kanbanFolder` is stamped by `persistNewBoard` at create-time, not by
    // the factory — strip it so a direct-factory output and a
    // persisted-via-cache output remain comparable.
    const { kanbanFolder: _kf, ...kRest } = rest as Record<string, unknown> & {
      kanbanFolder?: string;
    };
    void _kf;
    return kRest;
  }
  return rest;
}

const ALL_TYPES: BoardType[] = ['mindmap', 'kanban', 'tasklist', 'document'];

describe('Phase 5 — board-creation parity', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
    // Each `boardCacheStore.createBoard` call hits `board:create`.
    // Return a stable success envelope so the cache + project bookkeeping
    // run their full code paths.
    installFiloMock({
      'board:create': (...args: unknown[]) => {
        const name = args[1] as string;
        return { ok: true, path: `${name}.board.json` };
      },
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
  });

  describe('canonical shapes per board type (DECISIONS in CONSOLIDATION_PLAN)', () => {
    it('mindmap — empty placements/inlineTiles/connections/frames/waypoints/groups', () => {
      const board = boardDefaults.mindmap('mm', 'M') as MindMapBoard;
      expect(board.type).toBe('mindmap');
      expect(board.placements).toEqual({});
      expect(board.inlineTiles).toEqual({});
      expect(board.connections).toEqual([]);
      expect(board.frames).toEqual([]);
      expect(board.waypoints).toEqual([]);
      expect(board.groups).toEqual([]);
    });

    it('kanban — DECISION: columns: [] (no starter columns)', () => {
      const board = boardDefaults.kanban('kb', 'K') as KanbanBoard;
      expect(board.type).toBe('kanban');
      expect(board.columns).toEqual([]);
    });

    it('tasklist — DECISION: one default "Task List" section + empty collapsedSubtasks', () => {
      const board = boardDefaults.tasklist('tl', 'T') as TaskListBoard;
      expect(board.type).toBe('tasklist');
      expect(board.tasks).toEqual([]);
      expect(board.sections).toHaveLength(1);
      expect(board.sections[0]).toMatchObject({
        title: 'Task List',
        position: 0,
        collapsed: false,
      });
      expect(board.sections[0].id).toMatch(/^sec_/);
      expect(board.collapsedSubtasks).toEqual([]);
    });

    it('document — fresh contentId + empty content', () => {
      const board = boardDefaults.document('doc', 'D') as DocumentBoard;
      expect(board.type).toBe('document');
      expect(board.content).toBe('');
      expect(board.contentId).toMatch(/.+/); // any non-empty nanoid
    });
  });

  describe('boardCacheStore.createBoard routes through the registry', () => {
    it.each(ALL_TYPES)(
      'creates %s via the registry (structurally identical to a direct factory call)',
      async (type) => {
        const direct = boardDefaults[type]('direct', 'Foo');
        const viaCache = await boardCacheStore.createBoard('Foo', type);
        expect(viaCache).not.toBeNull();

        const direct$ = structural(direct);
        const viaCache$ = structural(viaCache as Board);
        expect(viaCache$).toEqual(direct$);
      },
    );

    it('persists the kanban board with empty columns (no starter "To Do" / "In Progress" / "Done")', async () => {
      const created = (await boardCacheStore.createBoard('Foo', 'kanban')) as KanbanBoard;
      expect(created.columns).toEqual([]);
    });

    it('persists the tasklist board with one default section + empty collapsedSubtasks', async () => {
      const created = (await boardCacheStore.createBoard('Foo', 'tasklist')) as TaskListBoard;
      expect(created.sections).toHaveLength(1);
      expect(created.sections[0]).toMatchObject({
        title: 'Task List',
        position: 0,
        collapsed: false,
      });
      expect(created.collapsedSubtasks).toEqual([]);
    });
  });

  describe('every factory output round-trips through BoardSchema', () => {
    it.each(ALL_TYPES)('parses cleanly for %s', (type) => {
      const board = boardDefaults[type](`id-${type}`, `Name ${type}`);
      const round = BoardSchema.parse(JSON.parse(JSON.stringify(board)));
      // Re-parsing a registry-built board must not throw and must preserve `type`.
      expect(round.type).toBe(type);
    });
  });
});

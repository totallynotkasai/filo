/**
 * IMPL_PLAN_2026-05-23_v2 P1.6 — schema cross-check for orphan
 * connection / frame refs.
 *
 * `BoardFileDataSchema` gains a `.superRefine` that gathers the valid
 * tile-ID set (tileDefs ∪ mindmap.inlineTiles) and flags any
 * `connection.fromTileId` / `connection.toTileId` / `frame.tileIds[]`
 * entry that doesn't resolve. Pure schema-level defence in depth — the
 * loader's `pruneOrphanRefsAndDuplicates` already cleans these up before
 * the parse, so this check fires only when a caller validates an
 * envelope without going through the loader (tests, migration tooling,
 * hand-built JSON).
 */

import { describe, it, expect } from 'vitest';
import { BoardFileDataSchema } from '@renderer/schema/index';

function mindmapEnvelope() {
  return {
    version: 8,
    board: {
      id: 'mm',
      type: 'mindmap' as const,
      name: 'Mind Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        tile_a: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {
        link_b: {
          id: 'link_b',
          type: 'link' as const,
          title: 'Link',
          x: 200,
          y: 200,
          width: 200,
          height: 100,
          url: 'https://example.com',
          tags: [],
          createdAt: 0,
          updatedAt: 0,
        },
      },
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    },
    tileDefs: {
      tile_a: {
        id: 'tile_a',
        type: 'text' as const,
        filePath: 'A.md',
        style: { headerColor: '#fff', bodyColor: '#fff' },
        createdAt: 0,
        updatedAt: 0,
      },
    },
    connections: {} as Record<string, unknown>,
    frames: [] as unknown[],
  };
}

describe('BoardFileDataSchema — orphan-ref cross-check (P1.6)', () => {
  it('accepts a connection pointing at a real tile in tileDefs', () => {
    const env = mindmapEnvelope();
    env.connections = {
      c_ok: {
        id: 'c_ok',
        boardId: 'mm',
        fromTileId: 'tile_a',
        toTileId: 'tile_a',
        fromBubble: 0,
        toBubble: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    };
    const result = BoardFileDataSchema.safeParse(env);
    expect(result.success).toBe(true);
  });

  it('accepts a connection pointing at an inline tile on a mindmap board', () => {
    // Pre-fix the existing prune treated inline tile IDs as missing and
    // dropped these as orphan connections. The validity set now correctly
    // includes mindmap.inlineTiles keys.
    const env = mindmapEnvelope();
    env.connections = {
      c_inline: {
        id: 'c_inline',
        boardId: 'mm',
        fromTileId: 'tile_a',
        toTileId: 'link_b',
        fromBubble: 0,
        toBubble: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    };
    const result = BoardFileDataSchema.safeParse(env);
    expect(result.success).toBe(true);
  });

  it('rejects a connection pointing at a missing tile', () => {
    const env = mindmapEnvelope();
    env.connections = {
      c_orphan: {
        id: 'c_orphan',
        boardId: 'mm',
        fromTileId: 'tile_a',
        toTileId: 'tile_ghost',
        fromBubble: 0,
        toBubble: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    };
    const result = BoardFileDataSchema.safeParse(env);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/tile_ghost/);
      expect(msg).toMatch(/toTileId/);
    }
  });

  it('rejects a frame.tileIds entry that points at a missing tile', () => {
    const env = mindmapEnvelope();
    env.frames = [
      {
        id: 'f1',
        boardId: 'mm',
        title: 'Frame',
        position: { x: 0, y: 0 },
        size: { width: 300, height: 200 },
        tileIds: ['tile_a', 'tile_ghost'],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const result = BoardFileDataSchema.safeParse(env);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/tile_ghost/);
      expect(msg).toMatch(/Frame f1/);
    }
  });

  it('accepts a frame.tileIds entry pointing at an inline tile on a mindmap board', () => {
    const env = mindmapEnvelope();
    env.frames = [
      {
        id: 'f1',
        boardId: 'mm',
        title: 'Frame',
        position: { x: 0, y: 0 },
        size: { width: 300, height: 200 },
        tileIds: ['link_b'],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const result = BoardFileDataSchema.safeParse(env);
    expect(result.success).toBe(true);
  });

  it('rejects an inline-tile-keyed connection on a Kanban board (no inlineTiles validity)', () => {
    // Sanity: the inline-tiles validity expansion is gated on
    // `board.type === 'mindmap'`. A Kanban board's tileDefs is the only
    // validity source, so an inline-shaped tile ID is an orphan.
    const env = {
      version: 8,
      board: {
        id: 'kb',
        type: 'kanban' as const,
        name: 'Kanban',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        columns: [
          {
            id: 'col1',
            title: 'Todo',
            position: 0,
            collapsed: false,
            tilePlacements: [{ tileId: 'tile_a', position: 0 }],
          },
        ],
      },
      tileDefs: {
        tile_a: {
          id: 'tile_a',
          type: 'text' as const,
          filePath: 'A.md',
          style: { headerColor: '#fff', bodyColor: '#fff' },
          createdAt: 0,
          updatedAt: 0,
        },
      },
      connections: {
        c_inline: {
          id: 'c_inline',
          boardId: 'kb',
          fromTileId: 'tile_a',
          toTileId: 'link_b',
          fromBubble: 0,
          toBubble: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      },
      frames: [],
    };
    const result = BoardFileDataSchema.safeParse(env);
    expect(result.success).toBe(false);
  });
});

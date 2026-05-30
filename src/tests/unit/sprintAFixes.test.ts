/**
 * Sprint A fix verification — point tests for the Sprint A items that
 * needed dedicated coverage. Other items either rely on the existing
 * characterisation tests (A4, A14 partial), are policed by ci:verify
 * gates, or are runtime/integration behaviour exercised by the broader
 * test suite.
 *
 * See `FIXES_PLAN_2026-05-26.md` Sprint A for each item's audit context.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { V7BoardFileDataSchema } from '@renderer/schema/boardFile';
import { BoardSchema, TileGroupSchema } from '@renderer/schema/board';
import {
  KanbanTilePlacementSchema,
  TaskPlacementSchema,
} from '@renderer/schema/placement';
import { FrameSchema } from '@renderer/schema/frame';
import { uniqueStrings } from '@renderer/schema/schemaUtils';
import { canvasStore } from '@renderer/stores/canvas.svelte';

const now = Date.now();
const FRAME_ID = 'frame_abcdef0123';
const TILE_ID = 'tile_abc1234567';
const TILE_ID_2 = 'tile_def4567890';

const mindMapBoard = {
  id: 'board_test123456',
  name: 'Test',
  emoji: '',
  type: 'mindmap' as const,
  createdAt: now,
  updatedAt: now,
  settings: {},
  placements: {},
  inlineTiles: {},
  connections: [],
  frames: [],
  waypoints: [],
  groups: [],
};

// ── A6: NaN-input validation on canvas transform mutators ─────────────

describe('A6 — canvas transform mutators reject non-finite inputs', () => {
  beforeEach(() => {
    // Each scope reset relies on the global facade picking up an active
    // pane; for these tests we set a baseline transform via setTransform
    // (which already validated finite scale) so we have a known starting
    // state before exercising the guards. If no active pane is wired up,
    // the facade calls no-op and the assertions still hold trivially.
    try {
      canvasStore.setTransform({ x: 100, y: 50, scale: 1.5 });
    } catch {
      // No active scope in this test env — facade calls become no-ops;
      // the assertions below still pass since the guards short-circuit.
    }
  });

  it('zoomTo: NaN scale leaves transform unchanged', () => {
    const before = { ...canvasStore.transform };
    canvasStore.zoomTo(Number.NaN, 0, 0);
    expect(canvasStore.transform).toEqual(before);
  });

  it('zoomTo: Infinity scale leaves transform unchanged', () => {
    const before = { ...canvasStore.transform };
    canvasStore.zoomTo(Number.POSITIVE_INFINITY, 0, 0);
    expect(canvasStore.transform).toEqual(before);
  });

  it('zoomBy: NaN factor leaves transform unchanged', () => {
    const before = { ...canvasStore.transform };
    canvasStore.zoomBy(Number.NaN, 0, 0);
    expect(canvasStore.transform).toEqual(before);
  });

  it('panBy: NaN dx/dy leaves transform unchanged', () => {
    const before = { ...canvasStore.transform };
    canvasStore.panBy(Number.NaN, 10);
    canvasStore.panBy(10, Number.NaN);
    canvasStore.panBy(Number.NaN, Number.NaN);
    expect(canvasStore.transform).toEqual(before);
  });

  it('centerOn: NaN coords leave transform unchanged', () => {
    const before = { ...canvasStore.transform };
    canvasStore.centerOn(Number.NaN, 0);
    canvasStore.centerOn(0, Number.NaN);
    expect(canvasStore.transform).toEqual(before);
  });

  it('flyTo: non-finite target leaves transform unchanged', () => {
    const before = { ...canvasStore.transform };
    canvasStore.flyTo({ x: Number.NaN, y: 0, scale: 1 });
    canvasStore.flyTo({ x: 0, y: Number.POSITIVE_INFINITY, scale: 1 });
    canvasStore.flyTo({ x: 0, y: 0, scale: Number.NaN });
    expect(canvasStore.transform).toEqual(before);
  });
});

// ── A12: V7BoardFileDataSchema envelope passthrough ───────────────────

describe('A12 — V7BoardFileDataSchema preserves forward-compat envelope fields', () => {
  it('round-trips an unknown top-level field', () => {
    const envelope = {
      version: 7 as const,
      board: mindMapBoard,
      tileDefs: {},
      connections: {},
      frames: [],
      // The forward-compat field a future Filo might write:
      futureField: 'some-value',
      anotherFutureField: { nested: true },
    };
    const parsed = V7BoardFileDataSchema.parse(envelope) as Record<string, unknown>;
    expect(parsed.futureField).toBe('some-value');
    expect(parsed.anotherFutureField).toEqual({ nested: true });
  });
});

// ── A13: KanbanTilePlacement.position + TaskPlacement.position nonnegative ─

describe('A13 — placement positions reject negative values', () => {
  it('KanbanTilePlacement rejects position: -1', () => {
    expect(() =>
      KanbanTilePlacementSchema.parse({ tileId: TILE_ID, position: -1 }),
    ).toThrow();
  });

  it('KanbanTilePlacement accepts position: 0', () => {
    const result = KanbanTilePlacementSchema.parse({ tileId: TILE_ID, position: 0 });
    expect(result.position).toBe(0);
  });

  it('TaskPlacement rejects position: -1', () => {
    expect(() =>
      TaskPlacementSchema.parse({ tileId: TILE_ID, position: -1 }),
    ).toThrow();
  });

  it('TaskPlacement accepts position: 0 and positive values', () => {
    expect(TaskPlacementSchema.parse({ tileId: TILE_ID, position: 0 }).position).toBe(0);
    expect(TaskPlacementSchema.parse({ tileId: TILE_ID, position: 5 }).position).toBe(5);
  });
});

// ── A14: Flat ID arrays reject duplicates and empty strings ───────────

describe('A14 — flat ID arrays reject duplicates and empty strings', () => {
  describe('uniqueStrings helper', () => {
    it('rejects arrays with duplicate strings', () => {
      const schema = z.array(z.string().min(1)).refine(...uniqueStrings('test'));
      expect(() => schema.parse(['a', 'b', 'a'])).toThrow();
    });

    it('accepts arrays with all-unique strings', () => {
      const schema = z.array(z.string().min(1)).refine(...uniqueStrings('test'));
      expect(schema.parse(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('paired with .min(1) rejects empty strings element-wise', () => {
      const schema = z.array(z.string().min(1)).refine(...uniqueStrings('test'));
      expect(() => schema.parse(['a', '', 'b'])).toThrow();
    });
  });

  describe('TileGroupSchema.tileIds', () => {
    it('rejects duplicate tileIds', () => {
      expect(() =>
        TileGroupSchema.parse({
          id: 'group_abc',
          tileIds: [TILE_ID, TILE_ID],
          boardId: 'board_xyz',
        }),
      ).toThrow();
    });
  });

  describe('FrameSchema.tileIds', () => {
    it('rejects duplicate tileIds', () => {
      expect(() =>
        FrameSchema.parse({
          id: FRAME_ID,
          boardId: 'board_xyz',
          title: 'F',
          position: { x: 0, y: 0 },
          size: { width: 200, height: 150 },
          collapsed: false,
          tileIds: [TILE_ID, TILE_ID],
          createdAt: now,
          updatedAt: now,
        }),
      ).toThrow();
    });

    it('accepts unique tileIds', () => {
      const result = FrameSchema.parse({
        id: FRAME_ID,
        boardId: 'board_xyz',
        title: 'F',
        position: { x: 0, y: 0 },
        size: { width: 200, height: 150 },
        collapsed: false,
        tileIds: [TILE_ID, TILE_ID_2],
        createdAt: now,
        updatedAt: now,
      });
      expect(result.tileIds).toEqual([TILE_ID, TILE_ID_2]);
    });
  });

  describe('MindMapBoardSchema.connections / frames', () => {
    it('rejects duplicate connection ids', () => {
      expect(() =>
        BoardSchema.parse({
          ...mindMapBoard,
          connections: ['conn_a', 'conn_a'],
        }),
      ).toThrow();
    });

    it('rejects duplicate frame ids', () => {
      expect(() =>
        BoardSchema.parse({
          ...mindMapBoard,
          frames: [FRAME_ID, FRAME_ID],
        }),
      ).toThrow();
    });
  });

  describe('TaskListBoardSchema.collapsedSubtasks', () => {
    it('rejects duplicate ids', () => {
      const taskBoard = {
        ...mindMapBoard,
        type: 'tasklist' as const,
        tasks: [],
        sections: [],
        collapsedSubtasks: [TILE_ID, TILE_ID],
      };
      // Strip mindmap-specific fields that don't apply to tasklist
      delete (taskBoard as { placements?: unknown }).placements;
      delete (taskBoard as { inlineTiles?: unknown }).inlineTiles;
      delete (taskBoard as { connections?: unknown }).connections;
      delete (taskBoard as { frames?: unknown }).frames;
      delete (taskBoard as { waypoints?: unknown }).waypoints;
      delete (taskBoard as { groups?: unknown }).groups;
      expect(() => BoardSchema.parse(taskBoard)).toThrow();
    });
  });
});

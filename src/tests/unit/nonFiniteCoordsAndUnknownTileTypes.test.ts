import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadBoard, loadAllBoards } from '@renderer/lib/boards/boardLoader';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import {
  TilePlacementSchema,
  InlineTileSchema,
  FrameSchema,
  TileDefinitionSchema,
} from '@renderer/schema/index';
import { TILE_TYPES } from '@renderer/schema/tile';
import { __resetErrorBusForTests, onError, type ReportedError } from '@renderer/lib/utils/errorBus';

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) throw new Error(`No stub for channel "${channel}"`);
      return handler(...args);
    },
    on: () => () => { /* no-op */ },
    send: () => { /* no-op */ },
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

function validBoardFile(boardId = 'mindmap-1'): BoardFileData {
  const now = Date.now();
  return {
    version: 8,
    board: {
      id: boardId,
      name: 'Alpha',
      emoji: '',
      type: 'mindmap',
      settings: {},
      placements: {
        tile_a: { x: 10, y: 20, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      createdAt: now,
      updatedAt: now,
    } as BoardFileData['board'],
    tileDefs: {
      tile_a: {
        id: 'tile_a',
        type: 'text',
        filePath: 'notes/alpha.md',
        style: { headerColor: '#fff', bodyColor: '#fff', borderColor: '' },
        createdAt: now,
        updatedAt: now,
      } as BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
}

describe('schema type safety', () => {
  beforeEach(() => {
    uninstallFiloStub();
    __resetErrorBusForTests();
  });
  afterEach(() => {
    uninstallFiloStub();
    __resetErrorBusForTests();
  });

  describe('coordinate/size schemas reject non-finite numbers', () => {
    it('TilePlacementSchema rejects NaN x', () => {
      const r = TilePlacementSchema.safeParse({
        x: NaN,
        y: 0,
        width: 200,
        height: 100,
      });
      expect(r.success).toBe(false);
    });

    it('TilePlacementSchema rejects Infinity y', () => {
      const r = TilePlacementSchema.safeParse({
        x: 0,
        y: Infinity,
        width: 200,
        height: 100,
      });
      expect(r.success).toBe(false);
    });

    it('TilePlacementSchema rejects -Infinity width (fail loud, no silent default)', () => {
      // width/height flow through `coerceToNumber`, which passes ±Infinity
      // through unchanged so the downstream `.finite()` gate rejects it —
      // routing the board to `failedBoards` + a recovery snapshot. Folding
      // the non-finite value to the fallback (240) and persisting it would
      // silently rewrite a hand-edited coordinate; failing loud matches the
      // NaN path.
      const r = TilePlacementSchema.safeParse({
        x: 0,
        y: 0,
        width: -Infinity,
        height: 100,
      });
      expect(r.success).toBe(false);
    });

    it('TilePlacementSchema rejects NaN height (Zod default rejects NaN)', () => {
      // Unlike ±Infinity, Zod's `z.number()` rejects NaN at the union step
      // before our transform ever runs — so a NaN size routes the board to
      // `failedBoards` rather than being silently coerced.
      const r = TilePlacementSchema.safeParse({
        x: 0,
        y: 0,
        width: 200,
        height: NaN,
      });
      expect(r.success).toBe(false);
    });

    // `coerceToNumber`'s contract: null + NaN are REJECTED at the union step
    // (no null branch + Zod default reject on NaN); ±Infinity is REJECTED at
    // the downstream `.finite()` gate; an unparseable string is REJECTED too
    // (`parseFloat("abc")` → NaN flows to the same `.finite()` gate). Only
    // undefined falls back to the
    // schema-provided default. These tests pin the contract so a future
    // schema refactor can't quietly broaden it.
    it('TilePlacementSchema rejects null width (no null branch in coerceToNumber union)', () => {
      const r = TilePlacementSchema.safeParse({
        x: 0,
        y: 0,
        width: null,
        height: 100,
      });
      expect(r.success).toBe(false);
    });

    it('TilePlacementSchema falls back when width is missing (undefined → 240 default)', () => {
      // `undefined` flows through `.optional()` then the final transform's
      // fallback branch — the schema default (240) lands intact.
      const r = TilePlacementSchema.safeParse({
        x: 0,
        y: 0,
        height: 100,
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.width).toBe(240);
      }
    });

    it('TilePlacementSchema rejects an unparseable string width (fail loud, no silent 240)', () => {
      // A corrupt size string like "wide" / "abc" parses to NaN and is
      // REJECTED at the downstream `.finite()` gate, routing the board to
      // `failedBoards` + a recovery snapshot. Folding the NaN parse to the
      // fallback (240) and persisting it would silently substitute a
      // hand-edited corrupt size, inconsistent with the ±Infinity fail-loud
      // stance above.
      const r = TilePlacementSchema.safeParse({
        x: 0,
        y: 0,
        width: 'wide',
        height: 100,
      });
      expect(r.success).toBe(false);
    });

    it('TilePlacementSchema still parses a numeric string width ("300" → 300)', () => {
      // The fail-loud change must not regress legitimate numeric strings —
      // `parseFloat("300")` → 300 passes the `.finite().min(80)` gate.
      const r = TilePlacementSchema.safeParse({
        x: 0,
        y: 0,
        width: '300',
        height: 100,
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.width).toBe(300);
      }
    });

    it('InlineTileSchema rejects NaN x', () => {
      const now = Date.now();
      const r = InlineTileSchema.safeParse({
        id: 'i1',
        type: 'timer',
        title: '',
        x: NaN,
        y: 0,
        width: 200,
        height: 80,
        createdAt: now,
        updatedAt: now,
      });
      expect(r.success).toBe(false);
    });

    it('FrameSchema rejects Infinity in size.width', () => {
      const now = Date.now();
      const r = FrameSchema.safeParse({
        id: 'f1',
        boardId: 'b1',
        title: 'F',
        position: { x: 0, y: 0 },
        size: { width: Infinity, height: 200 },
        createdAt: now,
        updatedAt: now,
      });
      expect(r.success).toBe(false);
    });

    it('FrameSchema rejects NaN in position.x', () => {
      const now = Date.now();
      const r = FrameSchema.safeParse({
        id: 'f1',
        boardId: 'b1',
        title: 'F',
        position: { x: NaN, y: 0 },
        size: { width: 300, height: 200 },
        createdAt: now,
        updatedAt: now,
      });
      expect(r.success).toBe(false);
    });

    it('loadBoard routes a .board.json with NaN placement coords to failedBoards', async () => {
      const file = validBoardFile('m-nan');
      const board = file.board as unknown as { placements: Record<string, { x: number }> };
      board.placements.tile_a.x = NaN as unknown as number;
      installFiloStub({ 'board:load': () => JSON.parse(JSON.stringify(file)) });

      const result = await loadBoard('/vault', 'nan.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('schema-invalid');
    });

    it('loadAllBoards collects the NaN-coord board into failedBoards', async () => {
      const goodFile = validBoardFile('m-ok');
      const badFile = validBoardFile('m-bad');
      const board = badFile.board as unknown as { placements: Record<string, { y: number }> };
      board.placements.tile_a.y = Infinity as unknown as number;

      installFiloStub({
        'board:list': () => ['ok.board.json', 'bad.board.json'],
        'board:load': (_root: unknown, rel: unknown) =>
          rel === 'ok.board.json' ? JSON.parse(JSON.stringify(goodFile)) : JSON.parse(JSON.stringify(badFile)),
      });

      const result = await loadAllBoards('/vault');
      expect(result.boards).toHaveLength(1);
      expect(result.boards[0].id).toBe('m-ok');
      expect(result.failedBoards).toHaveLength(1);
      expect(result.failedBoards[0].path).toBe('bad.board.json');
      expect(result.failedBoards[0].errorKind).toBe('schema-invalid');
    });
  });

  describe('unknown tile-def types are filtered with a toast', () => {
    it('TileDefinitionSchema parses every live type in TILE_TYPES', () => {
      const now = Date.now();
      // `TileDefinitionSchema` is a discriminated union with per-variant
      // required fields (e.g. text needs `filePath`, image needs `src`). Provide the minimum per-type payload so the parse
      // exercises the discriminator without spuriously failing on a
      // missing required field.
      const requiredFieldsByType: Record<typeof TILE_TYPES[number], Record<string, unknown>> = {
        text: { filePath: 'T.md' },
        image: { src: '' },
        video: { src: '' },
        audio: { src: '' },
        file: { filePath: '' },
        link: {},
        iframe: {},
        timer: {},
      };
      for (const t of TILE_TYPES) {
        const r = TileDefinitionSchema.safeParse({
          id: `t_${t}`,
          type: t,
          title: 'T',
          style: { headerColor: '', bodyColor: '', borderColor: '' },
          createdAt: now,
          updatedAt: now,
          ...requiredFieldsByType[t],
        });
        expect(r.success, `failed on type=${t}`).toBe(true);
      }
    });

    it('TileDefinitionSchema rejects an unknown type once the loader strips have been bypassed', () => {
      const now = Date.now();
      const r = TileDefinitionSchema.safeParse({
        id: 't_cal',
        type: 'calendar',
        title: 'Old',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: now,
        updatedAt: now,
      });
      expect(r.success).toBe(false);
    });

    it('loadBoard strips a `calendar` tile def, emits a toast, returns ok', async () => {
      const file = validBoardFile('m-cal');
      const now = Date.now();
      // Inject an unknown-type tile def. Cast through unknown because the
      // schema type intentionally disallows it.
      (file.tileDefs as unknown as Record<string, unknown>).tile_cal = {
        id: 'tile_cal',
        type: 'calendar',
        title: 'Leftover',
        tags: [],
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: now,
        updatedAt: now,
      };
      // The loader aborts with snapshot-failed when an unknown-type prune
      // is required AND `recovery:snapshot` fails. Stub a successful
      // snapshot so the load proceeds to the prune. Envelope contract —
      // `src/main/ipc/board.ipc.ts:360-371` returns
      // `{ ok: true, path }` / `{ ok: false, code?, error }`.
      const snapshots: unknown[][] = [];
      installFiloStub({
        'board:load': () => JSON.parse(JSON.stringify(file)),
        'recovery:snapshot': (...args: unknown[]) => {
          snapshots.push(args);
          return { ok: true, path: '.filo/recovery/cal.board.json' };
        },
      });

      const reported: ReportedError[] = [];
      const off = onError((err) => reported.push(err));
      try {
        const result = await loadBoard('/vault', 'cal.board.json');
        expect(result.ok).toBe(true);
        // The copy is the only one of what the prune dropped: it goes in a
        // `-keep` folder, which the recovery prunes never remove.
        expect(snapshots).toEqual([['/vault', 'cal.board.json', 'keep']]);
        if (result.ok) {
          expect(result.droppedTileTypes).toEqual(['calendar']);
          expect(result.data.tileDefs.tile_cal).toBeUndefined();
          // The good def is preserved.
          expect(result.data.tileDefs.tile_a).toBeDefined();
        }
        expect(reported).toHaveLength(1);
        expect(reported[0].context).toBe('board-load-unknown-tile-types');
        expect(String(reported[0].message)).toContain('Alpha');
        expect(String(reported[0].message)).toContain('calendar');
      } finally {
        off();
      }
    });

    it('loadBoard deduplicates dropped types across multiple stripped defs', async () => {
      const file = validBoardFile('m-dup');
      const now = Date.now();
      const defs = file.tileDefs as unknown as Record<string, unknown>;
      defs.tile_cal1 = {
        id: 'tile_cal1',
        type: 'calendar',
        title: 'A',
        tags: [],
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: now,
        updatedAt: now,
      };
      defs.tile_cal2 = {
        id: 'tile_cal2',
        type: 'calendar',
        title: 'B',
        tags: [],
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: now,
        updatedAt: now,
      };
      defs.tile_widget = {
        id: 'tile_widget',
        type: 'widget',
        title: 'C',
        tags: [],
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: now,
        updatedAt: now,
      };
      // The loader aborts with snapshot-failed when an unknown-type prune
      // is required AND `recovery:snapshot` fails. Stub a successful
      // snapshot so the load proceeds to the prune. Envelope contract —
      // see `board.ipc.ts:360-371`.
      installFiloStub({
        'board:load': () => JSON.parse(JSON.stringify(file)),
        'recovery:snapshot': () => ({ ok: true, path: '.filo/recovery/dup.board.json' }),
      });

      const result = await loadBoard('/vault', 'dup.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Set semantics — dedup'd; order doesn't matter.
        expect(new Set(result.droppedTileTypes)).toEqual(new Set(['calendar', 'widget']));
      }
    });

    it('loadBoard reports droppedTileTypes: [] when every def is known', async () => {
      const file = validBoardFile('m-clean');
      installFiloStub({ 'board:load': () => JSON.parse(JSON.stringify(file)) });
      const result = await loadBoard('/vault', 'clean.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.droppedTileTypes).toEqual([]);
      }
    });
  });
});

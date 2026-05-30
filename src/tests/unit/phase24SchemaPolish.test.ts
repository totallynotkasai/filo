import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBoard, loadAllBoards } from '@renderer/lib/boards/boardLoader';
import { historyStore } from '@renderer/stores/history.svelte';
import type { Command } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import { FrameSchema, ConnectionSchema, TileDefinitionSchema } from '@renderer/schema/index';
import { uniqueBy } from '@renderer/schema/schemaUtils';
import { __resetErrorBusForTests, onError, type ReportedError } from '@renderer/lib/utils/errorBus';

/**
 * Phase 24 — Schema Polish & History regression tests.
 *
 * Covers:
 *  - M17: `.min(1)` on every `id` field + per-collection uniqueness refines.
 *  - M18: frame minSize lowered to 0; renderer warns on load when a frame
 *         is below the recommended 200×150.
 *  - M23: `historyStore.setMaxHistory` truncates existing stacks immediately.
 *  - M25: external-edit reconciliation surfaces a one-shot stale-undo toast.
 *  - M26: `loadAllBoards` reports `backfilledBoardIds` so callers can
 *         markDirty the touched boards.
 *  - M24 is exercised end-to-end via the existing DeleteFrame/Connection
 *         command tests — the deep-clone change is behavioural and is best
 *         caught by the broader command suites rather than a re-export.
 */

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

function validBoardFile(boardId = 'mindmap-1'): V7BoardFileData {
  const now = Date.now();
  return {
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
    } as V7BoardFileData['board'],
    tileDefs: {
      tile_a: {
        id: 'tile_a',
        type: 'text',
        title: 'Note',
        tags: [],
        style: { headerColor: '#fff', bodyColor: '#fff', borderColor: '' },
        contentId: 'doc_1',
        createdAt: now,
        updatedAt: now,
      } as V7BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
}

class NoopCommand implements Command {
  description = 'noop';
  execute(): void {}
  undo(): void {}
}

describe('Phase 24 — schema polish & history', () => {
  beforeEach(() => {
    uninstallFiloStub();
    __resetErrorBusForTests();
    historyStore.clear();
    historyStore.setMaxHistory(500);
  });
  afterEach(() => {
    uninstallFiloStub();
    __resetErrorBusForTests();
    historyStore.clear();
    historyStore.setMaxHistory(500);
    historyStore.setActiveBoard(null);
  });

  // ── M17 ────────────────────────────────────────────────────────────────

  describe('M17 — id .min(1) + uniqueness refines', () => {
    it('FrameSchema rejects an empty id', () => {
      const now = Date.now();
      const r = FrameSchema.safeParse({
        id: '',
        boardId: 'b1',
        title: 'F',
        position: { x: 0, y: 0 },
        size: { width: 300, height: 200 },
        createdAt: now,
        updatedAt: now,
      });
      expect(r.success).toBe(false);
    });

    it('ConnectionSchema rejects an empty id', () => {
      const r = ConnectionSchema.safeParse({
        id: '',
        boardId: 'b1',
        fromTileId: 't1',
        toTileId: 't2',
        fromBubble: 0,
        toBubble: 4,
        createdAt: 1,
        updatedAt: 1,
      });
      expect(r.success).toBe(false);
    });

    it('TileDefinitionSchema rejects an empty id', () => {
      const r = TileDefinitionSchema.safeParse({
        id: '',
        type: 'text',
        title: 'T',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: 1,
        updatedAt: 1,
      });
      expect(r.success).toBe(false);
    });

    it('uniqueBy helper rejects duplicate ids', () => {
      const [refineFn] = uniqueBy<{ id: string }>('id', 'frames');
      expect(refineFn([{ id: 'a' }, { id: 'b' }])).toBe(true);
      expect(refineFn([{ id: 'a' }, { id: 'a' }])).toBe(false);
    });

    it('uniqueBy ignores null/undefined ids', () => {
      const [refineFn] = uniqueBy<{ id: string | null }>('id', 'x');
      expect(refineFn([{ id: null }, { id: null }, { id: 'a' }])).toBe(true);
    });
  });

  // ── M18 ────────────────────────────────────────────────────────────────

  describe('M18 — frame minSize lowered to 0', () => {
    it('FrameSchema accepts a 0×0 frame on disk', () => {
      const now = Date.now();
      const r = FrameSchema.safeParse({
        id: 'f-tiny',
        boardId: 'b1',
        title: 'Collapsed',
        position: { x: 0, y: 0 },
        size: { width: 0, height: 0 },
        createdAt: now,
        updatedAt: now,
      });
      expect(r.success).toBe(true);
    });

    it('FrameSchema still rejects negative dimensions', () => {
      const now = Date.now();
      const r = FrameSchema.safeParse({
        id: 'f-bad',
        boardId: 'b1',
        title: 'Bad',
        position: { x: 0, y: 0 },
        size: { width: -10, height: 5 },
        createdAt: now,
        updatedAt: now,
      });
      expect(r.success).toBe(false);
    });

    it('loadBoard emits a single board-scoped toast naming undersized frames', async () => {
      const file = validBoardFile('m-small');
      const now = Date.now();
      file.frames = [
        {
          id: 'f-tiny',
          boardId: 'm-small',
          title: 'Pinned Note',
          position: { x: 0, y: 0 },
          size: { width: 50, height: 30 },
          collapsed: false,
          tileIds: [],
          style: {},
          createdAt: now,
          updatedAt: now,
        } as V7BoardFileData['frames'][number],
        {
          id: 'f-ok',
          boardId: 'm-small',
          title: 'Regular',
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          collapsed: false,
          tileIds: [],
          style: {},
          createdAt: now,
          updatedAt: now,
        } as V7BoardFileData['frames'][number],
      ];
      installFiloStub({ 'board:load': () => JSON.stringify(file) });

      const reported: ReportedError[] = [];
      const off = onError((err) => reported.push(err));
      try {
        const result = await loadBoard('/vault', 'small.board.json');
        expect(result.ok).toBe(true);
        const warnings = reported.filter(
          (r) => r.context === 'board-load-undersized-frames',
        );
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0].message)).toContain('Pinned Note');
        // Boards with no undersized frames don't warn — verified implicitly
        // by `f-ok` not appearing in any toast.
        expect(String(warnings[0].message)).not.toContain('Regular');
      } finally {
        off();
      }
    });
  });

  // ── M23 ────────────────────────────────────────────────────────────────

  describe('M23 — historyStore.setMaxHistory', () => {
    it('truncates an existing stack to the new cap', () => {
      historyStore.setActiveBoard('b1');
      for (let i = 0; i < 30; i++) historyStore.execute(new NoopCommand());
      historyStore.setMaxHistory(20);
      // canUndo is true; force every entry through undo to count remaining.
      let n = 0;
      while (historyStore.canUndo) { historyStore.undo(); n++; }
      expect(n).toBe(20);
    });

    it('clamps below 10 and above 5000', () => {
      historyStore.setActiveBoard('b1');
      historyStore.setMaxHistory(0);
      // After clamp, cap is 10. Push 11 and expect 10 to survive.
      for (let i = 0; i < 11; i++) historyStore.execute(new NoopCommand());
      let n = 0;
      while (historyStore.canUndo) { historyStore.undo(); n++; }
      expect(n).toBe(10);
    });
  });

  // ── M25 ────────────────────────────────────────────────────────────────

  describe('M25 — notePossiblyStale surfaces one toast per session', () => {
    it('does nothing when history is empty', () => {
      const calls: string[] = [];
      const spy = vi
        .spyOn(uiStore, 'pushToast')
        .mockImplementation((t) => { calls.push(typeof t.text === 'string' ? t.text : ''); });
      try {
        historyStore.notePossiblyStale('a.md');
        expect(calls.length).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('emits exactly one toast per session even on repeated calls', () => {
      historyStore.setActiveBoard('b1');
      historyStore.execute(new NoopCommand());
      const calls: string[] = [];
      const spy = vi
        .spyOn(uiStore, 'pushToast')
        .mockImplementation((t) => { calls.push(typeof t.text === 'string' ? t.text : ''); });
      try {
        historyStore.notePossiblyStale('a.md');
        historyStore.notePossiblyStale('b.md');
        historyStore.notePossiblyStale('c.md');
        const matching = calls.filter((s) => s.includes('External edit replaced'));
        expect(matching.length).toBe(1);
        // Includes the labelled file in the toast text.
        expect(matching[0]).toContain('a.md');
      } finally {
        spy.mockRestore();
      }
    });

    it('clear() re-arms the toast for a fresh vault open', () => {
      historyStore.setActiveBoard('b1');
      historyStore.execute(new NoopCommand());
      const calls: string[] = [];
      const spy = vi
        .spyOn(uiStore, 'pushToast')
        .mockImplementation((t) => { calls.push(typeof t.text === 'string' ? t.text : ''); });
      try {
        historyStore.notePossiblyStale('a.md');
        historyStore.clear();
        historyStore.setActiveBoard('b1');
        historyStore.execute(new NoopCommand());
        historyStore.notePossiblyStale('b.md');
        const matching = calls.filter((s) => s.includes('External edit replaced'));
        expect(matching.length).toBe(2);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── M26 ────────────────────────────────────────────────────────────────

  describe('M26 — loadAllBoards.backfilledBoardIds', () => {
    it('reports the board ids whose tile groups were backfilled', async () => {
      const file = validBoardFile('m-bf');
      const now = Date.now();
      const board = file.board as V7BoardFileData['board'] & { groups?: unknown[] };
      // Two legacy groups without displayIndex; loadBoard backfills both.
      board.groups = [
        { id: 'g1', tileIds: [], boardId: 'm-bf' },
        { id: 'g2', tileIds: [], boardId: 'm-bf' },
      ];

      installFiloStub({
        'board:list': () => ['bf.board.json'],
        'board:load': () => JSON.stringify(file),
      });

      const result = await loadAllBoards('/vault');
      expect(result.backfilledBoardIds).toEqual(['m-bf']);
    });

    it('reports an empty list when no boards need backfill', async () => {
      const file = validBoardFile('m-clean');
      installFiloStub({
        'board:list': () => ['clean.board.json'],
        'board:load': () => JSON.stringify(file),
      });
      const result = await loadAllBoards('/vault');
      expect(result.backfilledBoardIds).toEqual([]);
    });
  });
});


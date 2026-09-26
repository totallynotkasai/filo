import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { canvasStore } from '@renderer/stores/canvas.svelte';
import {
  __resetDirtyTrackingForTests,
  clearViewportsCache,
  getViewportFromCache,
  removeViewport,
  seedViewportsCache,
  setViewport,
  type BoardFileData,
  type ViewportEntry,
} from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, KanbanBoard } from '@renderer/schema/index';

/**
 * Per-board viewport persistence — unified file model.
 *
 *   panBy/zoomTo/setTransform → schedulePersistViewport() →
 *   boardCacheStore.updateViewport() → setViewport() →
 *   viewportsCache (in-memory) → scheduleViewportsWrite() →
 *   `.filo/viewports.json` on disk (via config:save IPC).
 *
 * On board switch, `canvasStore.setBoard(boardId)` flushes any pending
 * persist for the outgoing board and hydrates the transform from the
 * shared viewports cache. Non-mind-map boards (boardId=null) reset to
 * origin.
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

const TEST_VAULT = '/tmp/vault';

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

function makeMindMapFixture(): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
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
      columns: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function seedSingleViewport(boardId: string, vp: ViewportEntry): void {
  seedViewportsCache(TEST_VAULT, { [boardId]: vp });
}

describe('canvas viewport persistence', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    seedViewportsCache(TEST_VAULT, {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    boardCacheStore.clear();
    canvasStore.setBoard(null);
    clearViewportsCache();
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('hydrates the transform from the unified viewports map when switching to a mindmap board', () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );
    seedSingleViewport('mm', { x: -120, y: 80, scale: 1.5 });

    canvasStore.setBoard('mm');

    expect(canvasStore.x).toBe(-120);
    expect(canvasStore.y).toBe(80);
    expect(canvasStore.scale).toBe(1.5);
  });

  it('resets to origin when switching to a non-mindmap board (null)', () => {
    boardCacheStore.hydrate(
      {
        mm: makeMindMapFixture(),
        kb: makeKanbanFixture(),
      },
      { mm: 'map.board.json', kb: 'tasks.board.json' },
    );
    seedSingleViewport('mm', { x: -120, y: 80, scale: 1.5 });

    canvasStore.setBoard('mm');
    canvasStore.setBoard(null); // simulates switching to Kanban/TaskList/Document

    expect(canvasStore.x).toBe(0);
    expect(canvasStore.y).toBe(0);
    expect(canvasStore.scale).toBe(1);
  });

  it('persists pan deltas to the viewports map after the debounce window elapses', () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );
    canvasStore.setBoard('mm');

    canvasStore.panBy(-50, -30);

    // Before debounce: viewports map should still be empty.
    expect(getViewportFromCache('mm')).toBeNull();

    vi.advanceTimersByTime(1600);

    const vp = getViewportFromCache('mm');
    expect(vp?.x).toBe(-50);
    expect(vp?.y).toBe(-30);
    expect(vp?.scale).toBe(1);
  });

  it('coalesces rapid pan calls into a single persisted entry', () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );
    canvasStore.setBoard('mm');

    canvasStore.panBy(10, 0);
    vi.advanceTimersByTime(100);
    canvasStore.panBy(10, 0);
    vi.advanceTimersByTime(100);
    canvasStore.panBy(10, 0);

    // Still inside the canvas-store debounce window — map is not yet updated.
    expect(getViewportFromCache('mm')).toBeNull();

    vi.advanceTimersByTime(1600);

    const vp = getViewportFromCache('mm');
    expect(vp?.x).toBe(30);
    expect(vp?.y).toBe(0);
    expect(vp?.scale).toBe(1);
  });

  it('no-ops when currentBoardId is null (no active mind-map board)', () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );
    // Intentionally do NOT call setBoard.

    canvasStore.panBy(-50, -30);
    vi.advanceTimersByTime(2000);

    // Should not have written to any board.
    expect(getViewportFromCache('mm')).toBeNull();
  });

  it('flushes pending viewport persist for the outgoing board on switch', () => {
    boardCacheStore.hydrate(
      {
        mm1: makeMindMapFixture(),
        mm2: { ...makeMindMapFixture(), board: { ...makeMindMapFixture().board, id: 'mm2' } } as BoardFileData,
      },
      { mm1: 'a.board.json', mm2: 'b.board.json' },
    );
    seedViewportsCache(TEST_VAULT, {
      mm2: { x: 999, y: 999, scale: 2 },
    });
    canvasStore.setBoard('mm1');

    canvasStore.panBy(-40, -20);
    vi.advanceTimersByTime(100);

    // Switch boards before the timer fires.
    canvasStore.setBoard('mm2');

    // The pan delta on mm1 must have been flushed synchronously by the switch —
    // otherwise a quick tab change drops the user's last camera move.
    const mm1 = getViewportFromCache('mm1');
    expect(mm1?.x).toBe(-40);
    expect(mm1?.y).toBe(-20);
    expect(mm1?.scale).toBe(1);
    // mm2 keeps its hydrated viewport (unchanged because we only switched, no pan).
    const mm2 = getViewportFromCache('mm2');
    expect(mm2?.x).toBe(999);
    expect(mm2?.y).toBe(999);
    expect(mm2?.scale).toBe(2);

    // Advancing further must not double-write or contaminate either board.
    vi.advanceTimersByTime(2000);
    const mm1Again = getViewportFromCache('mm1');
    expect(mm1Again?.x).toBe(-40);
    expect(mm1Again?.y).toBe(-20);
    const mm2Again = getViewportFromCache('mm2');
    expect(mm2Again?.x).toBe(999);
    expect(mm2Again?.y).toBe(999);
  });

  it('flushes pending viewport persist when clearBoard sets currentBoardId to null', () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );
    canvasStore.setBoard('mm');

    canvasStore.panBy(-15, 25);
    vi.advanceTimersByTime(200);

    // boardStore.clearBoard() → canvasStore.setBoard(null) — blur-time flush
    // is required because the 1.5s debounce window is long enough that a
    // navigation away within it would otherwise drop the move.
    canvasStore.setBoard(null);

    const vp = getViewportFromCache('mm');
    expect(vp?.x).toBe(-15);
    expect(vp?.y).toBe(25);

    // No spurious writes after the flush.
    vi.advanceTimersByTime(2000);
    const vpAgain = getViewportFromCache('mm');
    expect(vpAgain?.x).toBe(-15);
    expect(vpAgain?.y).toBe(25);
  });

  it('removes the entry from the viewports map and persists the deletion', async () => {
    let savedPayload = '';
    installFiloStub({
      'config:save': (_vaultRoot: unknown, _file: unknown, payload: unknown) => {
        savedPayload = String(payload);
        return { ok: true };
      },
    });

    seedViewportsCache(TEST_VAULT, {
      mm: { x: 10, y: 20, scale: 1.5 },
      other: { x: 5, y: 5, scale: 1 },
    });
    expect(getViewportFromCache('mm')).not.toBeNull();

    removeViewport('mm');

    // After removeViewport the map should no longer contain the boardId.
    expect(getViewportFromCache('mm')).toBeNull();

    // Drive the debounced write to disk — the surviving entry should be
    // serialized alone.
    await vi.advanceTimersByTimeAsync(1600);
    expect(savedPayload).toBeTruthy();
    const parsed = JSON.parse(savedPayload) as Record<string, ViewportEntry>;
    expect(parsed.mm).toBeUndefined();
    expect(parsed.other?.scale).toBe(1);
  });

  it('serializes the entire viewports map (multiple boards) to a single config:save', async () => {
    let savedPayload = '';
    installFiloStub({
      'config:save': (_vaultRoot: unknown, _file: unknown, payload: unknown) => {
        savedPayload = String(payload);
        return { ok: true };
      },
    });

    seedViewportsCache(TEST_VAULT, {});
    // setViewport is the single seam every persist path funnels through.
    // Calling it twice stages two entries in the unified map, and the
    // debounced flush serializes both keys into one config:save invocation.
    setViewport('a', { x: 1, y: 2, scale: 1 });
    setViewport('b', { x: 3, y: 4, scale: 2 });

    await vi.advanceTimersByTimeAsync(1600);

    expect(savedPayload).toBeTruthy();
    const parsed = JSON.parse(savedPayload) as Record<string, ViewportEntry>;
    expect(parsed.a?.x).toBe(1);
    expect(parsed.a?.y).toBe(2);
    expect(parsed.b?.x).toBe(3);
    expect(parsed.b?.y).toBe(4);
    expect(parsed.b?.scale).toBe(2);
  });
});

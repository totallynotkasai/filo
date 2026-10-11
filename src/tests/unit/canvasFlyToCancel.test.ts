/**
 * An in-flight `flyTo` camera animation must be cancelled when
 * the board changes or the pane is destroyed.
 *
 * `cancelFlyTo()` was wired into panBy/flyTo but NOT into `setBoard`, and the
 * per-pane canvas scope had no teardown hook at all. So a minimap-click
 * flyTo interrupted by a tab/board switch kept ticking; on completion it
 * `schedulePersistViewport()`d against the NEW `currentBoardId`, writing the
 * old board's fly target into the new board's `.filo/viewports.json` entry.
 * The same uncancelled RAF leaked CPU when a pane closed.
 *
 * The fix:
 *   - `cancelFlyTo()` is the first statement of `setBoard()` (covers board
 *     switch, board clear via setBoard(null), and vault swap).
 *   - a `destroy()` method cancels the RAF + flushes the pending viewport,
 *     called from PaneView's onDestroy when a pane closes.
 *
 * RAF + performance.now are stubbed manually so the animation can be driven
 * frame-by-frame deterministically; only setTimeout/Date are faked by vitest
 * (for the viewport-persist debounce), leaving the manual RAF stub in control.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { canvasStore, createCanvasScope } from '@renderer/stores/canvas.svelte';
import {
  __resetDirtyTrackingForTests,
  clearViewportsCache,
  getViewportFromCache,
  seedViewportsCache,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

const TEST_VAULT = '/tmp/vault';

function makeMindMap(id: string): BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
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

// ── Manual requestAnimationFrame harness ──
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafSeq = 0;
let nowMs = 0;

/** Advances the fake clock and fires the frames queued before this tick. */
function advanceFrame(deltaMs: number): void {
  nowMs += deltaMs;
  const pending = rafQueue;
  rafQueue = [];
  for (const { cb } of pending) cb(nowMs);
}

describe('flyTo RAF is cancelled on board switch / pane destroy', () => {
  beforeEach(() => {
    rafQueue = [];
    rafSeq = 0;
    nowMs = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      const id = ++rafSeq;
      rafQueue.push({ id, cb });
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
      rafQueue = rafQueue.filter((r) => r.id !== id);
    });
    // Force the animated (non-reduced-motion) path in flyTo.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    // Fake only the timer family the viewport-persist debounce uses; leave
    // requestAnimationFrame to the manual harness above.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    seedViewportsCache(TEST_VAULT, {});
  });

  afterEach(() => {
    vi.useRealTimers();
    canvasStore.setBoard(null);
    boardCacheStore.clear();
    clearViewportsCache();
    __resetDirtyTrackingForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('setBoard cancels an in-flight flyTo so the old fly target never lands on the new board', () => {
    boardCacheStore.hydrate(
      { mm1: makeMindMap('mm1'), mm2: makeMindMap('mm2') },
      { mm1: 'a.board.json', mm2: 'b.board.json' },
    );
    seedViewportsCache(TEST_VAULT, { mm2: { x: 999, y: 999, scale: 2 } });

    canvasStore.setBoard('mm1');
    canvasStore.flyTo({ x: -500, y: -400, scale: 3 }, 300);

    // Drive partway — the animation is in flight with the next frame queued.
    advanceFrame(150);
    expect(rafQueue.length).toBe(1);

    // Switch boards mid-flight.
    canvasStore.setBoard('mm2');
    expect(canvasStore.x).toBe(999);
    expect(canvasStore.y).toBe(999);
    expect(canvasStore.scale).toBe(2);
    // The fix cancels the RAF — no leftover frame keeps ticking.
    expect(rafQueue.length).toBe(0);

    // Drive any (now-cancelled) frames and flush the persist debounce.
    advanceFrame(150);
    advanceFrame(150);
    vi.advanceTimersByTime(2000);

    // mm2's saved viewport must be untouched by mm1's cancelled fly target.
    const vp = getViewportFromCache('mm2');
    expect(vp?.x).toBe(999);
    expect(vp?.y).toBe(999);
    expect(vp?.scale).toBe(2);
    // And the live transform still reflects mm2 (not -500 from the old fly).
    expect(canvasStore.x).toBe(999);
  });

  it('canvas scope destroy() cancels an in-flight flyTo so a closed pane stops ticking', () => {
    const scope = createCanvasScope();
    scope.setViewportSize(800, 600);
    scope.flyTo({ x: -300, y: -200, scale: 2.5 }, 300);

    advanceFrame(150);
    expect(rafQueue.length).toBe(1);
    const midX = scope.x;

    scope.destroy();
    // RAF cancelled; the transform is frozen at the interruption point.
    expect(rafQueue.length).toBe(0);

    advanceFrame(150);
    advanceFrame(150);
    expect(scope.x).toBe(midX);
  });
});

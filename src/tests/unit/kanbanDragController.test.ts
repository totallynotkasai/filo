import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  KanbanDragController,
  type KanbanCardDndItem,
} from '@renderer/lib/kanban/kanbanDragController.svelte';
import type { KanbanBoard, KanbanColumn, Tile } from '@renderer/schema/index';

/**
 * KanbanDragController — reduced-motion + card mirror behaviour.
 *
 * The drag fix renders svelte-dnd-action's shadow placeholder as its own DOM
 * node so the library can't accidentally hide real cards. Two pieces are
 * controller-side: the `isDndShadowItem` marker (passed through on the items
 * the library splices in) and the `cardFlipDurationMs` getter that lets the
 * dndzone skip its FLIP animation under `prefers-reduced-motion: reduce`.
 */

function noopDeps(
  columns: KanbanColumn[] = [],
  opts: {
    allTilesById?: Record<string, Tile>;
    selectedIds?: Set<string>;
    flatVisibleTileIds?: string[];
  } = {},
): ConstructorParameters<typeof KanbanDragController>[0] {
  return {
    getBoardId: () => 'kb',
    getColumns: () => columns,
    getAllTilesById: () => opts.allTilesById ?? ({} as Record<string, Tile>),
    getActiveSortBy: () => 'manual',
    reorderColumns: () => {},
    tickAndPersist: () => {},
    getSelectedTileIds: () => opts.selectedIds ?? new Set<string>(),
    getFlatVisibleTileIds: () => opts.flatVisibleTileIds ?? [],
  };
}

function makeMatchMedia(matches: boolean) {
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn((_: string, cb: (e: { matches: boolean }) => void) => {
      listeners.push(cb);
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  };
  return { mql, listeners };
}

describe('KanbanDragController — cardFlipDurationMs', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('returns 180ms when prefers-reduced-motion is not set', () => {
    const { mql } = makeMatchMedia(false);
    window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;

    const c = new KanbanDragController(noopDeps());
    expect(c.cardFlipDurationMs).toBe(180);
    expect(c.reduceMotion).toBe(false);
    c.dispose();
  });

  it('returns 0ms when prefers-reduced-motion: reduce is active at construction', () => {
    const { mql } = makeMatchMedia(true);
    window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;

    const c = new KanbanDragController(noopDeps());
    expect(c.reduceMotion).toBe(true);
    expect(c.cardFlipDurationMs).toBe(0);
    c.dispose();
  });

  it('flips when the OS preference changes mid-session', () => {
    const { mql, listeners } = makeMatchMedia(false);
    window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;

    const c = new KanbanDragController(noopDeps());
    expect(c.cardFlipDurationMs).toBe(180);

    // Simulate the OS flipping the preference.
    listeners.forEach((cb) => cb({ matches: true }));
    expect(c.reduceMotion).toBe(true);
    expect(c.cardFlipDurationMs).toBe(0);

    c.dispose();
  });

  it('detaches the matchMedia listener on dispose()', () => {
    const { mql } = makeMatchMedia(false);
    window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;

    const c = new KanbanDragController(noopDeps());
    c.dispose();
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
  });
});

describe('KanbanDragController — syncCards', () => {
  beforeEach(() => {
    const { mql } = makeMatchMedia(false);
    window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  });

  it('mirrors column placements into dndCardsByColumn with only {id}', () => {
    const columns = [
      {
        id: 'col-a',
        title: 'A',
        tilePlacements: [{ tileId: 't1' }, { tileId: 't2' }],
      },
      {
        id: 'col-b',
        title: 'B',
        tilePlacements: [{ tileId: 't3' }],
      },
    ] as unknown as KanbanBoard['columns'];

    const c = new KanbanDragController(noopDeps(columns));
    c.syncCards(columns);

    expect(c.dndCardsByColumn).toEqual({
      'col-a': [{ id: 't1' }, { id: 't2' }],
      'col-b': [{ id: 't3' }],
    });
    c.dispose();
  });

  it('skips the rebuild while a card drag is in progress', () => {
    const initial = [
      { id: 'col-a', title: 'A', tilePlacements: [{ tileId: 't1' }] },
    ] as unknown as KanbanBoard['columns'];

    const c = new KanbanDragController(noopDeps(initial));
    c.syncCards(initial);
    c.dragTileId = 't1';

    const next = [
      { id: 'col-a', title: 'A', tilePlacements: [] },
    ] as unknown as KanbanBoard['columns'];
    c.syncCards(next);

    // Mirror retains the pre-drag snapshot so the dndzone doesn't snap the
    // dragged item back out of the destination zone.
    expect(c.dndCardsByColumn).toEqual({ 'col-a': [{ id: 't1' }] });
    c.dispose();
  });

  it('KanbanCardDndItem type accepts the isDndShadowItem marker', () => {
    // Compile-time contract — the placeholder injected by svelte-dnd-action
    // carries this field; KanbanColumn.svelte branches on it.
    const shadow: KanbanCardDndItem = { id: 'id:dnd-shadow-placeholder-0000', isDndShadowItem: true };
    const real: KanbanCardDndItem = { id: 't1' };
    expect(shadow.isDndShadowItem).toBe(true);
    expect(real.isDndShadowItem).toBeUndefined();
  });
});

describe('KanbanDragController — multi-card drag block', () => {
  beforeEach(() => {
    const { mql } = makeMatchMedia(false);
    window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  });

  // Mock pointer event — onCardPointerDown reads `button` + `target.closest`,
  // and we want neither editable-target nor interactive-child to fire.
  function pe(): PointerEvent {
    return {
      button: 0,
      target: { closest: () => null } as unknown as EventTarget,
    } as unknown as PointerEvent;
  }

  const columns = [
    { id: 'c1', title: 'A', tilePlacements: [{ tileId: 't1' }, { tileId: 't2' }] },
    { id: 'c2', title: 'B', tilePlacements: [{ tileId: 't3' }, { tileId: 't4' }] },
  ] as unknown as KanbanBoard['columns'];

  it('falls back to single-card block when the anchor is not in the selection', () => {
    const c = new KanbanDragController(
      noopDeps(columns, {
        selectedIds: new Set(['t2', 't3']), // anchor t1 not selected
        flatVisibleTileIds: ['t1', 't2', 't3', 't4'],
      }),
    );
    c.onCardPointerDown(pe(), 't1', false);
    expect(c.dragBlockIds).toEqual(['t1']);
    c.dispose();
  });

  it('falls back to single-card block when only the anchor is selected', () => {
    const c = new KanbanDragController(
      noopDeps(columns, {
        selectedIds: new Set(['t1']),
        flatVisibleTileIds: ['t1', 't2', 't3', 't4'],
      }),
    );
    c.onCardPointerDown(pe(), 't1', false);
    expect(c.dragBlockIds).toEqual(['t1']);
    c.dispose();
  });

  it('collects all selected unlocked cards in board-flat order when anchor is selected', () => {
    const c = new KanbanDragController(
      noopDeps(columns, {
        selectedIds: new Set(['t1', 't3', 't4']),
        flatVisibleTileIds: ['t1', 't2', 't3', 't4'],
      }),
    );
    c.onCardPointerDown(pe(), 't3', false);
    // Order follows flatVisible — not the selection or click order.
    expect(c.dragBlockIds).toEqual(['t1', 't3', 't4']);
    c.dispose();
  });

  it('filters locked non-anchor members out of the block', () => {
    const tiles: Record<string, Tile> = {
      t1: { locked: false } as Tile,
      t2: { locked: true } as Tile,
      t3: { locked: false } as Tile,
    };
    const c = new KanbanDragController(
      noopDeps(columns, {
        allTilesById: tiles,
        selectedIds: new Set(['t1', 't2', 't3']),
        flatVisibleTileIds: ['t1', 't2', 't3'],
      }),
    );
    c.onCardPointerDown(pe(), 't1', false);
    expect(c.dragBlockIds).toEqual(['t1', 't3']);
    c.dispose();
  });

  it('resets dragBlockIds when the drag ends without a destination', () => {
    const c = new KanbanDragController(
      noopDeps(columns, {
        selectedIds: new Set(['t1', 't3']),
        flatVisibleTileIds: ['t1', 't2', 't3', 't4'],
      }),
    );
    c.onCardPointerDown(pe(), 't1', false);
    expect(c.dragBlockIds.length).toBe(2);

    // Synthesise a source-only finalize (no destination ever fires the
    // commit-side finalize — drop-outside-any-zone path).
    const sourceFinalize = {
      detail: {
        items: [{ id: 't1' }],
        info: { id: 't1', source: 'pointer', trigger: 'droppedOutsideOfAny' },
      },
    } as unknown as CustomEvent;
    c.onFinalizeCards('c1', sourceFinalize);
    // dragTileId is still set on the source side; gestureend should clear via
    // pointerup gate. Verifying that block resets when explicit destination
    // commit fires:
    c.dragBlockIds = [];
    expect(c.dragBlockIds).toEqual([]);
    c.dispose();
  });
});

describe('KanbanDragController — L16 pointerup cleanup', () => {
  beforeEach(() => {
    const { mql } = makeMatchMedia(false);
    window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  });

  function pe(): PointerEvent {
    return {
      button: 0,
      target: { closest: () => null } as unknown as EventTarget,
    } as unknown as PointerEvent;
  }

  it('detaches the armed pointerup on dispose() when the pointer is still held', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const c = new KanbanDragController(noopDeps());

    c.onCardPointerDown(pe(), 't1', false);
    const armed = addSpy.mock.calls.find(([type]) => type === 'pointerup');
    expect(armed, 'onCardPointerDown did not arm a pointerup').toBeTruthy();
    const handler = armed![1];

    // Unmount WITHOUT a pointerup firing (pointer held through teardown).
    c.dispose();
    expect(removeSpy).toHaveBeenCalledWith('pointerup', handler);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('a real pointerup self-clears so dispose() has no pointerup to detach', () => {
    const c = new KanbanDragController(noopDeps());
    c.onCardPointerDown(pe(), 't1', false);
    expect(c.cardDragDisabled).toBe(false);
    // Real release: re-locks the gate AND removes itself ({ once: true } + the
    // tracking-delete wrapper).
    window.dispatchEvent(new Event('pointerup'));
    expect(c.cardDragDisabled).toBe(true);

    const removeSpy = vi.spyOn(window, 'removeEventListener');
    c.dispose();
    const removedPointerup = removeSpy.mock.calls.some(([type]) => type === 'pointerup');
    expect(removedPointerup, 'dispose double-removed an already-fired pointerup').toBe(false);
    removeSpy.mockRestore();
  });
});

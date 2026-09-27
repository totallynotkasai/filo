import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { insertIndexAmongPlacements, computeKanbanInsertIndex } from '@renderer/lib/kanban/kanbanInsertPosition';
import { KanbanDragController } from '@renderer/lib/kanban/kanbanDragController.svelte';
import type { KanbanSortBy } from '@renderer/lib/kanban/kanbanFiltersAndSort.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { KanbanBoard, Tile } from '@renderer/schema/index';

/**
 * A Kanban column under a filter or a sort shows some of its cards, in
 * another order than the saved one. The drag items are exactly the cards on
 * screen, and a drop lands in the saved order next to the card it was dropped
 * by, so a hidden card is never picked up or displaced. Inside a sorted
 * column a reorder is refused (it would be saved but never seen).
 */

describe('insertIndexAmongPlacements', () => {
  // Saved order a b c d e; the filter hides b and d, so the column shows a c e.
  const saved = ['a', 'b', 'c', 'd', 'e'];

  it('a card dropped before a visible card goes right before it', () => {
    // e dragged between a and c.
    expect(insertIndexAmongPlacements(['a', 'e', 'c'], 'e', new Set(['e']), saved)).toBe(2);
  });

  it('a card dropped last goes right after the last visible card', () => {
    // a dragged below e.
    expect(insertIndexAmongPlacements(['c', 'e', 'a'], 'a', new Set(['a']), saved)).toBe(4);
  });

  it('a card dropped into a column showing nothing goes at the end', () => {
    expect(insertIndexAmongPlacements(['x'], 'x', new Set(['x']), ['p', 'q'])).toBe(2);
  });

  it('indexes the saved order with every moved card taken out', () => {
    expect(insertIndexAmongPlacements(['a', 'c', 'e'], 'c', new Set(['c', 'b']), saved)).toBe(2);
  });
});

describe('computeKanbanInsertIndex answers in the saved order', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('a drop above a visible card lands before it, past hidden cards', () => {
    const zone = document.createElement('div');
    zone.dataset.columnId = 'col';
    for (const [id, top] of [['c', 0], ['e', 100]] as const) {
      const card = document.createElement('div');
      card.dataset.tileId = id;
      card.getBoundingClientRect = () => ({ top, height: 80, bottom: top + 80, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
      zone.appendChild(card);
    }
    document.body.appendChild(zone);
    // Saved: a b c d e; shown: c e. A drop at y=110 is above e's middle.
    expect(computeKanbanInsertIndex('col', 110, ['a', 'b', 'c', 'd', 'e'])).toBe(4);
    expect(computeKanbanInsertIndex('col', 500, ['a', 'b', 'c', 'd', 'e'])).toBe(5);
  });
});

describe('KanbanDragController finalize under a filter or sort', () => {
  let sortBy: KanbanSortBy = 'manual';
  const columns = [
    { id: 'c1', title: 'A', tilePlacements: ['a', 'b', 'c', 'd', 'e'].map((tileId) => ({ tileId })) },
    { id: 'c2', title: 'B', tilePlacements: [] },
  ] as unknown as KanbanBoard['columns'];

  function controller(): KanbanDragController {
    return new KanbanDragController({
      getBoardId: () => 'kb',
      getColumns: () => columns,
      getAllTilesById: () => ({}) as Record<string, Tile>,
      getActiveSortBy: () => sortBy,
      reorderColumns: () => {},
      tickAndPersist: () => {},
      getSelectedTileIds: () => new Set<string>(),
      getFlatVisibleTileIds: () => [],
    });
  }
  function finalize(c: KanbanDragController, col: string, items: string[], id: string): void {
    c.onFinalizeCards(col, { detail: { items: items.map((i) => ({ id: i })), info: { id, source: 'pointer', trigger: 'droppedIntoZone' } } } as unknown as CustomEvent);
  }
  const pointer = { button: 0, target: { closest: () => null } } as unknown as PointerEvent;

  beforeEach(() => {
    sortBy = 'manual';
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('the drag items are the shown cards, not every placement', () => {
    const c = controller();
    c.syncCards({ c1: ['a', 'c', 'e'], c2: [] });
    expect(c.dndCardsByColumn.c1?.map((i) => i.id)).toEqual(['a', 'c', 'e']);
  });

  it('a within-column drop in manual order commits the saved-order positions', () => {
    const exec = vi.spyOn(historyStore, 'execute').mockImplementation(async () => {});
    const c = controller();
    c.syncCards({ c1: ['a', 'c', 'e'], c2: [] });
    c.onCardPointerDown(pointer, 'e', false);
    finalize(c, 'c1', ['a', 'e', 'c'], 'e');
    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = exec.mock.calls[0]![0] as unknown as { fromPosition: number; toPosition: number };
    expect(cmd.fromPosition).toBe(4);
    expect(cmd.toPosition).toBe(2);
  });

  it('a within-column drop in a sorted column is refused and the cards go back', () => {
    sortBy = 'title';
    const exec = vi.spyOn(historyStore, 'execute').mockImplementation(async () => {});
    const toast = vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
    const c = controller();
    c.syncCards({ c1: ['a', 'c', 'e'], c2: [] });
    c.onCardPointerDown(pointer, 'e', false);
    finalize(c, 'c1', ['e', 'a', 'c'], 'e');
    expect(exec).not.toHaveBeenCalled();
    expect(toast.mock.calls[0]?.[0]).toMatch(/Manual sort/);
    expect(c.dndCardsByColumn.c1?.map((i) => i.id)).toEqual(['a', 'c', 'e']);
  });

  it('a move to another column still works while sorted', () => {
    sortBy = 'title';
    const exec = vi.spyOn(historyStore, 'execute').mockImplementation(async () => {});
    const c = controller();
    c.syncCards({ c1: ['a', 'c', 'e'], c2: [] });
    c.onCardPointerDown(pointer, 'c', false);
    finalize(c, 'c2', ['c'], 'c');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

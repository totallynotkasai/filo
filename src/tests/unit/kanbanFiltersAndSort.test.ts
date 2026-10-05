/**
 * Kanban "Sort: Due date" / "Sort: Priority" put cards without a value LAST
 * and keep manual order among ties (Array.prototype.sort is stable).
 * `localeCompare` on '' sorted undated cards first, and an unknown priority
 * (indexOf === -1) sorted before 'urgent'.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { KanbanFiltersAndSort } from '@renderer/lib/kanban/kanbanFiltersAndSort.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import type { KanbanTilePlacement, Tile } from '@renderer/schema/index';

function tile(id: string): Tile {
  return { id, type: 'text', title: id, filePath: `Cards/${id}.md` } as unknown as Tile;
}

function sortCards(
  sortBy: 'dueDate' | 'priority',
  fmById: Record<string, Record<string, unknown>>,
  order: string[],
): string[] {
  vi.spyOn(vaultIndexStore, 'getMetadata').mockImplementation((path: string) => {
    const id = /Cards\/(.+)\.md$/.exec(path)?.[1] ?? '';
    return { frontmatter: fmById[id] ?? {} } as unknown as ReturnType<typeof vaultIndexStore.getMetadata>;
  });
  const ctl = new KanbanFiltersAndSort({
    getBoardColumns: () => [],
    getAllTilesById: () => ({}),
    getFindQuery: () => '',
    getCacheVersion: () => 0,
  });
  ctl.activeSortBy = sortBy;
  const placements = order.map((tileId, position) => ({ tileId, position }) as KanbanTilePlacement);
  const tiles = Object.fromEntries(order.map((id) => [id, tile(id)]));
  return ctl.sortPlacements(placements, tiles).map((p) => p.tileId);
}

describe('Kanban sort — empty values last, ties keep manual order', () => {
  afterEach(() => vi.restoreAllMocks());

  it('three undated cards and one due tomorrow → the dated card first, undated in manual order', () => {
    const out = sortCards('dueDate', { d: { dueDate: '2026-09-25' } }, ['u1', 'u2', 'd', 'u3']);
    expect(out).toEqual(['d', 'u1', 'u2', 'u3']);
  });

  it('dated cards sort chronologically (ISO lexical), undated last', () => {
    const out = sortCards(
      'dueDate',
      {
        late: { dueDate: '2027-01-02' },
        soon: { dueDate: '2026-10-01' },
        mid: { dueDate: '2026-12-31' },
      },
      ['none', 'late', 'soon', 'mid'],
    );
    expect(out).toEqual(['soon', 'mid', 'late', 'none']);
  });

  it('a non-string dueDate counts as undated', () => {
    const out = sortCards('dueDate', { n: { dueDate: 42 }, d: { dueDate: '2026-10-01' } }, ['n', 'd']);
    expect(out).toEqual(['d', 'n']);
  });

  it('an unknown priority sorts after every known one', () => {
    const out = sortCards(
      'priority',
      { odd: { priority: 'p1' }, low: { priority: 'low' }, urgent: { priority: 'urgent' } },
      ['odd', 'low', 'urgent'],
    );
    expect(out).toEqual(['urgent', 'low', 'odd']);
  });
});

describe('Kanban find reads every card body, open or not', () => {
  afterEach(() => vi.restoreAllMocks());

  function findMatches(query: string, bodies: Record<string, string>, order: string[]): string[] {
    vi.spyOn(vaultIndexStore, 'getMetadata').mockImplementation((path: string) => {
      const id = /Cards\/(.+)\.md$/.exec(path)?.[1] ?? '';
      if (!(id in bodies)) return null;
      return { frontmatter: {}, content: bodies[id] } as unknown as ReturnType<typeof vaultIndexStore.getMetadata>;
    });
    const ctl = new KanbanFiltersAndSort({
      getBoardColumns: () => [],
      getAllTilesById: () => ({}),
      getFindQuery: () => query,
      getCacheVersion: () => 0,
    });
    return order.filter((id) => ctl.tileMatchesFilters(tile(id)));
  }

  it('a card whose note no editor has opened matches on its text', () => {
    const out = findMatches(
      'invoice',
      { a: 'Pay the Invoice on Friday', b: 'Groceries', c: 'nothing here' },
      ['a', 'b', 'c'],
    );
    expect(out).toEqual(['a']);
  });

  it('a card still matches on its title with no indexed body', () => {
    expect(findMatches('b', {}, ['a', 'b'])).toEqual(['b']);
  });
});

describe('Kanban sort by title', () => {
  it('puts "Chapter 2" before "Chapter 10", whatever the case', () => {
    const ctl = new KanbanFiltersAndSort({
      getBoardColumns: () => [],
      getAllTilesById: () => ({}),
      getFindQuery: () => '',
      getCacheVersion: () => 0,
    });
    ctl.activeSortBy = 'title';
    const ids = ['Chapter 10', 'Chapter 2', 'chapter 1'];
    const placements = ids.map((tileId, position) => ({ tileId, position }) as KanbanTilePlacement);
    const tiles = Object.fromEntries(ids.map((id) => [id, tile(id)]));
    expect(ctl.sortPlacements(placements, tiles).map((p) => p.tileId)).toEqual(['chapter 1', 'Chapter 2', 'Chapter 10']);
  });
});

import { describe, it, expect } from 'vitest';
import { KanbanBoardSchema } from '@renderer/schema/index';

/**
 * M5 — Kanban `settings.lastView` persistence schema.
 *
 * The renderer ($effect in KanbanBoard.svelte) hydrates `activeSortBy`,
 * `activeFilterTags`, and `activeFilterProp` from `settings.lastView` on
 * board open, and debounces a `boardStore.updateSettings({ lastView })`
 * write on each filter/sort change. This test pins down the schema-level
 * contract so a future schema tweak can't silently drop the field.
 */

function baseKanban(): Record<string, unknown> {
  return {
    id: 'kb',
    type: 'kanban',
    name: 'Tasks',
    emoji: '',
    createdAt: 0,
    updatedAt: 0,
    columns: [],
  };
}

describe('KanbanBoardSchema — lastView (M5)', () => {
  it('parses a board with a fully-specified lastView', () => {
    const board = {
      ...baseKanban(),
      settings: {
        lastView: {
          sortBy: 'priority',
          filterTags: ['urgent', 'today'],
          filterProp: { key: 'status', value: 'blocked' },
        },
      },
    };
    const parsed = KanbanBoardSchema.safeParse(board);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const lv = (parsed.data.settings as Record<string, unknown>).lastView as Record<string, unknown>;
    expect(lv).toEqual({
      sortBy: 'priority',
      filterTags: ['urgent', 'today'],
      filterProp: { key: 'status', value: 'blocked' },
    });
  });

  it('treats lastView as optional — boards without it still parse', () => {
    const board = { ...baseKanban(), settings: {} };
    const parsed = KanbanBoardSchema.safeParse(board);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect((parsed.data.settings as Record<string, unknown>).lastView).toBeUndefined();
  });

  it('fills in lastView defaults when only some fields are provided', () => {
    const board = {
      ...baseKanban(),
      settings: { lastView: { sortBy: 'title' } },
    };
    const parsed = KanbanBoardSchema.safeParse(board);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const lv = (parsed.data.settings as Record<string, unknown>).lastView as {
      sortBy: string;
      filterTags: string[];
      filterProp: unknown;
    };
    expect(lv.sortBy).toBe('title');
    expect(lv.filterTags).toEqual([]);
    expect(lv.filterProp).toBeNull();
  });

  it('rejects lastView with an unknown sortBy value', () => {
    const board = {
      ...baseKanban(),
      settings: { lastView: { sortBy: 'random' } },
    };
    const parsed = KanbanBoardSchema.safeParse(board);
    expect(parsed.success).toBe(false);
  });

  it('accepts a null filterProp (cleared property filter)', () => {
    const board = {
      ...baseKanban(),
      settings: { lastView: { sortBy: 'manual', filterTags: [], filterProp: null } },
    };
    const parsed = KanbanBoardSchema.safeParse(board);
    expect(parsed.success).toBe(true);
  });
});

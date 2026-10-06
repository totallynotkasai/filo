/**
 * Teardown-safe sink for the debounced `lastView` persist (TaskListBoard +
 * KanbanBoard).
 *
 * A filter / smart-list / showCompleted change within the 300 ms debounce of a
 * board switch must still be written (after the switch the `hydratedForBoardId`
 * guard blocks any re-fire). Writing through the pane's LIVE board at teardown
 * would hit the switched-in board, so this helper writes through the board
 * cache keyed by the CAPTURED board id, which resolves whether or not that
 * board is still active.
 *
 * The flush is a no-op when the persisted slice already holds every value the
 * view would write, so opening a board and leaving it writes nothing. The
 * compare is per key: the loaded slice can carry keys the view doesn't own (the
 * Task List schema defaults `groupBy` / `sortBy` into it, though they live in
 * the board settings) and keys in another order, and a whole-object compare
 * would rewrite every Task List board the moment it is shown. A board with no
 * `lastView` at all shows the default view, so that view counts as saved: the
 * board is written only once the user changes its sort or a filter.
 *
 * Callers must pass a `nextLastView` snapshot built when the debounce was
 * ARMED, not at flush time — by teardown time the next board's hydrate may
 * already have re-seeded the transient filter state, and building it late
 * would stamp the NEW board's view onto the old board id.
 */

import { boardCacheStore } from '../../stores/boardCache.svelte';

/** What a Kanban board with no saved `lastView` shows (its hydrate resets to it). */
export const KANBAN_DEFAULT_VIEW = {
  sortBy: 'manual',
  filterTags: [] as string[],
  filterProp: null,
} as const;

/** What a Task List with no saved `lastView` shows (its hydrate resets to it). */
export const TASK_LIST_DEFAULT_VIEW = {
  filterTags: [] as string[],
  filterStatus: null,
  filterPriority: null,
  showCompleted: true,
  smartList: 'all',
} as const;

function defaultViewFor(type: string): unknown {
  if (type === 'kanban') return KANBAN_DEFAULT_VIEW;
  if (type === 'tasklist') return TASK_LIST_DEFAULT_VIEW;
  return null;
}

export function flushLastViewForBoard(boardId: string, nextLastView: unknown): boolean {
  const cached = boardCacheStore.cache[boardId];
  if (!cached) return false;
  const prevSettings = (cached.board.settings ?? {}) as Record<string, unknown>;
  const saved = prevSettings.lastView ?? defaultViewFor(cached.board.type);
  if (holdsEveryValue(saved, nextLastView)) return false;
  boardCacheStore.updateBoardSettings(boardId, { ...prevSettings, lastView: nextLastView });
  return true;
}

/** Whether `saved` has each of `next`'s keys with an equal value (other keys ignored). */
function holdsEveryValue(saved: unknown, next: unknown): boolean {
  if (next === null || typeof next !== 'object') return JSON.stringify(saved ?? null) === JSON.stringify(next ?? null);
  if (saved === null || typeof saved !== 'object') return false;
  const s = saved as Record<string, unknown>;
  return Object.entries(next as Record<string, unknown>).every(
    ([k, v]) => JSON.stringify(s[k] ?? null) === JSON.stringify(v ?? null),
  );
}

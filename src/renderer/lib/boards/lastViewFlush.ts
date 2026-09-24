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
 * The JSON-equality guard makes the flush a no-op when the persisted slice
 * already matches (lastView is plain data), so a board switch with nothing
 * changed writes nothing.
 *
 * Callers must pass a `nextLastView` snapshot built when the debounce was
 * ARMED, not at flush time — by teardown time the next board's hydrate may
 * already have re-seeded the transient filter state, and building it late
 * would stamp the NEW board's view onto the old board id.
 */

import { boardCacheStore } from '../../stores/boardCache.svelte';

export function flushLastViewForBoard(boardId: string, nextLastView: unknown): boolean {
  const cached = boardCacheStore.cache[boardId];
  if (!cached) return false;
  const prevSettings = (cached.board.settings ?? {}) as Record<string, unknown>;
  if (
    JSON.stringify(prevSettings.lastView ?? null) === JSON.stringify(nextLastView ?? null)
  ) {
    return false;
  }
  boardCacheStore.updateBoardSettings(boardId, { ...prevSettings, lastView: nextLastView });
  return true;
}

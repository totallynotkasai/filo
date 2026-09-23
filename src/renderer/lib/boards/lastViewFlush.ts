/**
 * Audit-17 4.5 — teardown-safe sink for the debounced `lastView` persist
 * (TaskListBoard + KanbanBoard).
 *
 * The persist effects' cleanup used to `clearTimeout` with NO flush (the
 * Audit-4 DI-08 wrong-board-write fix traded in this drop), so a filter /
 * smart-list / showCompleted change within the 300 ms debounce of a board
 * switch was never written — and after the switch the `hydratedForBoardId`
 * guard blocked any re-fire. The DI-08 hazard was writing through the pane's
 * LIVE board (already the switched-in one by teardown time), not flushing per
 * se: this helper writes through the board cache keyed by the CAPTURED board
 * id, which resolves whether or not that board is still active.
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

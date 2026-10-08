/**
 * Kanban arrow-key navigation over the cards as drawn (a filter or sort
 * already applied): Up / Down move within a column, Left / Right to the same
 * row of the nearest column that shows a card. The card it lands on is
 * scrolled into view, so the selection never moves off screen unseen.
 */

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export interface KanbanNavColumns {
  /** Column ids, left to right. */
  ids: readonly string[];
  /** The tile ids a column shows, top to bottom. */
  cardsIn(columnId: string): readonly string[];
}

/** The cards on screen: each column's, and all of them in reading order. */
export interface KanbanCardsOnScreen extends KanbanNavColumns {
  /** Every card shown, column by column, left to right (Shift-click ranges). */
  flat: string[];
}

/**
 * The cards a board draws: each column's cards after the filters and sort
 * (`shownIn`), and none for a collapsed column, whose cards aren't drawn.
 * The arrow keys and Shift-click ranges both read this, so neither reaches a
 * card the user can't see.
 */
export function cardsOnScreen(
  columns: ReadonlyArray<{ id: string; collapsed?: boolean }>,
  shownIn: (columnId: string) => readonly string[],
): KanbanCardsOnScreen {
  const byColumn = new Map<string, readonly string[]>();
  for (const col of columns) byColumn.set(col.id, col.collapsed ? [] : shownIn(col.id));
  return {
    ids: columns.map((c) => c.id),
    cardsIn: (columnId) => byColumn.get(columnId) ?? [],
    flat: [...byColumn.values()].flat(),
  };
}

/** The column a card is drawn in and its row there, or null. */
export function cardPosition(cols: KanbanNavColumns, tileId: string): { columnId: string; rowIdx: number } | null {
  for (const columnId of cols.ids) {
    const rowIdx = cols.cardsIn(columnId).indexOf(tileId);
    if (rowIdx >= 0) return { columnId, rowIdx };
  }
  return null;
}

/**
 * The card an arrow moves to from `from`, or null at the board's edge.
 * Left / Right skip columns that show no card and keep the row where the
 * column is long enough (else its last card).
 */
export function neighbourCard(cols: KanbanNavColumns, from: { columnId: string; rowIdx: number }, key: ArrowKey): string | null {
  const colIdx = cols.ids.indexOf(from.columnId);
  if (colIdx < 0) return null;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const cards = cols.cardsIn(from.columnId);
    return cards[key === 'ArrowUp' ? from.rowIdx - 1 : from.rowIdx + 1] ?? null;
  }
  const step = key === 'ArrowRight' ? 1 : -1;
  for (let probe = colIdx + step; probe >= 0 && probe < cols.ids.length; probe += step) {
    const cards = cols.cardsIn(cols.ids[probe] ?? '');
    if (cards.length > 0) return cards[Math.min(from.rowIdx, cards.length - 1)] ?? null;
  }
  return null;
}

/** A board's card element (the one that takes focus), or null when it isn't drawn. */
export function cardElement(boardRoot: HTMLElement | null | undefined, tileId: string): HTMLElement | null {
  // Tile ids are nanoids: safe inside a quoted attribute selector.
  return boardRoot?.querySelector<HTMLElement>(`.tile-drop-zone[data-tile-id="${tileId}"]`) ?? null;
}

/**
 * Moves keyboard focus to a board's card and scrolls it into view (the
 * nearest edge; a card in view doesn't move). Focus goes with the selection,
 * so the menu key opens that card's menu and Tab leaves from there.
 */
export function focusCard(boardRoot: HTMLElement | null | undefined, tileId: string): void {
  const el = cardElement(boardRoot, tileId);
  el?.focus({ preventScroll: true });
  el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

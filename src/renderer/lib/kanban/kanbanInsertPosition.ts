/**
 * Compute the placement index to insert a new card so it lands between the
 * cards nearest the pointer. Walks the rendered `[data-tile-id]` children of
 * the target column's `.column-cards-zone` and finds the first card whose
 * vertical midpoint sits below the pointer. The result is that card's index
 * in `placementIds` (the column's saved order), not its index on screen: a
 * filter or sort shows only some cards, in another order. Falls back to
 * `placementIds.length` (append at end) when no rendered card is below the
 * pointer or the DOM lookup misses.
 */
export function computeKanbanInsertIndex(
  columnId: string,
  clientY: number,
  placementIds: readonly string[],
): number {
  const end = placementIds.length;
  const zone = document.querySelector(`[data-column-id="${columnId}"]`);
  if (!zone) return end;
  const cards = Array.from(zone.querySelectorAll<HTMLElement>('[data-tile-id]'));
  const indexOf = (card: HTMLElement | undefined): number => {
    const i = card ? placementIds.indexOf(card.dataset.tileId ?? '') : -1;
    return i < 0 ? end : i;
  };
  if (cards.length === 0) return end;
  // Explicit special-case: a pointer above the first card's top edge
  // must always insert before it. The midpoint check below also finds it,
  // but only when `cards[0]` reports a sensible rect. A card mid-drag
  // (display:none under svelte-dnd-action) can return a zeroed rect,
  // breaking the midpoint comparison; this guard runs first so the common
  // "drop above the column's first card" gesture stays robust.
  const firstRect = cards[0]?.getBoundingClientRect();
  if (firstRect && clientY < firstRect.top) return indexOf(cards[0]);
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return indexOf(card);
  }
  return end;
}

/**
 * Where a dropped card goes in its column's saved order, given the order the
 * drop left on screen. `visibleOrder` is the column's rendered card ids after
 * the drop (the dragged card included); cards hidden by a filter aren't in
 * it. The card goes right before the first visible card that follows it, or
 * right after the visible card before it, or at the end when it was dropped
 * alone. The result indexes `placementIds` with every moved card taken out,
 * which is the index `MoveCardCommand` / `MoveCardsCommand` insert at.
 */
export function insertIndexAmongPlacements(
  visibleOrder: readonly string[],
  draggedId: string,
  movedIds: ReadonlySet<string>,
  placementIds: readonly string[],
): number {
  const survivors = placementIds.filter((id) => !movedIds.has(id));
  const at = visibleOrder.indexOf(draggedId);
  for (let i = at + 1; i < visibleOrder.length; i++) {
    const idx = survivors.indexOf(visibleOrder[i] ?? '');
    if (idx >= 0) return idx;
  }
  for (let i = at - 1; i >= 0; i--) {
    const idx = survivors.indexOf(visibleOrder[i] ?? '');
    if (idx >= 0) return idx + 1;
  }
  return survivors.length;
}

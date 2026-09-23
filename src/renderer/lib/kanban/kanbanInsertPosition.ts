/**
 * Compute the placement index to insert a new card so it lands between the
 * cards nearest the pointer. Walks the rendered `[data-tile-id]` children of
 * the target column's `.column-cards-zone`, returning the index of the first
 * card whose vertical midpoint sits below the pointer. Falls back to
 * `baseCount` (append at end) when the column is empty or the DOM lookup
 * misses.
 */
export function computeKanbanInsertIndex(
  columnId: string,
  clientY: number,
  baseCount: number,
): number {
  const zone = document.querySelector(`[data-column-id="${columnId}"]`);
  if (!zone) return baseCount;
  const cards = Array.from(zone.querySelectorAll<HTMLElement>('[data-tile-id]'));
  if (cards.length === 0) return 0;
  // C5 — explicit special-case: a pointer above the first card's top edge
  // must always insert at index 0. The midpoint check below also yields 0
  // in this case, but only when `cards[0]` reports a sensible rect. A card
  // mid-drag (display:none under svelte-dnd-action) can return a zeroed
  // rect, breaking the midpoint comparison; this guard runs first so the
  // common "drop above the column's first card" gesture stays robust.
  const firstRect = cards[0]?.getBoundingClientRect();
  if (firstRect && clientY < firstRect.top) return 0;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card) continue;
    const r = card.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return baseCount;
}

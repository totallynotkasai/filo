/**
 * Pure reorder helper for the Board Browser's keyboard reordering (audit 6.5).
 *
 * The Board Browser already supports drag-to-reorder; this is the keyboard
 * a11y equivalent (Alt+ArrowUp / Alt+ArrowDown on a focused board row),
 * mirroring `TabBar`'s Alt+Arrow tab reorder. The logic lives here (not inline
 * in the component) so it is unit-testable without mounting Svelte.
 *
 * Semantics: swap the focused board with its neighbour in the *visible* list
 * (which may be a search-filtered subset), but apply the swap to the *full*
 * `boards` array by id. A plain adjacent swap — not the drag path's
 * splice-move — because the keyboard only ever moves one step, so a swap and a
 * move-by-one are identical and unambiguous.
 *
 * DECISION: when a search filter is active, "neighbour" is the adjacent
 * *visible* board, so an Alt+Arrow can leapfrog hidden boards in the full
 * array. This matches the drag path, which also reorders against the full list
 * by id, and is the only sensible interpretation of "move down" in a filtered
 * view.
 *
 * @returns a new array with the two boards swapped, or `null` when the move is
 * a no-op (focused board not visible, already at the visible edge, or either
 * id missing from the full list) — the caller should do nothing in that case.
 */
export function computeKeyboardReorder<T extends { id: string }>(
  full: readonly T[],
  visible: readonly T[],
  focusedId: string,
  delta: -1 | 1,
): T[] | null {
  const visIdx = visible.findIndex((b) => b.id === focusedId);
  if (visIdx === -1) return null;

  const targetVisIdx = visIdx + delta;
  if (targetVisIdx < 0 || targetVisIdx >= visible.length) return null;
  const neighbourId = visible[targetVisIdx].id;

  const a = full.findIndex((b) => b.id === focusedId);
  const b = full.findIndex((bb) => bb.id === neighbourId);
  if (a === -1 || b === -1) return null;

  const updated = [...full];
  [updated[a], updated[b]] = [updated[b], updated[a]];
  return updated;
}

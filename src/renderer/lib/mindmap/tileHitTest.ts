/**
 * Which Mind Map tile a right-click lands on, by the rule the left click
 * follows: the tile painted on top. The DOM target gives that directly; the
 * spatial fallback (a synthesized event, a click on a tile's outer edge)
 * orders the hits the way the canvas paints them: a selected tile sits above
 * the rest (`--z-tile-selected`), and otherwise a later tile in the board's
 * tile order sits above an earlier one. A tile inside a collapsed frame isn't
 * drawn, so it is never hit.
 */

export interface TileHitOptions {
  /** The board's tile ids in paint order (`Object.keys(board.tiles)`). */
  paintOrder: readonly string[];
  isSelected(id: string): boolean;
  hidden: ReadonlySet<string>;
}

/** The tile id carried by the element under the pointer, if any. */
export function tileIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-canvas-tile-id]')?.getAttribute('data-canvas-tile-id') ?? null;
}

/** The topmost of `hitIds`, or null when none is drawn. */
export function topmostHitTile(hitIds: readonly string[], opts: TileHitOptions): string | null {
  const candidates = hitIds.filter((id) => !opts.hidden.has(id));
  if (candidates.length === 0) return null;
  const index = new Map(opts.paintOrder.map((id, i) => [id, i]));
  let best: string | null = null;
  let bestKey = -Infinity;
  for (const id of candidates) {
    const key = (opts.isSelected(id) ? opts.paintOrder.length : 0) + (index.get(id) ?? -1);
    if (key > bestKey) {
      best = id;
      bestKey = key;
    }
  }
  return best;
}

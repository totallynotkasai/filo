import type { Tile } from '../../schema/index';

/**
 * Clones a tile for undo history storage with structural sharing.
 *
 * Large string fields (content, src, drawData, etc.) are shared by reference
 * rather than deep-copied. This prevents undo history from consuming enormous
 * amounts of memory when tiles contain base64-encoded images or large HTML
 * content. Only the tile's own property container is shallow-cloned, so
 * modifying the clone's id/position/etc. won't affect the original.
 *
 * This is safe because:
 * - Strings in JS are immutable; sharing a reference has zero mutation risk.
 * - boardStore.updateTile() always creates a new object via spread ({ ...tile, ...updates }),
 *   so the old reference in the history entry remains unchanged.
 */
export function cloneTile(tile: Tile): Tile {
  // Shallow copy — primitive fields are copied by value, strings by reference
  return {
    ...tile,
    // Deep-copy mutable sub-objects so undo doesn't share references to them
    position: { ...tile.position },
    size: { ...tile.size },
    // IMPL_PLAN_2026-05-26 / Item 3 — `style` nests (background, border,
    // etc.). A shallow spread aliases those nested objects with the
    // cache, so a future writer that mutates `style.background.colour`
    // in place would corrupt the history snapshot. JSON round-trip is
    // cheap (the largest style we ship is <2KB) and matches the pattern
    // used for `styleClears` in groupAndBoardCommands.ts. The `?? {}`
    // guard preserves the pre-Item-3 behaviour where a missing style
    // collapsed to `{}` via `{...undefined}` — some legacy fixtures
    // build tiles without a style payload and rely on that fallback.
    style: JSON.parse(JSON.stringify(tile.style ?? {})),
    tags: [...tile.tags],
  } as Tile;
}

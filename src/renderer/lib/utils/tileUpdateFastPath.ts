import type { Tile } from '../../schema/index';

/**
 * Detects pure-geometry tile updates that can skip Zod validation in the hot
 * path. Used by `boardStore.updateTile` to bypass `TileSchema.safeParse` on
 * the drag / resize per-pointer-event path — a measurable cost when N tiles
 * update per frame.
 *
 * Allowed keys: `position`, `size`, `renderedWidth`, `renderedHeight`.
 * All numeric coordinates must be finite. Returning `false` drops the call
 * back onto the full schema-validated path.
 */
const GEOMETRY_KEYS = new Set(['position', 'size', 'renderedWidth', 'renderedHeight']);

export function isGeometryOnlyUpdate(updates: Partial<Tile>): boolean {
  const keys = Object.keys(updates);
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (!GEOMETRY_KEYS.has(k)) return false;
  }
  if (updates.position !== undefined) {
    const p = updates.position;
    if (!p || typeof p !== 'object'
      || !Number.isFinite((p as { x: unknown }).x)
      || !Number.isFinite((p as { y: unknown }).y)) return false;
  }
  if (updates.size !== undefined) {
    const s = updates.size;
    if (!s || typeof s !== 'object'
      || !Number.isFinite((s as { width: unknown }).width)
      || !Number.isFinite((s as { height: unknown }).height)) return false;
  }
  if (updates.renderedWidth !== undefined && !Number.isFinite(updates.renderedWidth)) return false;
  if (updates.renderedHeight !== undefined && !Number.isFinite(updates.renderedHeight)) return false;
  return true;
}

import type { Tile } from '../../schema/index';

interface NeighborSelectionInput {
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
  anchor: Tile;
  candidates: readonly Tile[];
  excludeIds: ReadonlySet<string>;
}

/**
 * Find the nearest neighboring tile in the given arrow-key direction,
 * relative to an anchor tile. Centre-to-centre distance with directional
 * filtering (the dominant axis must point in the requested direction).
 * Returns null when nothing qualifies.
 */
export function findNeighborTile(input: NeighborSelectionInput): Tile | null {
  const { key, anchor, candidates, excludeIds } = input;
  const ax = anchor.position.x + anchor.size.width / 2;
  const ay = anchor.position.y + anchor.size.height / 2;

  let best: Tile | null = null;
  let bestDist = Infinity;

  for (const t of candidates) {
    if (excludeIds.has(t.id)) continue;
    const tx = t.position.x + t.size.width / 2;
    const ty = t.position.y + t.size.height / 2;
    const dx = tx - ax;
    const dy = ty - ay;

    let valid = false;
    if (key === 'ArrowRight' && dx > 0 && Math.abs(dx) > Math.abs(dy)) valid = true;
    if (key === 'ArrowLeft' && dx < 0 && Math.abs(dx) > Math.abs(dy)) valid = true;
    if (key === 'ArrowDown' && dy > 0 && Math.abs(dy) > Math.abs(dx)) valid = true;
    if (key === 'ArrowUp' && dy < 0 && Math.abs(dy) > Math.abs(dx)) valid = true;

    if (valid) {
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    }
  }

  return best;
}

/** True when the focused element should keep arrow keys for its own use. */
export function isArrowConsumingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
}

/** Discriminate the four arrow keys. */
export function isArrowKey(key: string): key is NeighborSelectionInput['key'] {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
}

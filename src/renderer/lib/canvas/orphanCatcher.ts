import type { Tile, Connection } from '../../schema/index';

/**
 * Orphan Catcher — finds tiles that are stranded on the canvas:
 *   • text tiles whose content is completely empty
 *   • tiles with no connections, no tags, and whose nearest neighbour
 *     is more than `clusterDistance` board pixels away.
 *
 * Pure logic — no Svelte imports. Consumers pass the raw tiles/connections
 * map and the orphan IDs come back for rendering (outline pulse, list UI).
 */

export interface OrphanCatcherInput {
  tiles: Record<string, Tile>;
  connections: Record<string, Connection>;
  /** Board-space pixels — a tile is "far from any cluster" if its distance
   * to its nearest other tile exceeds this. Default 600. */
  clusterDistance?: number;
  /**
   * Resolves a text tile's real backing body so emptiness can be judged.
   *
   * A text tile does NOT carry its body on the tile object — `tile.content` is
   * hard-coded to `''` by `buildTileDefinition` (the body lives in the backing
   * `.md`, shown by its note model). Without this resolver, `isEmptyTextTile` would
   * read that empty field and flag EVERY text tile as empty.
   *
   * Returns the body string (Markdown or HTML), or `undefined` when the body
   * cannot be resolved. Absence is treated as NOT empty: a tile is only
   * classified `empty` when we can positively confirm its body is blank.
   * Keeping the resolver an injected parameter (rather than importing stores
   * here) preserves this module's purity for unit testing.
   */
  resolveTextBody?: (tile: Tile) => string | undefined;
}

export interface OrphanInfo {
  tileId: string;
  reason: 'empty' | 'isolated';
}

const DEFAULT_CLUSTER_DISTANCE = 600;

/**
 * Returns the shortest edge-to-edge distance between two axis-aligned
 * rectangles. Returns 0 if they overlap.
 */
function rectDistance(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)));
  return Math.sqrt(dx * dx + dy * dy);
}

function isEmptyTextTile(
  tile: Tile,
  resolveTextBody?: (tile: Tile) => string | undefined,
): boolean {
  if (tile.type !== 'text') return false;
  // The body lives in the backing .md (its note model), never on the tile
  // object (`tile.content` is always '' — see buildTileDefinition). Resolve
  // the real body; if it can't be resolved, the tile is NOT empty (absence ≠
  // empty).
  const body = resolveTextBody?.(tile);
  if (typeof body !== 'string') return false;
  const stripped = body
    .replace(/<[^>]+>/g, '')
    .replace(/\s|&nbsp;/g, '');
  return stripped.length === 0;
}

export function findOrphans(input: OrphanCatcherInput): OrphanInfo[] {
  const clusterDistance = input.clusterDistance ?? DEFAULT_CLUSTER_DISTANCE;
  const tiles = Object.values(input.tiles);
  if (tiles.length === 0) return [];

  const connectedIds = new Set<string>();
  for (const conn of Object.values(input.connections)) {
    connectedIds.add(conn.fromTileId);
    connectedIds.add(conn.toTileId);
  }

  const orphans: OrphanInfo[] = [];

  for (const tile of tiles) {
    if (isEmptyTextTile(tile, input.resolveTextBody)) {
      orphans.push({ tileId: tile.id, reason: 'empty' });
      continue;
    }

    if (connectedIds.has(tile.id)) continue;
    if ((tile.tags ?? []).length > 0) continue;

    const rect = {
      x: tile.position.x,
      y: tile.position.y,
      width: tile.size.width,
      height: tile.size.height,
    };

    let nearest = Infinity;
    for (const other of tiles) {
      if (other.id === tile.id) continue;
      const otherRect = {
        x: other.position.x,
        y: other.position.y,
        width: other.size.width,
        height: other.size.height,
      };
      const d = rectDistance(rect, otherRect);
      if (d < nearest) nearest = d;
      if (nearest <= clusterDistance) break;
    }

    if (nearest > clusterDistance) {
      orphans.push({ tileId: tile.id, reason: 'isolated' });
    }
  }

  return orphans;
}

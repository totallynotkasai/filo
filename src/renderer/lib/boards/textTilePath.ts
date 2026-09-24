import type { Tile } from '../../schema/index';

/**
 * A text tile's note path: its `filePath`, the note's only identity on a
 * board. Returns `null` for non-text tiles and for a text tile that hasn't
 * been placed yet (no path picked). The optional `boardId` is accepted for
 * call sites that thread a scope; the path no longer depends on the board.
 */
export function resolveTextTileVaultPath(tile: Tile, _boardId?: string): string | null {
  if (tile.type !== 'text') return null;
  return typeof tile.filePath === 'string' && tile.filePath.length > 0 ? tile.filePath : null;
}

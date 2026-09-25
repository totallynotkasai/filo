import type { DocumentBoard, Tile } from '../../schema/index';
import type { CacheContext, BoardFileData } from '../../stores/boardCacheTypes';
import type { AddTileOpts, BoardTileOps } from '../boardTileOps';

/**
 * Document board tile ops — exhaustive no-op. Document boards are a single
 * rich-text editor on the note at `board.filePath`; they have
 * no `tileDefs`, no placements, and no per-tile delete surface. The ops
 * exist purely so the `BoardType`-keyed registry is exhaustive and the
 * dispatcher's `never`-fallback can't be reached at runtime for a known
 * board type. Each call logs a console warning so unexpected invocations
 * are visible during development.
 */
export const documentTileOps: BoardTileOps<DocumentBoard> = {
  type: 'document',

  async addTile(
    _ctx: CacheContext,
    _cached: BoardFileData,
    boardId: string,
    tile: Tile,
    _opts?: AddTileOpts,
  ): Promise<void> {
    console.warn(
      `[boardTileOps.document] addTile is a no-op (board=${boardId}, tile=${tile.id}); document boards have no tile registry`,
    );
  },

  removeTile(
    _ctx: CacheContext,
    _cached: BoardFileData,
    boardId: string,
    tileId: string,
  ): void {
    console.warn(
      `[boardTileOps.document] removeTile is a no-op (board=${boardId}, tile=${tileId})`,
    );
  },

  updateTile(
    _ctx: CacheContext,
    _cached: BoardFileData,
    boardId: string,
    tileId: string,
    _updates: Partial<Tile>,
  ): void {
    console.warn(
      `[boardTileOps.document] updateTile is a no-op (board=${boardId}, tile=${tileId})`,
    );
  },

  getFullTiles(_cached: BoardFileData, _boardId: string): Record<string, Tile> {
    return {};
  },

  listPlacementIds(_cached: BoardFileData): string[] {
    return [];
  },
};

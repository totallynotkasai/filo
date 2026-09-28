/**
 * Seeds the board cache from runtime tiles, then points a board store at the
 * board: the setup many store and command tests share. Production code
 * hydrates the cache from a loaded board file (`boardCacheStore.hydrate`)
 * and calls `setBoard(board)`; this builds the file shape those tests would
 * otherwise have to spell out.
 *
 * Mind-map tiles split between `placements` / `inlineTiles` the way the live
 * `mindmapTileOps.addTile` writer does. Other board types only get
 * `tileDefs`: Kanban / Task List tests that need placements hydrate the cache
 * themselves. With no tiles, nothing is seeded (the cache entry stays).
 */
import type { Board, Connection, Frame, MindMapBoard, Tile, TileDefinition } from '../../renderer/schema/index';
import type { BoardFileData } from '../../renderer/lib/boards/boardSaver';
import { boardCacheStore } from '../../renderer/stores/boardCache.svelte';
import {
  buildInlineTileFromTile,
  buildTileDefinition,
  isInlineTileType,
} from '../../renderer/lib/boards/tileDefBuilder';

export function seedBoard(
  store: { setBoard(board: Board): void },
  board: Board,
  tiles?: Record<string, Tile>,
  connections?: Record<string, Connection>,
  frames?: Frame[],
): void {
  if (tiles && Object.keys(tiles).length > 0) {
    boardCacheStore.hydrate(
      { ...boardCacheStore.cache, [board.id]: synthesizeCacheEntry(board, tiles, connections, frames) },
      { ...boardCacheStore.paths, [board.id]: boardCacheStore.paths[board.id] ?? '' },
    );
  }
  store.setBoard(board);
}

function synthesizeCacheEntry(
  board: Board,
  tiles?: Record<string, Tile>,
  conns?: Record<string, Connection>,
  frames?: Frame[],
): BoardFileData {
  const tileDefs: Record<string, TileDefinition> = {};
  const placements: Record<
    string,
    { x: number; y: number; width: number; height: number; locked?: boolean; faded?: boolean; frameless?: boolean }
  > = {};
  const inlineTiles: Record<string, ReturnType<typeof buildInlineTileFromTile>> = {};
  const isMindMap = board.type === 'mindmap';

  for (const tile of Object.values(tiles ?? {})) {
    if (isMindMap && isInlineTileType(tile.type)) {
      inlineTiles[tile.id] = buildInlineTileFromTile(tile);
      continue;
    }
    tileDefs[tile.id] = buildTileDefinition(tile);
    if (isMindMap) {
      placements[tile.id] = {
        x: tile.position.x,
        y: tile.position.y,
        width: tile.size.width,
        height: tile.size.height,
        locked: tile.locked,
        faded: tile.faded,
        frameless: tile.frameless,
      };
    }
  }

  let boardForCache: Board = board;
  if (isMindMap) {
    const mm = board as MindMapBoard & Record<string, unknown>;
    boardForCache = {
      ...mm,
      placements: { ...(mm.placements ?? {}), ...placements },
      inlineTiles: { ...(mm.inlineTiles ?? {}), ...inlineTiles },
    } as MindMapBoard;
  }

  return {
    board: boardForCache,
    tileDefs,
    connections: { ...(conns ?? {}) },
    frames: [...(frames ?? [])],
  };
}

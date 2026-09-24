import type { Board, Tile } from '../schema/index';
import type { CacheContext, V7BoardFileData } from '../stores/boardCacheTypes';
import { mindmapTileOps } from './boardTileOps/mindmap';
import { kanbanTileOps } from './boardTileOps/kanban';
import { tasklistTileOps } from './boardTileOps/tasklist';
import { documentTileOps } from './boardTileOps/document';

/**
 * Optional flags for `BoardTileOps.addTile`. Today only `skipEmptySeed`
 * is honoured by the text-tile seed helper — cascade-delete undo passes
 * it so a missing backing file isn't silently materialised as an empty
 * document on restore. New flags should be additive and forward-compatible.
 */
export interface AddTileOpts {
  skipEmptySeed?: boolean;
}

/**
 * Strategy contract for "do tile X to a board of type B". Each board type
 * provides exactly one implementation; the registry below dispatches
 * `BoardType → Ops` so a future board type is a compile error until it
 * lands a registry entry (the mapped type forces exhaustiveness).
 *
 * Every dispatch goes through `opsFor(cached.board)`, so no board type's
 * placements are silently dropped by a MindMap-only sink; the per-type
 * implementations live under `core/boardTileOps/`.
 */
export interface BoardTileOps<B extends Board = Board> {
  /** Board type literal — matches `Board['type']` for the implementing variant. */
  readonly type: B['type'];

  /**
   * Persist the addition of a tile to a board's cache entry. May write the
   * tile's backing `.md` file (text tiles only, via the shared seed helper).
   * Does NOT insert per-board placement structures that need extra context
   * (Kanban column id, Task List section) — those callers route through
   * `persistAddKanbanPlacement` / `persistAddTaskPlacement` directly.
   */
  addTile(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    tile: Tile,
    opts?: AddTileOpts,
  ): Promise<void>;

  /**
   * Remove a tile (def + placement) from the board and sweep any connection
   * referencing it. Leaves the backing `.md` file untouched — the
   * "Delete file too" gesture lives in the UI layer.
   */
  removeTile(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    tileId: string,
  ): void;

  /**
   * Merge a partial tile update into the cache (definition fields and, for
   * MindMap, placement geometry + inline-tile properties). No backing-file
   * write.
   */
  updateTile(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    tileId: string,
    updates: Partial<Tile>,
  ): void;

  /**
   * Project the cache entry into a `Record<tileId, Tile>` shape the renderer
   * reads from. MindMap fuses `tileDefs` with `placements + inlineTiles`;
   * Kanban fuses `tileDefs` with column `tilePlacements`; Task List fuses
   * `tileDefs` with `tasks`; Document is always `{}`.
   */
  getFullTiles(cached: V7BoardFileData, boardId: string): Record<string, Tile>;

  /**
   * List every tileId that holds a placement on this board (the on-disk
   * `placements`/`inlineTiles`/`tilePlacements`/`tasks` keys, not the
   * `tileDefs` keys). Used by orphan-detection passes that need to compare
   * placement IDs against def IDs.
   */
  listPlacementIds(cached: V7BoardFileData): string[];
}

type OpsRegistry = {
  [K in Board['type']]: BoardTileOps<Extract<Board, { type: K }>>;
};

/**
 * Type-level exhaustive map of `BoardType → BoardTileOps`. Adding a new
 * board type to the `BoardSchema` discriminated union turns the index
 * signature here into a missing-property error until the new entry lands.
 */
export const boardTileOpsRegistry: OpsRegistry = {
  mindmap: mindmapTileOps,
  kanban: kanbanTileOps,
  tasklist: tasklistTileOps,
  document: documentTileOps,
};

/**
 * Resolve the ops implementation for a board. The cast to `BoardTileOps<Board>`
 * is necessary because TypeScript can't narrow the registry index back to
 * the concrete variant after the `board.type` lookup, but it is sound: the
 * registry is built with each entry typed against its discriminant.
 */
export function opsFor(board: Board): BoardTileOps<Board> {
  return boardTileOpsRegistry[board.type] as BoardTileOps<Board>;
}

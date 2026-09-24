import type { Board, Connection } from '../schema/index';
import type { CacheContext, V7BoardFileData } from '../stores/boardCacheTypes';

/**
 * Strategy contract for "mutate a connection on a board of type B". Each board
 * type provides exactly one implementation; the registry below dispatches
 * `BoardType → Ops` so a future board type is a compile error until it lands
 * a registry entry (the mapped type forces exhaustiveness).
 *
 * Mirrors the `boardTileOps` strategy pattern for the connection slice of
 * the cache. Today every
 * board type's body is identical (connections are conceptually mind-map-only
 * but the cache map exists on every `.board.json`); the registry gives the
 * mutators a typed home so a future per-type divergence (e.g. document boards
 * forbidding connections, or kanban boards routing through their own surface)
 * lands without touching the dispatcher slice.
 *
 * The per-type ops own both halves of the write: the per-board cache mutation
 * AND the project-mirror update that drives the active `connectionsStore`
 * derivation. Callers do NOT need to `tickAndPersist()` — the project mirror
 * is what the live store reads on the active board, regardless of which proxy
 * boundary the write started on. If a future refactor splits the project-side
 * and cache-side collections, every op below has to be revisited.
 */
export interface BoardConnectionsOps<B extends Board = Board> {
  /** Board type literal — matches `Board['type']` for the implementing variant. */
  readonly type: B['type'];

  /**
   * Insert a connection into the cache + project mirror. Caller has already
   * resolved + enriched the connection's `boardId` field; the op receives the
   * `boardId` separately so it doesn't have to re-derive ownership.
   */
  addConnection(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    conn: Connection,
  ): void;

  /**
   * Remove a connection from the cache + project mirror. Caller resolves the
   * owning `boardId` from either the connection object or a cache scan.
   */
  removeConnection(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    connId: string,
  ): void;

  /**
   * Replace a connection in the cache + project mirror. Caller has already
   * enriched the `boardId` field on the incoming object.
   */
  updateConnection(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    connId: string,
    updated: Connection,
  ): void;
}

/**
 * Shared cache+mirror body for every board type. Today the connection
 * vocabulary doesn't diverge between board types — kanban / tasklist /
 * document boards aren't *supposed* to host connections, but a hand-edited
 * or migrated file could in principle, so we honour the write rather than
 * silently dropping it. Each board type still gets a typed home for future
 * divergence.
 */
const sharedConnectionsBody = {
  addConnection(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    conn: Connection,
  ): void {
    cached.connections = { ...cached.connections, [conn.id]: conn };
    ctx.updateProjectConnectionsFrames(({ connections: projConns }) => {
      projConns[conn.id] = conn;
    });
    ctx.markDirty(boardId);
  },

  removeConnection(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    connId: string,
  ): void {
    const { [connId]: _removed, ...rest } = cached.connections;
    void _removed;
    cached.connections = rest;
    ctx.updateProjectConnectionsFrames(({ connections: projConns }) => {
      delete projConns[connId];
    });
    ctx.markDirty(boardId);
  },

  updateConnection(
    ctx: CacheContext,
    cached: V7BoardFileData,
    boardId: string,
    connId: string,
    updated: Connection,
  ): void {
    cached.connections = { ...cached.connections, [connId]: updated };
    ctx.updateProjectConnectionsFrames(({ connections: projConns }) => {
      projConns[connId] = updated;
    });
    ctx.markDirty(boardId);
  },
};

const mindmapConnectionsOps: BoardConnectionsOps<
  Extract<Board, { type: 'mindmap' }>
> = {
  type: 'mindmap',
  ...sharedConnectionsBody,
};

const kanbanConnectionsOps: BoardConnectionsOps<
  Extract<Board, { type: 'kanban' }>
> = {
  type: 'kanban',
  ...sharedConnectionsBody,
};

const tasklistConnectionsOps: BoardConnectionsOps<
  Extract<Board, { type: 'tasklist' }>
> = {
  type: 'tasklist',
  ...sharedConnectionsBody,
};

const documentConnectionsOps: BoardConnectionsOps<
  Extract<Board, { type: 'document' }>
> = {
  type: 'document',
  ...sharedConnectionsBody,
};

type OpsRegistry = {
  [K in Board['type']]: BoardConnectionsOps<Extract<Board, { type: K }>>;
};

/**
 * Type-level exhaustive map of `BoardType → BoardConnectionsOps`. Adding a
 * new board type to the `BoardSchema` discriminated union turns the index
 * signature here into a missing-property error until the new entry lands.
 */
export const boardConnectionsOpsRegistry: OpsRegistry = {
  mindmap: mindmapConnectionsOps,
  kanban: kanbanConnectionsOps,
  tasklist: tasklistConnectionsOps,
  document: documentConnectionsOps,
};

/**
 * Resolve the ops implementation for a board. The cast to
 * `BoardConnectionsOps<Board>` is necessary because TypeScript can't narrow
 * the registry index back to the concrete variant after the `board.type`
 * lookup, but it is sound: the registry is built with each entry typed
 * against its discriminant.
 */
export function connectionsOpsFor(board: Board): BoardConnectionsOps<Board> {
  return boardConnectionsOpsRegistry[board.type] as BoardConnectionsOps<Board>;
}

import type { Connection, Frame } from '../schema/index';
import { connectionsOpsFor } from '../core/boardConnectionsOps';
import { framesOpsFor } from '../core/boardFramesOps';
import type { CacheContext } from './boardCacheTypes';

/**
 * Cache slice — connection and frame CRUD on the per-board cache entry, the
 * one copy: it is what the board file is written from, and what the live
 * `boardStore.connections` / `frames` derive from on the active board.
 *
 * Every mutator dispatches to the
 * per-board-type implementation via `connectionsOpsFor(cached.board)` /
 * `framesOpsFor(cached.board)`. The strategy registries in
 * `core/boardConnectionsOps.ts` and `core/boardFramesOps.ts` are exhaustive
 * over `BoardType`, so adding a new board variant is a compile error in the
 * registry until per-type ops ship. This slice retains only the boardId
 * resolution (cache scan + warn-and-drop fallbacks) and the cache lookup
 * before dispatching — the actual mutation body lives in the per-type ops.
 */
export function makeConnectionsFramesSlice(ctx: CacheContext) {
  function resolveConnectionBoardId(
    conn: Connection,
    connId: string,
    fallbackToTiles: boolean,
  ): string {
    const explicit = (conn as Connection & { boardId?: string }).boardId ?? '';
    if (explicit) return explicit;
    if (fallbackToTiles) {
      return (
        ctx.findBoardIdForTile(conn.fromTileId)
        || ctx.findBoardIdForTile(conn.toTileId)
        || ''
      );
    }
    return ctx.findBoardIdForConnection(connId) ?? '';
  }

  function resolveFrameBoardId(frame: Frame, frameId: string): string {
    const explicit = (frame as Frame & { boardId?: string }).boardId ?? '';
    return explicit || ctx.findBoardIdForFrame(frameId) || '';
  }

  return {
    persistAddConnection(conn: Connection): void {
      const resolved = resolveConnectionBoardId(conn, conn.id, true);
      if (!resolved) {
        ctx.warnUnresolved('persistAddConnection', `connection ${conn.id}`);
        return;
      }
      const cached = ctx.getCache()[resolved];
      if (!cached) return;
      const explicit = (conn as Connection & { boardId?: string }).boardId ?? '';
      const enriched: Connection = explicit
        ? conn
        : ({ ...conn, boardId: resolved } as Connection);
      connectionsOpsFor(cached.board).addConnection(ctx, cached, resolved, enriched);
    },

    persistRemoveConnection(connId: string, conn: Connection): void {
      const resolved = resolveConnectionBoardId(conn, connId, false);
      if (!resolved) {
        ctx.warnUnresolved('persistRemoveConnection', `connection ${connId}`);
        return;
      }
      const cached = ctx.getCache()[resolved];
      if (!cached) return;
      connectionsOpsFor(cached.board).removeConnection(ctx, cached, resolved, connId);
    },

    persistUpdateConnection(connId: string, updated: Connection): void {
      const resolved = resolveConnectionBoardId(updated, connId, false);
      if (!resolved) {
        ctx.warnUnresolved('persistUpdateConnection', `connection ${connId}`);
        return;
      }
      const cached = ctx.getCache()[resolved];
      if (!cached) return;
      const explicit = (updated as Connection & { boardId?: string }).boardId ?? '';
      const enriched: Connection = explicit
        ? updated
        : ({ ...updated, boardId: resolved } as Connection);
      connectionsOpsFor(cached.board).updateConnection(ctx, cached, resolved, connId, enriched);
    },

    persistAddFrame(frame: Frame): void {
      const resolved = resolveFrameBoardId(frame, frame.id);
      if (!resolved) {
        ctx.warnUnresolved('persistAddFrame', `frame ${frame.id}`);
        return;
      }
      const cached = ctx.getCache()[resolved];
      if (!cached) return;
      const explicit = (frame as Frame & { boardId?: string }).boardId ?? '';
      const enriched: Frame = explicit
        ? frame
        : ({ ...frame, boardId: resolved } as Frame);
      framesOpsFor(cached.board).addFrame(ctx, cached, resolved, enriched);
    },

    persistRemoveFrame(frameId: string, frame: Frame): void {
      const resolved = resolveFrameBoardId(frame, frameId);
      if (!resolved) {
        ctx.warnUnresolved('persistRemoveFrame', `frame ${frameId}`);
        return;
      }
      const cached = ctx.getCache()[resolved];
      if (!cached) return;
      framesOpsFor(cached.board).removeFrame(ctx, cached, resolved, frameId);
    },

    persistUpdateFrame(frameId: string, updated: Frame): void {
      const resolved = resolveFrameBoardId(updated, frameId);
      if (!resolved) {
        ctx.warnUnresolved('persistUpdateFrame', `frame ${frameId}`);
        return;
      }
      const cached = ctx.getCache()[resolved];
      if (!cached) return;
      const explicit = (updated as Frame & { boardId?: string }).boardId ?? '';
      const enriched: Frame = explicit
        ? updated
        : ({ ...updated, boardId: resolved } as Frame);
      framesOpsFor(cached.board).updateFrame(ctx, cached, resolved, frameId, enriched);
    },
  };
}

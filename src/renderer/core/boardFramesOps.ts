import type { Board, Frame } from '../schema/index';
import type { CacheContext, BoardFileData } from '../stores/boardCacheTypes';

/**
 * Strategy contract for "mutate a frame on a board of type B". Each board
 * type provides exactly one implementation; the registry below dispatches
 * `BoardType → Ops` so a future board type is a compile error until it lands
 * a registry entry (the mapped type forces exhaustiveness).
 *
 * Mirrors the `boardTileOps` strategy pattern for the frames slice of the
 * cache. Frames are a
 * canvas affordance conceptually owned by mind-map boards, but every
 * `.board.json` carries a `frames: Frame[]` field for forward-compat, so the
 * mutators have to be valid for every board type. The strategy registry gives
 * each type a typed home for future divergence without forcing all four to
 * share the same implementation file.
 *
 * Like the connections ops, every op owns both halves of the write: the
 * per-board cache mutation AND the project-mirror update that drives the
 * active `framesStore` derivation. Callers do NOT need to `tickAndPersist()`
 * — the project mirror is what the live store reads on the active board,
 * regardless of which proxy boundary the write started on.
 */
export interface BoardFramesOps<B extends Board = Board> {
  /** Board type literal — matches `Board['type']` for the implementing variant. */
  readonly type: B['type'];

  /**
   * Append a frame to the cache + project mirror. Caller has already enriched
   * the frame's `boardId` field.
   */
  addFrame(
    ctx: CacheContext,
    cached: BoardFileData,
    boardId: string,
    frame: Frame,
  ): void;

  /**
   * Remove a frame by id from the cache + project mirror. The cache write
   * filters the frames array; the project mirror splices in place.
   */
  removeFrame(
    ctx: CacheContext,
    cached: BoardFileData,
    boardId: string,
    frameId: string,
  ): void;

  /**
   * Replace a frame in the cache + project mirror. Caller has already
   * enriched the `boardId` field on the incoming object.
   */
  updateFrame(
    ctx: CacheContext,
    cached: BoardFileData,
    boardId: string,
    frameId: string,
    updated: Frame,
  ): void;
}

/**
 * Shared cache+mirror body for every board type. Today the frame vocabulary
 * doesn't diverge between board types — frames render only on mind-map
 * boards, but their on-disk shape is universal and the cache map is
 * universally writable. Each board type still gets a typed home for future
 * divergence.
 */
const sharedFramesBody = {
  addFrame(
    ctx: CacheContext,
    cached: BoardFileData,
    boardId: string,
    frame: Frame,
  ): void {
    cached.frames = [...cached.frames, frame];
    ctx.updateProjectConnectionsFrames(({ frames: projFrames }) => {
      projFrames.push(frame);
    });
    ctx.markDirty(boardId);
  },

  removeFrame(
    ctx: CacheContext,
    cached: BoardFileData,
    boardId: string,
    frameId: string,
  ): void {
    cached.frames = cached.frames.filter((f) => f.id !== frameId);
    ctx.updateProjectConnectionsFrames(({ frames: projFrames }) => {
      const idx = projFrames.findIndex((f) => f.id === frameId);
      if (idx >= 0) projFrames.splice(idx, 1);
    });
    ctx.markDirty(boardId);
  },

  updateFrame(
    ctx: CacheContext,
    cached: BoardFileData,
    boardId: string,
    frameId: string,
    updated: Frame,
  ): void {
    cached.frames = cached.frames.map((f) => (f.id === frameId ? updated : f));
    ctx.updateProjectConnectionsFrames(({ frames: projFrames }) => {
      const idx = projFrames.findIndex((f) => f.id === frameId);
      if (idx >= 0) projFrames[idx] = updated;
    });
    ctx.markDirty(boardId);
  },
};

const mindmapFramesOps: BoardFramesOps<Extract<Board, { type: 'mindmap' }>> = {
  type: 'mindmap',
  ...sharedFramesBody,
};

const kanbanFramesOps: BoardFramesOps<Extract<Board, { type: 'kanban' }>> = {
  type: 'kanban',
  ...sharedFramesBody,
};

const tasklistFramesOps: BoardFramesOps<Extract<Board, { type: 'tasklist' }>> = {
  type: 'tasklist',
  ...sharedFramesBody,
};

const documentFramesOps: BoardFramesOps<Extract<Board, { type: 'document' }>> = {
  type: 'document',
  ...sharedFramesBody,
};

type OpsRegistry = {
  [K in Board['type']]: BoardFramesOps<Extract<Board, { type: K }>>;
};

/**
 * Type-level exhaustive map of `BoardType → BoardFramesOps`. Adding a new
 * board type to the `BoardSchema` discriminated union turns the index
 * signature here into a missing-property error until the new entry lands.
 */
export const boardFramesOpsRegistry: OpsRegistry = {
  mindmap: mindmapFramesOps,
  kanban: kanbanFramesOps,
  tasklist: tasklistFramesOps,
  document: documentFramesOps,
};

/**
 * Resolve the ops implementation for a board. The cast to
 * `BoardFramesOps<Board>` is necessary because TypeScript can't narrow the
 * registry index back to the concrete variant after the `board.type` lookup,
 * but it is sound: the registry is built with each entry typed against its
 * discriminant.
 */
export function framesOpsFor(board: Board): BoardFramesOps<Board> {
  return boardFramesOpsRegistry[board.type] as BoardFramesOps<Board>;
}

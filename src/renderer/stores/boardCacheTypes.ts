import type { V7BoardFileData } from '../lib/boards/boardSaver';
import type { Connection, Frame, KanbanBoard, TaskListBoard } from '../schema/index';

export type { V7BoardFileData };

/**
 * Closure handed to each cache slice so it can mutate cache state, schedule
 * writes, and resolve owning-board IDs without holding its own `$state` proxy
 * (single source of truth lives in `boardCache.svelte.ts`).
 */
export interface CacheContext {
  getCache(): Record<string, V7BoardFileData>;
  setCache(next: Record<string, V7BoardFileData>): void;
  markDirty(boardId: string): void;
  touchBoard(boardId: string): void;
  updateEntry(boardId: string, updates: Partial<V7BoardFileData>): void;
  findBoardIdForTile(tileId: string): string | null;
  findBoardIdForConnection(connId: string): string | null;
  findBoardIdForFrame(frameId: string): string | null;
  findBoardIdForKanbanColumn(columnId: string): string | null;
  findBoardIdForTask(tileId: string): string | null;
  warnUnresolved(kind: string, id: string): void;
  kanbanBoardOrWarn(boardId: string, method: string): KanbanBoard | null;
  tasklistBoardOrWarn(boardId: string, method: string): TaskListBoard | null;
  updateProjectConnectionsFrames(
    mutator: (project: { connections: Record<string, Connection>; frames: Frame[] }) => void,
  ): void;
}

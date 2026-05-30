import type { Frame } from '../schema/index';
import { FrameSchema } from '../schema/index';
import { boardCacheStore } from './boardCache.svelte';
import type { BoardContext } from './boardStoreTypes';

/**
 * Board slice — frame CRUD for the active board.
 *
 * Phase R7 (Reactive BoardScope, 2026-05-26) — the per-pane `frames` view is
 * `$derived` from `boardCacheStore.cache[currentBoardId].frames`. Mutations
 * forward to `boardCacheStore.persist*Frame`; the active derivation re-fires
 * automatically when the cache settles.
 */
export function makeFramesSlice(ctx: BoardContext) {
  return {
    addFrame(frame: Frame): void {
      // Mirror addTile's stamping. Frame creation in MindMapBoard reads
      // boardStore.current?.id ?? '' — if the read happens during a tab
      // transition, the empty string would silent-drop in persistAddFrame.
      const current = ctx.getCurrent();
      const stamped: Frame = frame.boardId
        ? frame
        : ({ ...frame, boardId: current?.id ?? '' } as Frame);
      boardCacheStore.persistAddFrame(stamped);
    },

    persistAddFrame(frame: Frame): void {
      boardCacheStore.persistAddFrame(frame);
    },

    removeFrame(frameId: string): void {
      const existing = ctx.getFrames().find((f) => f.id === frameId);
      if (existing) boardCacheStore.persistRemoveFrame(frameId, existing);
    },

    persistRemoveFrame(frameId: string, frame: Frame): void {
      boardCacheStore.persistRemoveFrame(frameId, frame);
    },

    updateFrame(frameId: string, updates: Partial<Frame>): void {
      const existing = ctx.getFrames().find((f) => f.id === frameId);
      if (!existing) return;
      const merged = { ...existing, ...updates, updatedAt: Date.now() } as Frame;
      const parsed = FrameSchema.safeParse(merged);
      if (!parsed.success) {
        console.warn('[boardStore] updateFrame validation failed:', parsed.error.issues);
      }
      const valid = parsed.success ? (parsed.data as Frame) : merged;
      boardCacheStore.persistUpdateFrame(frameId, valid);
    },

    persistUpdateFrame(frameId: string, frame: Frame): void {
      boardCacheStore.persistUpdateFrame(frameId, frame);
    },
  };
}

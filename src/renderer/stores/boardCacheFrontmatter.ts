import {
  propagateRenameAcrossBoards,
  findTilesToCascadeDelete,
  type CoverImageClear,
  type ColumnCoverImageClear,
  type FrameBackgroundClear,
  type BoardSettingsBackgroundClear,
} from '../lib/vault/fileRefIntegrity';
import type { CacheContext } from './boardCacheTypes';

/**
 * Cache slice — file-reference changes that arrive from outside a board:
 * a vault rename rewrites every path field that pointed at the old path, and
 * a delete plans which tiles and style references go with the file. Wraps
 * the pure helpers in `lib/vault/fileRefIntegrity`.
 *
 * A note's title, tags and fields are not here: boards don't copy them, so
 * a change to a note needs no board update.
 *
 * Every mutator calls `ctx.setCache({ ...cache })` after a structural change,
 * which forces a new cache-map identity for the `$state` consumers.
 */

export interface CascadeStyleClears {
  /** boardId → list of placement coverImage clears to apply / undo. */
  coverImage: Record<string, CoverImageClear[]>;
  /**
   * boardId → list of column-level coverImage clears (the column header
   * band's own cover, distinct from placement cards' covers).
   */
  columnCoverImage: Record<string, ColumnCoverImageClear[]>;
  /** boardId → list of frame.style.backgroundImage clears. */
  frameBackground: Record<string, FrameBackgroundClear[]>;
  /** boardId → list of board.settings.* background-image clears. */
  boardSettings: Record<string, BoardSettingsBackgroundClear[]>;
}

export interface CascadeDeleteTargets {
  byBoard: Record<string, string[]>;
  tileIds: string[];
  styleClears: CascadeStyleClears;
}

export function makeFrontmatterSlice(ctx: CacheContext) {
  return {
    propagateRename(oldRelPath: string, newRelPath: string): string[] {
      const cache = ctx.getCache();
      const { changedBoardIds } = propagateRenameAcrossBoards(cache, oldRelPath, newRelPath);
      if (changedBoardIds.length === 0) return [];
      ctx.setCache({ ...cache });
      for (const boardId of changedBoardIds) ctx.markDirty(boardId);
      return changedBoardIds;
    },

    /**
     * Pure scan. Returns the cascade-delete plan along with the style-clear
     * info, leaving the cache untouched. The caller calls
     * `applyCascadeStyleClears` to mutate the cache and snapshots
     * `styleClears` into the CascadeDeleteCommand so Ctrl+Z can restore the
     * cleared cover images / frame backgrounds too.
     */
    findCascadeDeleteTargets(deletedRelPath: string): CascadeDeleteTargets {
      const cache = ctx.getCache();
      const result = findTilesToCascadeDelete(cache, deletedRelPath);
      const tileIds: string[] = [];
      for (const ids of Object.values(result.byBoard)) tileIds.push(...ids);

      return {
        byBoard: result.byBoard,
        tileIds,
        styleClears: {
          coverImage: result.coverImageClears,
          columnCoverImage: result.columnCoverImageClears,
          frameBackground: result.frameBackgroundClears,
          boardSettings: result.boardSettingsClears,
        },
      };
    },

    /**
     * Applies the style-clear plan returned by
     * `findCascadeDeleteTargets`. Caller is responsible for snapshotting the clears BEFORE calling so an undo
     * command can replay them.
     *
     * Each loop guards against cache drift between scan and apply by
     * re-checking that the on-cache value still matches the recorded
     * `matchedPath`. If it doesn't (another writer changed the value in
     * the interval), the clear is skipped.
     */
    applyCascadeStyleClears(styleClears: CascadeStyleClears): void {
      const cache = ctx.getCache();
      let mutatedAny = false;

      // Kanban placement.coverImage clears.
      for (const [boardId, clears] of Object.entries(styleClears.coverImage)) {
        const cached = cache[boardId];
        if (!cached || cached.board.type !== 'kanban') continue;
        let mutated = false;
        for (const col of cached.board.columns ?? []) {
          for (const placement of col.tilePlacements ?? []) {
            const hit = clears.find(
              (c) => c.columnId === col.id && c.tileId === placement.tileId,
            );
            if (!hit) continue;
            if (placement.coverImage !== hit.matchedPath) continue;
            delete (placement as Record<string, unknown>).coverImage;
            mutated = true;
          }
        }
        if (mutated) {
          ctx.markDirty(boardId);
          mutatedAny = true;
        }
      }

      // Kanban column.coverImage clears. Same drift
      // guard as the placement-level loop above. Defensive `?? {}` for
      // legacy callers that hand-build a CascadeStyleClears without the
      // new column slice (older test fixtures, etc.).
      for (const [boardId, clears] of Object.entries(styleClears.columnCoverImage ?? {})) {
        const cached = cache[boardId];
        if (!cached || cached.board.type !== 'kanban') continue;
        let mutated = false;
        for (const col of cached.board.columns ?? []) {
          const hit = clears.find((c) => c.columnId === col.id);
          if (!hit) continue;
          const current = (col as { coverImage?: unknown }).coverImage;
          if (current !== hit.matchedPath) continue;
          delete (col as Record<string, unknown>).coverImage;
          mutated = true;
        }
        if (mutated) {
          ctx.markDirty(boardId);
          mutatedAny = true;
        }
      }

      // frame.style.backgroundImage clears.
      for (const [boardId, clears] of Object.entries(styleClears.frameBackground)) {
        const cached = cache[boardId];
        if (!cached) continue;
        let mutated = false;
        for (const frame of cached.frames ?? []) {
          const hit = clears.find((c) => c.frameId === frame.id);
          if (!hit) continue;
          const style = (frame as { style?: Record<string, unknown> }).style;
          if (!style || style.backgroundImage !== hit.matchedPath) continue;
          style.backgroundImage = '';
          mutated = true;
        }
        if (mutated) {
          ctx.markDirty(boardId);
          mutatedAny = true;
        }
      }

      // board.settings.defaults.frame.backgroundImage clears (mindmap only).
      for (const [boardId, clears] of Object.entries(styleClears.boardSettings)) {
        const cached = cache[boardId];
        if (!cached || cached.board.type !== 'mindmap') continue;
        let mutated = false;
        for (const clear of clears) {
          if (clear.path === 'defaults.frame.backgroundImage') {
            const settings = cached.board.settings as { defaults?: { frame?: Record<string, unknown> } } | undefined;
            const frameDefaults = settings?.defaults?.frame;
            if (frameDefaults && frameDefaults.backgroundImage === clear.matchedPath) {
              delete frameDefaults.backgroundImage;
              mutated = true;
            }
          }
        }
        if (mutated) {
          ctx.markDirty(boardId);
          mutatedAny = true;
        }
      }

      if (mutatedAny) ctx.setCache({ ...cache });
    },

    /**
     * Restores a style-clear plan (used by CascadeDeleteCommand.undo):
     * writes each matchedPath back into the placements/frames/settings the
     * original clear wiped. Idempotent.
     *
     * Manual-edit guard: a field holding any non-empty value other than the
     * original matchedPath is skipped, so undo never tramples a file the user
     * re-pointed to between cascade-delete and undo. Empty/absent values are
     * restored (the common case).
     */
    restoreCascadeStyleClears(styleClears: CascadeStyleClears): void {
      const cache = ctx.getCache();
      let mutatedAny = false;

      for (const [boardId, clears] of Object.entries(styleClears.coverImage)) {
        const cached = cache[boardId];
        if (!cached || cached.board.type !== 'kanban') continue;
        let mutated = false;
        for (const col of cached.board.columns ?? []) {
          for (const placement of col.tilePlacements ?? []) {
            const hit = clears.find(
              (c) => c.columnId === col.id && c.tileId === placement.tileId,
            );
            if (!hit) continue;
            const current = placement.coverImage;
            if (current && current !== hit.matchedPath) {
              console.debug(
                `[restoreCascadeStyleClears] skip coverImage on ${boardId}/${col.id}/${placement.tileId}: manual override (${current}) differs from snapshot (${hit.matchedPath})`,
              );
              continue;
            }
            if (current === hit.matchedPath) continue;
            (placement as Record<string, unknown>).coverImage = hit.matchedPath;
            mutated = true;
          }
        }
        if (mutated) {
          ctx.markDirty(boardId);
          mutatedAny = true;
        }
      }

      // Column-level coverImage restore. Same
      // manual-edit guard as the placement-level loop above. Defensive
      // `?? {}` (see applyCascadeStyleClears for rationale).
      for (const [boardId, clears] of Object.entries(styleClears.columnCoverImage ?? {})) {
        const cached = cache[boardId];
        if (!cached || cached.board.type !== 'kanban') continue;
        let mutated = false;
        for (const col of cached.board.columns ?? []) {
          const hit = clears.find((c) => c.columnId === col.id);
          if (!hit) continue;
          const current = (col as { coverImage?: unknown }).coverImage as string | undefined;
          if (current && current !== hit.matchedPath) {
            console.debug(
              `[restoreCascadeStyleClears] skip column coverImage on ${boardId}/${col.id}: manual override (${current}) differs from snapshot (${hit.matchedPath})`,
            );
            continue;
          }
          if (current === hit.matchedPath) continue;
          (col as Record<string, unknown>).coverImage = hit.matchedPath;
          mutated = true;
        }
        if (mutated) {
          ctx.markDirty(boardId);
          mutatedAny = true;
        }
      }

      for (const [boardId, clears] of Object.entries(styleClears.frameBackground)) {
        const cached = cache[boardId];
        if (!cached) continue;
        let mutated = false;
        for (const frame of cached.frames ?? []) {
          const hit = clears.find((c) => c.frameId === frame.id);
          if (!hit) continue;
          const style = (frame as { style?: Record<string, unknown> }).style ?? {};
          const current = style.backgroundImage as string | undefined;
          if (current && current !== hit.matchedPath) {
            console.debug(
              `[restoreCascadeStyleClears] skip frame.style.backgroundImage on ${boardId}/${frame.id}: manual override (${current}) differs from snapshot (${hit.matchedPath})`,
            );
            continue;
          }
          if (current === hit.matchedPath) continue;
          style.backgroundImage = hit.matchedPath;
          (frame as { style?: Record<string, unknown> }).style = style;
          mutated = true;
        }
        if (mutated) {
          ctx.markDirty(boardId);
          mutatedAny = true;
        }
      }

      for (const [boardId, clears] of Object.entries(styleClears.boardSettings)) {
        const cached = cache[boardId];
        if (!cached || cached.board.type !== 'mindmap') continue;
        let mutated = false;
        for (const clear of clears) {
          if (clear.path === 'defaults.frame.backgroundImage') {
            const settings = (cached.board.settings ?? {}) as { defaults?: { frame?: Record<string, unknown> } };
            const frameDefaults = (settings.defaults?.frame ?? {}) as Record<string, unknown>;
            const current = frameDefaults.backgroundImage as string | undefined;
            if (current && current !== clear.matchedPath) {
              console.debug(
                `[restoreCascadeStyleClears] skip defaults.frame.backgroundImage on ${boardId}: manual override (${current}) differs from snapshot (${clear.matchedPath})`,
              );
              continue;
            }
            if (current === clear.matchedPath) continue;
            frameDefaults.backgroundImage = clear.matchedPath;
            settings.defaults = { ...(settings.defaults ?? {}), frame: frameDefaults };
            cached.board.settings = settings as typeof cached.board.settings;
            mutated = true;
          }
        }
        if (mutated) {
          ctx.markDirty(boardId);
          mutatedAny = true;
        }
      }

      if (mutatedAny) ctx.setCache({ ...cache });
    },
  };
}

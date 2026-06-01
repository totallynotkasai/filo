import { reconcileBoardCacheWithFrontmatter } from '../lib/vault/frontmatterSync';
import {
  propagateRenameAcrossBoards,
  propagateMarkdownRenameToTextTiles,
  findTilesToCascadeDelete,
  type CoverImageClear,
  type ColumnCoverImageClear,
  type FrameBackgroundClear,
  type BoardSettingsBackgroundClear,
} from '../lib/vault/fileRefIntegrity';
import type { FileMetadata } from '../lib/vault/vaultIndex';
import type { CacheContext } from './boardCacheTypes';
import { vaultSwapResettable } from '../core/vaultLifecycle';

/**
 * 6.2.H9 — per-md mtime check so the on-open batch reconcile can skip
 * files whose disk frontmatter hasn't changed since we last reconciled
 * against them. Cleared on vault swap so the new vault's first reconcile
 * walks every md exactly once.
 *
 * Map<relPath, lastModifiedMs>.
 */
// allow-module-state: reset on vault swap via vaultSwapResettable below
const lastReconciledMtime = new Map<string, number>();
vaultSwapResettable('boardCacheFrontmatter.lastReconciledMtime', () => {
  lastReconciledMtime.clear();
});

/**
 * 6.2.H9 — test-only reset for the mtime gate. Production code drives the
 * reset via the vault-swap dispatch; tests don't fire that for every
 * `beforeEach`, so we expose a direct hook to keep test isolation simple.
 */
export function __resetLastReconciledMtimeForTests(): void {
  lastReconciledMtime.clear();
}

/**
 * 6.2.H9 — batches every ~50 reconciled mds before yielding to the event
 * loop. The microtask checkpoint lets queued watcher events and UI
 * reactivity interleave with a long batch reconcile on vault open.
 */
const RECONCILE_BATCH_YIELD_EVERY = 50;

/**
 * Cache slice — external-edit reconciliation. Wraps the pure helpers in
 * `lib/vault/frontmatterSync` and `lib/vault/fileRefIntegrity` so that every
 * code path that ingests an external change (file watcher, vault rename,
 * cascade delete) flows through one place.
 *
 * Active-proxy reactivity contract (Phase 1.1 / 2.2 sweep)
 * --------------------------------------------------------
 * Every mutator in this file calls `ctx.setCache({ ...cache })` after a
 * structural change, which forces a NEW cache-map identity. That re-fires
 * any `$state` consumer that subscribes to the cache map (the
 * `boardCacheStore.cache` getter). Active-board derivations on Kanban /
 * Task List that read through `boardStore.current` still need a tick to
 * propagate the change to the active proxy — but the only callers in this
 * file are the watcher / external-rename / cascade-delete paths, which
 * trigger a full board reload through `boardCacheStore.replaceCache` (or
 * an equivalent) rather than relying on per-mutator reactivity.
 *
 * Callers therefore do NOT invoke `tickAndPersist()` after these mutators;
 * the board host re-mounts (or the active board re-loads from the cache
 * directly) once the watcher event resolves.
 */

export interface CascadeStyleClears {
  /** boardId → list of placement coverImage clears to apply / undo. */
  coverImage: Record<string, CoverImageClear[]>;
  /**
   * Sprint C / C23 — boardId → list of column-level coverImage clears.
   * Sibling to `coverImage`; applies to the column header band's own
   * cover (distinct from placement cards' covers).
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
    applyFrontmatterToBackedTiles(relPath: string, metadata: FileMetadata): string[] {
      const cache = ctx.getCache();
      const result = reconcileBoardCacheWithFrontmatter(cache, relPath, metadata);
      if (result.changedBoardIds.length === 0) return [];
      ctx.setCache({ ...cache });
      for (const boardId of result.changedBoardIds) ctx.markDirty(boardId);
      // 6.2.H9 — stamp lastReconciledMtime so the on-open batch reconcile
      // skips this md until its disk mtime moves again.
      lastReconciledMtime.set(relPath, metadata.lastModified);
      return result.changedBoardIds;
    },

    /**
     * 6.2.H9 — batched, chunked, mtime-gated, no-updatedAt-stamp variant
     * of `applyFrontmatterToBackedTiles` for the on-open reconcile pass.
     * The pre-fix on-open loop did one `setCache({ ...cache })` PER md
     * file — O(M) cache identity flips that thrashed the Svelte reactive
     * graph on a vault with thousands of `.md` files. This variant:
     *
     *   (a) suppresses the `updatedAt = Date.now()` stamp on reconciled
     *       tiles (the reconcile isn't a user edit; the disk frontmatter
     *       was the canonical source we synced TO).
     *   (b) batches the cache identity flip — exactly one `setCache` at
     *       the end, regardless of how many mds drove changes.
     *   (c) yields to the event loop every `RECONCILE_BATCH_YIELD_EVERY`
     *       md files so watcher events / UI reactivity can interleave.
     *   (d) skips mds whose `lastModified` hasn't moved since the last
     *       reconcile (the lastReconciledMtime gate).
     *
     * Returns the union of changed board ids so the caller can log.
     */
    async applyFrontmatterToBackedTilesBatch(
      metadataList: FileMetadata[],
    ): Promise<string[]> {
      const cache = ctx.getCache();
      const changedBoardIds = new Set<string>();
      for (let i = 0; i < metadataList.length; i++) {
        const md = metadataList[i];
        // (d) skip when we already reconciled this exact disk state.
        const lastMtime = lastReconciledMtime.get(md.path);
        if (lastMtime !== undefined && md.lastModified <= lastMtime) {
          continue;
        }
        // (a) suppress the updatedAt stamp.
        const result = reconcileBoardCacheWithFrontmatter(
          cache,
          md.path,
          md,
          { stampUpdatedAt: false },
        );
        for (const id of result.changedBoardIds) changedBoardIds.add(id);
        lastReconciledMtime.set(md.path, md.lastModified);
        // (c) microtask yield every N iterations.
        if (i > 0 && i % RECONCILE_BATCH_YIELD_EVERY === 0) {
          await new Promise<void>((r) => queueMicrotask(() => r()));
        }
      }
      // (b) one setCache identity flip + one markDirty per changed board.
      if (changedBoardIds.size > 0) {
        ctx.setCache({ ...cache });
        for (const id of changedBoardIds) ctx.markDirty(id);
      }
      return Array.from(changedBoardIds);
    },

    propagateRename(oldRelPath: string, newRelPath: string): string[] {
      const cache = ctx.getCache();
      const refs = propagateRenameAcrossBoards(cache, oldRelPath, newRelPath);
      const opts = ctx.collectFolderPinOptions();
      const titles = propagateMarkdownRenameToTextTiles(
        cache,
        oldRelPath,
        newRelPath,
        opts,
      );
      const changed = new Set([...refs.changedBoardIds, ...titles.changedBoardIds]);
      if (changed.size === 0) return [];
      ctx.setCache({ ...cache });
      for (const boardId of changed) ctx.markDirty(boardId);
      return Array.from(changed);
    },

    /**
     * Sprint 35.2 — pure scan. Returns the cascade-delete plan along with
     * the style-clear info, leaving the cache untouched. The caller is
     * expected to call `applyCascadeStyleClears` to mutate the cache and
     * to snapshot `styleClears` into the resulting CascadeDeleteCommand so
     * Ctrl+Z can replay the clears in reverse.
     *
     * Previously this method mutated the cache inline, which meant the
     * resulting CascadeDeleteCommand only knew about removed tiles — the
     * cleared cover images / frame backgrounds / per-board frame defaults
     * stayed wiped after undo, and the next debounce persisted the loss.
     */
    findCascadeDeleteTargets(deletedRelPath: string): CascadeDeleteTargets {
      const cache = ctx.getCache();
      const result = findTilesToCascadeDelete(
        cache,
        deletedRelPath,
        ctx.collectFolderPinOptions(),
      );
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
     * Sprint 35.2 — applies the style-clear plan returned by
     * `findCascadeDeleteTargets`. Mirrors the per-bucket loops that used
     * to live inline inside `findCascadeDeleteTargets`. Caller is
     * responsible for snapshotting the clears BEFORE calling so an undo
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

      // Sprint C / C23 — Kanban column.coverImage clears. Same drift
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
     * Sprint 35.2 — restores a style-clear plan (used by
     * CascadeDeleteCommand.undo). Re-applies the matched paths into the
     * placements/frames/settings the original clear wiped.
     *
     * Mirrors `applyCascadeStyleClears` shape but in reverse: writes the
     * matchedPath back instead of deleting. Each loop is idempotent — if
     * the field already holds the value (e.g. the user manually restored
     * it via paste / edit between cascade and undo), it stays put.
     *
     * Polish phase 3.2 (2026-05-25) — manual-edit guard. Originally the
     * skip condition was `value === matchedPath` (i.e. only skip when the
     * field already holds the value we'd write). That meant if the user
     * manually re-pointed coverImage / backgroundImage to a DIFFERENT file
     * between cascade-delete and undo, undo would trample their pick. The
     * corrected guard skips when the field holds *any* non-empty value
     * other than the original matchedPath. An empty/absent value still
     * gets restored — that's the common case (cascade-delete wiped it).
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

      // Sprint C / C23 — column-level coverImage restore. Same
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

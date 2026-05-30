import type { Tile } from '../schema/index';
import { TileSchema } from '../schema/index';
import { boardCacheStore } from './boardCache.svelte';
import { vaultStore } from './vault.svelte';
import { documentStore } from './document.svelte';
import { uiStore } from './ui.svelte';
import { isGeometryOnlyUpdate } from '../lib/utils/tileUpdateFastPath';
import { normalizePath } from '../lib/utils/path';
import { resolveTextTileVaultPath, replaceTitleInVaultPath } from '../lib/boards/textTilePath';
import type { BoardContext } from './boardStoreTypes';

/**
 * Phase 5 / 5.6 — return shape of `renameTextTileBackingFile`. When the
 * rename touched the backing `.md` file, `oldPath` and `newPath` are set
 * so the caller can push a `RenameTitleCommand` that knows how to reverse
 * the disk-side rename. For no-file-rename branches (no vault open, no
 * resolvable path, identical newRel) the success flag is true but the
 * path fields stay undefined — the title-only update is already applied.
 */
export interface RenameTextTileResult {
  success: boolean;
  oldTitle?: string;
  newTitle?: string;
  oldTitleHtml?: string | undefined;
  newTitleHtml?: string | undefined;
  oldPath?: string;
  newPath?: string;
}

/**
 * Board slice — tile CRUD for the active board. Every mutation is forwarded
 * to the cache (`boardCacheStore.persist*Tile`), which is the single source
 * of truth in the reactive-BoardScope world (Phase R7). The pane's spatial
 * index is also updated imperatively so single-pane drag / resize / rubber-
 * band selection still sees fresh geometry without waiting for a reactive
 * recompute.
 *
 * The drag/resize fast path bypasses Zod's full `TileSchema.safeParse`
 * because position values come from float math on pointer coords
 * (Number.isFinite covers the only realistic invalid input) and the
 * per-pointer win matters during multi-tile drags.
 */
export function makeTilesSlice(ctx: BoardContext) {
  return {
    async addTile(tile: Tile, options?: { skipEmptySeed?: boolean }): Promise<void> {
      // Stamp boardId from the active board when the caller left it empty.
      // Tiles built during a board transition (drag-drop in flight, template
      // insertion racing with a tab switch) can land here with boardId: '' —
      // without this, persistAddTile would silent-drop them.
      const current = ctx.getCurrent();
      const stamped: Tile = tile.boardId
        ? tile
        : ({ ...tile, boardId: current?.id ?? '' } as Tile);
      const parsed = TileSchema.safeParse(stamped);
      if (!parsed.success) {
        // Hard-reject: persisting a Zod-invalid tile writes a malformed shape
        // to disk, where the next loadBoard silently drops it — losing the
        // placement (and any inline Link/Iframe/Timer data). Mirror updateTile's
        // reject-and-warn rather than persisting the bad tile anyway. (Audit 1.2)
        console.warn('[boardStore.addTile] Rejecting invalid tile:', parsed.error.issues);
        uiStore.toast('Could not add tile — invalid data (see console)', 'error', 4000);
        return;
      }
      const validTile = parsed.data as Tile;
      const w = validTile.renderedWidth ?? validTile.size.width;
      const h = validTile.renderedHeight ?? validTile.size.height;
      ctx.spatial.insert(validTile.id, validTile.position.x, validTile.position.y, w, h);
      await boardCacheStore.persistAddTile(validTile, options);
    },

    async persistAddTile(tile: Tile, options?: { skipEmptySeed?: boolean }): Promise<void> {
      return boardCacheStore.persistAddTile(tile, options);
    },

    removeTile(tileId: string): void {
      ctx.spatial.remove(tileId);
      boardCacheStore.persistRemoveTile(tileId);
    },

    persistRemoveTile(tileId: string): void {
      boardCacheStore.persistRemoveTile(tileId);
    },

    updateTile(tileId: string, updates: Partial<Tile>): void {
      const tiles = ctx.getTiles();
      const existing = tiles[tileId];
      if (!existing) return;

      // Fast path: pure geometry updates from drag / resize bypass the full Zod
      // schema check. Position values come from float math on pointer coords
      // and pan deltas — Zod's only catch here is NaN / Infinity, which
      // Number.isFinite covers. Skipping safeParse is a measurable per-pointer
      // win during multi-tile drag.
      if (isGeometryOnlyUpdate(updates)) {
        const merged = { ...existing, ...updates, updatedAt: Date.now() } as Tile;
        const w = merged.renderedWidth ?? merged.size.width;
        const h = merged.renderedHeight ?? merged.size.height;
        ctx.spatial.update(tileId, merged.position.x, merged.position.y, w, h);
        boardCacheStore.persistUpdateTile(tileId, updates, ctx.getCurrent()?.id);
        return;
      }

      const merged = { ...existing, ...updates, updatedAt: Date.now() } as Tile;
      const parsed = TileSchema.safeParse(merged);
      if (!parsed.success) {
        // Validation failed — refuse the update. Persisting `merged` would write
        // a Zod-invalid tile shape to disk, where it would fail the next load
        // and either crash board hydration or silently get dropped by `loadBoard`.
        // Better to drop the bad update here and warn loudly.
        console.warn(
          `[boardStore.updateTile] Rejecting invalid update for ${tileId}:`,
          parsed.error.issues,
          { updates },
        );
        return;
      }
      const validTile = parsed.data as Tile;
      if (
        updates.position || updates.size
        || updates.renderedWidth !== undefined
        || updates.renderedHeight !== undefined
      ) {
        const w = validTile.renderedWidth ?? validTile.size.width;
        const h = validTile.renderedHeight ?? validTile.size.height;
        ctx.spatial.update(tileId, validTile.position.x, validTile.position.y, w, h);
      }
      boardCacheStore.persistUpdateTile(tileId, updates, ctx.getCurrent()?.id);
    },

    persistUpdateTile(tileId: string, updates: Partial<Tile>, boardId?: string): void {
      boardCacheStore.persistUpdateTile(tileId, updates, boardId);
    },

    async renameTextTileBackingFile(
      tileId: string,
      newTitle: string,
      newTitleHtml: string | undefined,
    ): Promise<RenameTextTileResult> {
      const tile = ctx.getTiles()[tileId];
      if (!tile || tile.type !== 'text') return { success: false };

      const oldTitle = tile.title;
      const oldTitleHtml = tile.titleHtml;
      const titleChanged = newTitle !== oldTitle;
      const titleHtmlChanged = (tile.titleHtml ?? '') !== (newTitleHtml ?? '');

      if (!titleChanged && !titleHtmlChanged) {
        return { success: true, oldTitle, newTitle, oldTitleHtml, newTitleHtml };
      }
      if (!titleChanged) {
        ctx.updateTile(tileId, { titleHtml: newTitleHtml });
        return { success: true, oldTitle, newTitle, oldTitleHtml, newTitleHtml };
      }

      const vaultRoot = vaultStore.path;
      if (!vaultRoot) {
        ctx.updateTile(tileId, { title: newTitle, titleHtml: newTitleHtml });
        return { success: true, oldTitle, newTitle, oldTitleHtml, newTitleHtml };
      }

      // Pin the resolver to the tile's home board so the cascade fallback
      // (when filePath / docState aren't set) reads THIS tile's per-board
      // defaultFolder, not whichever board happens to be active.
      const oldRel = resolveTextTileVaultPath(tile, tile.boardId);
      if (!oldRel) {
        ctx.updateTile(tileId, { title: newTitle, titleHtml: newTitleHtml });
        return { success: true, oldTitle, newTitle, oldTitleHtml, newTitleHtml };
      }

      const newRel = replaceTitleInVaultPath(oldRel, newTitle);
      if (oldRel === newRel) {
        ctx.updateTile(tileId, { title: newTitle, titleHtml: newTitleHtml });
        return { success: true, oldTitle, newTitle, oldTitleHtml, newTitleHtml };
      }

      // `vaultStore.rename` now drains every registered markdown writer
      // before issuing the IPC rename (Phase 8.2), so the per-tile
      // `flushMarkdownWriter` that used to live here is no longer needed.

      const docId = (tile as Tile & { contentId?: string }).contentId;
      const existingDoc = documentStore.findByFilename(newRel);
      if (existingDoc && existingDoc.docId !== docId) {
        uiStore.toast(`A file named '${newRel}' already exists`, 'warning', 3500);
        return { success: false };
      }
      if (!existingDoc) {
        try {
          const exists = await window.filo.invoke('vault:file-exists', vaultRoot, newRel);
          if (exists) {
            uiStore.toast(`A file named '${newRel}' already exists`, 'warning', 3500);
            return { success: false };
          }
        } catch (err) {
          console.warn('[boardStore.renameTextTileBackingFile] file-exists probe failed:', err);
        }
      }

      const root = normalizePath(vaultRoot);
      const oldAbs = `${root}/${oldRel}`;
      const newAbs = `${root}/${newRel}`;

      const renameResult = await vaultStore.rename(oldAbs, newAbs);
      if (!renameResult.success) {
        const msg = renameResult.code === 'ENOENT'
          ? `Backing file '${oldRel}' is no longer on disk`
          : 'Failed to rename file';
        uiStore.toast(msg, renameResult.code === 'ENOENT' ? 'warning' : 'error', 3500);
        return { success: false };
      }

      ctx.updateTile(tileId, { title: newTitle, titleHtml: newTitleHtml });
      return {
        success: true,
        oldTitle,
        newTitle,
        oldTitleHtml,
        newTitleHtml,
        oldPath: oldRel,
        newPath: newRel,
      };
    },

    getTile(tileId: string): Tile | undefined {
      return ctx.getTiles()[tileId];
    },

    /** Generates the next default tile name (e.g. "New Tile", "New Tile 2", …). */
    getNextTileName(): string {
      const baseName = 'New Tile';
      const tiles = ctx.getTiles();
      const existing = Object.values(tiles).filter((t) => t.title.startsWith(baseName));
      if (existing.length === 0) return baseName;

      const numbers = existing.map((t) => {
        const suffix = t.title.replace(baseName, '').trim();
        return suffix === '' ? 1 : parseInt(suffix, 10) || 0;
      });
      const max = Math.max(...numbers);
      return `${baseName} ${max + 1}`;
    },

    batchUpdateTiles(updates: Array<{ id: string; changes: Partial<Tile> }>): void {
      const spatialUpdates: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
      const boardId = ctx.getCurrent()?.id;
      const tiles = ctx.getTiles();

      let dropped = 0;
      for (const { id, changes } of updates) {
        const existing = tiles[id];
        if (!existing) continue;
        const merged = { ...existing, ...changes, updatedAt: Date.now() } as Tile;
        const parsed = TileSchema.safeParse(merged);
        if (!parsed.success) {
          // Skip the bad update — persisting a Zod-invalid merged tile would
          // write a malformed shape that loadBoard drops on next open. Mirror
          // updateTile's hard-reject rather than persisting anyway. (Audit 1.2)
          console.warn(`[boardStore.batchUpdateTiles] Rejecting invalid update for ${id}:`, parsed.error.issues);
          dropped++;
          continue;
        }
        const validTile = parsed.data as Tile;
        boardCacheStore.persistUpdateTile(id, changes, boardId);

        if (
          changes.position || changes.size
          || changes.renderedWidth !== undefined
          || changes.renderedHeight !== undefined
        ) {
          const w = validTile.renderedWidth ?? validTile.size.width;
          const h = validTile.renderedHeight ?? validTile.size.height;
          spatialUpdates.push({ id, x: validTile.position.x, y: validTile.position.y, w, h });
        }
      }

      for (const s of spatialUpdates) {
        ctx.spatial.update(s.id, s.x, s.y, s.w, s.h);
      }
      if (dropped > 0) {
        uiStore.toast(
          `${dropped} tile update${dropped === 1 ? '' : 's'} skipped — invalid data (see console)`,
          'error',
          4000,
        );
      }
    },
  };
}

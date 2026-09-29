import { vaultStore } from './vault.svelte';
import {
  type BoardFileData,
  type ViewportEntry,
  cancelBoardWrite,
  flushBoardWrite,
  getViewportFromCache,
  removeViewport,
  setViewport,
} from '../lib/boards/boardSaver';
import { markBoardPathDeleting, clearBoardPathDeleting } from '../lib/boards/boardWriteScheduler';
import { releaseBoardDrift } from '../lib/boards/boardDriftHold';
import { trashVaultPath } from '../lib/vault/vaultOperations';
import { reportError } from '../lib/utils/errorBus';
import { invokeOk } from '../lib/utils/invokeOk';
import { workspaceStore, type BoardToolbarState } from './workspace.svelte';

/** The board cache's own state, handed to this slice. */
export interface BoardDeleteContext {
  getCache(): Record<string, BoardFileData>;
  setCache(next: Record<string, BoardFileData>): void;
  getPaths(): Record<string, string>;
  setPaths(next: Record<string, string>): void;
  /** Writes the board's pending change now. */
  flushWrite(boardId: string): Promise<{ ok: boolean }>;
  /** Arms a write of the board's cached state. */
  markDirty(boardId: string): void;
}

/** How a board was last shown: its camera and its side toolbar. */
export interface BoardView {
  viewport: ViewportEntry | null;
  toolbar: BoardToolbarState;
}

/** A board file the delete moved into Filo's trash. */
export interface TrashedBoard {
  boardPath: string;
  trashId: string;
  /** Put back by the delete's Undo; kept only for this session. */
  view: BoardView;
  /**
   * The `.filo/recovery/` folder holding the board as it was in memory, when
   * its last changes couldn't be written to the file before the move.
   */
  rescueDir?: string;
}

/** Copies the board as it is in memory to `.filo/recovery/<ts>-unsaved/`. The folder, or null. */
async function keepBoardRescueCopy(vaultRoot: string, boardPath: string, data: BoardFileData | undefined): Promise<string | null> {
  if (!data) return null;
  try {
    const result = await invokeOk('recovery:keep-unsaved', vaultRoot, [{ relPath: boardPath, text: `${JSON.stringify(data, null, 2)}
` }]);
    return result.kept.length > 0 ? result.dir : null;
  } catch (err) {
    console.error('[boardCache] keeping a copy of the board before delete failed:', err);
    return null;
  }
}

/**
 * Board cache slice — deleting a board. The `.board.json` moves into Filo's
 * trash (never unlinked), so the delete can be undone from its toast or from
 * Settings → Trash.
 */
export function makeBoardDeleteSlice(ctx: BoardDeleteContext) {
  return {
    /**
     * Drops every cache-side trace of a board: paths, cache map entry, the
     * Project's boards array entry, any pending debounced write, the
     * viewport map entry and the side toolbar's position / pin. Does NOT touch disk — the caller is responsible
     * for the `.board.json` file (it never existed, went to the trash via
     * `deleteBoard`, or disappeared externally and this is the
     * reconciliation path).
     *
     * Returns true when an entry was found and removed. False is a no-op
     * (already gone) — not an error.
     */
    removeBoardFromCache(boardId: string): boolean {
      const paths = ctx.getPaths();
      const cache = ctx.getCache();
      if (!(boardId in paths) && !(boardId in cache)) return false;

      const { [boardId]: _path, ...restPaths } = paths;
      void _path;
      ctx.setPaths(restPaths);
      const { [boardId]: _cache, ...restCache } = cache;
      void _cache;
      ctx.setCache(restCache);

      const project = vaultStore.getProject();
      if (project) project.boards = project.boards.filter((b) => b.id !== boardId);

      cancelBoardWrite(boardId);
      // A drift question about a board no longer here has nothing left to decide.
      if (typeof _path === 'string') releaseBoardDrift(_path);
      // Drop the entry from the unified viewports map and schedule a
      // debounced flush so .filo/viewports.json reflects the deletion.
      removeViewport(boardId);
      workspaceStore.removeBoardToolbar(boardId);
      return true;
    },

    /**
     * Moves a board's file into Filo's trash and drops its cache entry.
     * Returns where it went, or null when it couldn't be moved (reported).
     */
    async deleteBoard(boardId: string): Promise<TrashedBoard | null> {
      const vaultRoot = vaultStore.path;
      if (!vaultRoot) return null;
      const boardPath = ctx.getPaths()[boardId];
      if (!boardPath) return null;

      const view: BoardView = { viewport: getViewportFromCache(boardId), toolbar: workspaceStore.boardToolbar(boardId) };
      // The trashed copy is what Undo and Settings → Trash bring back, so the
      // last edits (up to 300 ms old) are written first. If they can't be,
      // the board as it is in memory is kept in .filo/recovery/ before the
      // move; with neither, the board stays.
      let rescueDir: string | undefined;
      if (!(await ctx.flushWrite(boardId)).ok) {
        const dir = await keepBoardRescueCopy(vaultRoot, boardPath, ctx.getCache()[boardId]);
        if (!dir) {
          reportError(
            'boardCache.delete',
            null,
            `Couldn't save the last changes to ${boardPath} or keep a copy of them, so the board was not deleted.`,
          );
          return null;
        }
        rescueDir = dir;
      }
      // Then cancel anything armed since, else a timer fires after the move
      // and recreates the file.
      cancelBoardWrite(boardId, boardPath);

      // cancelBoardWrite only reaches pending/parked timers; an IN-FLIGHT
      // board:save (e.g. suspended on the drift prompt) would resolve after
      // the move and recreate the .board.json as a ghost. Mark the path so
      // writeBoardFile bails before board:save; clear it once any in-flight
      // write drains (so a board restored or re-created here isn't blocked).
      markBoardPathDeleting(boardPath);

      try {
        const result = await trashVaultPath(vaultRoot, boardPath);
        if (!result.success) {
          throw new Error(result.error ?? result.code ?? 'vault:trash-move failed');
        }
        this.removeBoardFromCache(boardId);
        // Drain the in-flight write (neutralised by the mark above), then
        // clear — fire-and-forget so the delete returns promptly.
        void flushBoardWrite(boardId, () => null).finally(() => clearBoardPathDeleting(boardPath));
        return { boardPath, trashId: result.trashId, view, ...(rescueDir ? { rescueDir } : {}) };
      } catch (err) {
        clearBoardPathDeleting(boardPath); // the move failed — re-enable writes
        // The board stays, so its changes stay tracked for the next save.
        ctx.markDirty(boardId);
        reportError('boardCache.delete', err, `Couldn't move the board file ${boardPath} to Filo's trash; it was not deleted.`);
        return null;
      }
    },

    /**
     * Puts back how a board was shown once its file is restored (the
     * delete's Undo), unless it has a camera or toolbar place again. The
     * board file keeps its id, so it picks them up whenever it is loaded.
     */
    putBackBoardView(boardId: string, view: BoardView): void {
      if (view.viewport && !getViewportFromCache(boardId)) setViewport(boardId, view.viewport);
      const now = workspaceStore.boardToolbar(boardId);
      if (now.position || now.pinned) return;
      if (view.toolbar.position) workspaceStore.setBoardToolbarPosition(boardId, view.toolbar.position);
      if (view.toolbar.pinned) workspaceStore.setBoardToolbarPinned(boardId, true);
    },
  };
}

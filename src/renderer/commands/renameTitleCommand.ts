/**
 * Phase 5 / 5.6 — undoable title rename for tiles.
 *
 * For text tiles the title rename also renames the backing `.md` file (so
 * "Notes.md" → "Plans.md" follows the title change). Before this phase the
 * rename ran without history; Ctrl+Z couldn't undo the disk-side rename or
 * the in-board title change.
 *
 * The forward rename happens at component-time via the existing
 * `renameTextTileBackingFile` flow (which handles collision detection
 * + vaultStore.rename + cascade propagation). After success the component
 * pushes this command via `pushWithoutExecute` with the before/after
 * snapshot so:
 *  - `undo()` runs the reverse `vault:rename` and restores the title.
 *  - `execute()` (redo) re-runs the forward rename + title update.
 *
 * `vault:rename` is symmetric: both directions resolve through the same
 * IPC handler, which propagates the rename into every loaded board's
 * file references. The only asymmetry is collision handling — if a file
 * already exists at the destination when redo fires, the rename fails
 * and the command surfaces a toast (same shape as the forward path).
 */

import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { documentStore } from '../stores/document.svelte';
import { vaultStore } from '../stores/vault.svelte';
import { uiStore } from '../stores/ui.svelte';
import { normalizePath } from '../lib/utils/path';
import type { Tile } from '../schema/index';

export class RenameTitleCommand extends Command {
  description: string;
  /**
   * Phase 2 (IMPLEMENTATION_PLAN_2026-05-27) — flagged as a P1-5 site.
   * Title-rename mutates `boardStore.updateTile(...)` against the active
   * board; if a redo lands after a board switch the rename would target
   * whichever tile/title pair happens to live on the now-active board.
   * Cache-mode path (this.boardId set) already explicitly targets that
   * board id; capture it here as the targetBoardId so the guard fires.
   */
  readonly targetBoardId: string;
  private tileId: string;
  private oldTitle: string;
  private newTitle: string;
  private oldTitleHtml: string | undefined;
  private newTitleHtml: string | undefined;
  /**
   * Vault-relative paths of the backing file. Both are `null` for non-text
   * tiles (no file rename). When set, `oldPath` is the pre-rename path and
   * `newPath` is the post-rename path.
   */
  private oldPath: string | null;
  private newPath: string | null;
  /**
   * Phase 7 / 7.9 — board id for cache-backed tiles (Task List / Kanban
   * cards). `null` for active-canvas tiles where `boardStore.getTile`
   * resolves on its own. When set, undo/redo route through
   * `boardCacheStore.persistUpdateTile` since the tile isn't on the active
   * mind-map canvas.
   */
  private boardId: string | null;
  /**
   * Phase 7 / 7.9 — document id, if the renamed tile is backed by a docStore
   * entry. When set, undo/redo also update the document's filename + title
   * to match the rename. Document board / sidebar tiles + tasks all use
   * this so the resolver sees the new path immediately.
   */
  private contentId: string | null;

  constructor(
    tileId: string,
    oldTitle: string,
    newTitle: string,
    oldTitleHtml: string | undefined,
    newTitleHtml: string | undefined,
    paths: { oldPath: string | null; newPath: string | null } = { oldPath: null, newPath: null },
    extras: { boardId?: string | null; contentId?: string | null } = {},
  ) {
    super();
    this.tileId = tileId;
    this.oldTitle = oldTitle;
    this.newTitle = newTitle;
    this.oldTitleHtml = oldTitleHtml;
    this.newTitleHtml = newTitleHtml;
    this.oldPath = paths.oldPath;
    this.newPath = paths.newPath;
    this.boardId = extras.boardId ?? null;
    this.contentId = extras.contentId ?? null;
    this.targetBoardId = this.boardId ?? boardStore.current?.id ?? '';
    this.description = `Rename to "${newTitle}"`;
  }

  async execute(): Promise<void> {
    await this.applyRename(this.oldPath, this.newPath, this.newTitle, this.newTitleHtml);
  }

  async undo(): Promise<void> {
    await this.applyRename(this.newPath, this.oldPath, this.oldTitle, this.oldTitleHtml);
  }

  private async applyRename(
    fromPath: string | null,
    toPath: string | null,
    title: string,
    titleHtml: string | undefined,
  ): Promise<void> {
    if (fromPath && toPath && fromPath !== toPath) {
      const vaultRoot = vaultStore.path;
      if (vaultRoot) {
        const root = normalizePath(vaultRoot);
        const fromAbs = `${root}/${fromPath}`;
        const toAbs = `${root}/${toPath}`;
        const result = await vaultStore.rename(fromAbs, toAbs);
        if (!result.success) {
          const msg = result.code === 'ENOENT'
            ? `Backing file '${fromPath}' is no longer on disk`
            : 'Failed to rename file';
          uiStore.toast(msg, result.code === 'ENOENT' ? 'warning' : 'error', 3500);
          // Bail before updating the in-board title so the tile keeps
          // pointing at whichever filename is actually on disk.
          return;
        }
      }
    }
    const titlePatch = { title, titleHtml } as Partial<Tile>;
    if (boardStore.getTile(this.tileId)) {
      boardStore.updateTile(this.tileId, titlePatch);
    } else if (this.boardId) {
      // Phase 7 / 7.9 — cache-only path for Task List / Kanban tiles that
      // aren't on the active mind-map canvas. Mirrors the live-tile branch
      // by routing through the cache so the next render picks up the title
      // change via the active-proxy bridge (TaskListBoard.tickAndPersist).
      boardCacheStore.persistUpdateTile(this.tileId, titlePatch, this.boardId);
    }
    if (this.contentId && toPath) {
      documentStore.updateFilename(this.contentId, toPath);
      // Phase A.4 — undo/redo of a title rename do NOT modify body
      // content, so flipping `isDirty` would queue the markdown
      // scheduler to write the in-memory body — possibly stale after
      // external edits during the rename window — back to the
      // freshly-renamed-back file, silently overwriting the external
      // changes. Use the clean variant that preserves whatever dirty
      // state the doc already had.
      documentStore.updateTitleClean(this.contentId, title);
    }
  }
}

import {
  getConventionFolderForBoardType,
  joinConventionPath,
} from '../vault/fileRefIntegrity';
import { samePath } from '../utils/path';

/**
 * Pure planner used by the canvas drag-drop handler for `.md` files.
 * Decides two things about a `.md` drop on the active board:
 *
 *   1. **duplicate** — Does any existing text tile on the board already
 *      represent this file? Matched by: explicit `filePath` equality,
 *      `contentId` equality, or convention-path equality. Any one wins.
 *      The drop still proceeds; the caller surfaces a non-blocking toast.
 *   2. **filePath** — Should the new tile be stamped with an explicit
 *      `filePath`? Returns the path string when the drop sits OUTSIDE the
 *      board's convention path for the derived title (or when the board
 *      has no convention folder at all). Returns `null` when the drop
 *      lines up with the convention path, since the convention fallback
 *      in TextTile already produces the right path.
 *
 * Without this stamp, a dropped file from a subfolder would have its tile
 * fall through to `${title}.md` at the convention folder on first save,
 * recreating a duplicate `.md` file at the wrong location.
 */
export function planTextTileDrop(input: {
  droppedRelPath: string;
  title: string;
  contentId: string;
  boardType: string | null;
  boardName: string | undefined;
  /**
   * Phase 2 / 2.3 — frozen Kanban convention folder name. Pass the live
   * board's `kanbanFolder` field so a renamed Kanban board still resolves
   * its drops under the original folder.
   */
  kanbanFolder?: string;
  existingTiles: ReadonlyArray<{
    type: string;
    title?: string;
    contentId?: string;
    filePath?: string;
  }>;
  /**
   * Optional cascade-resolved folder for the active board. Overrides the
   * base type-derived convention only when the type's own folder is the
   * cascade-aware `''` (mindmap, tasklist). Pass the output of
   * `getActiveContentFolder(boardStore.current)` from the caller so a board
   * pinned to e.g. `Tasks/` still treats `Tasks/<title>.md` as the convention.
   */
  conventionFolderOverride?: string;
}): { duplicate: boolean; filePath: string | null } {
  const {
    droppedRelPath,
    title,
    contentId,
    boardType,
    boardName,
    kanbanFolder,
    existingTiles,
    conventionFolderOverride,
  } = input;
  const baseFolder =
    boardType !== null
      ? getConventionFolderForBoardType(boardType, boardName, kanbanFolder)
      : null;
  // Cascade applies only when the base folder is the cascade-aware ''
  // (mindmap / tasklist). Kanban's name-derived folder ignores overrides.
  const conventionFolder =
    baseFolder === '' && conventionFolderOverride
      ? conventionFolderOverride
      : baseFolder;
  const expectedConventionPath =
    conventionFolder !== null ? joinConventionPath(conventionFolder, title) : null;

  let duplicate = false;
  for (const t of existingTiles) {
    if (t.type !== 'text') continue;
    if (t.filePath && samePath(t.filePath, droppedRelPath)) { duplicate = true; break; }
    if (t.contentId && t.contentId === contentId) { duplicate = true; break; }
    if (conventionFolder !== null) {
      const otherPath = joinConventionPath(conventionFolder, (t.title ?? '').trim());
      if (samePath(otherPath, droppedRelPath)) { duplicate = true; break; }
    }
  }

  const filePath =
    !expectedConventionPath || !samePath(expectedConventionPath, droppedRelPath)
      ? droppedRelPath
      : null;

  return { duplicate, filePath };
}

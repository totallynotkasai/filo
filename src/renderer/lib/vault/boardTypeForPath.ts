/**
 * Resolve the board TYPE behind a sidebar `.board.json` file node, or `null`
 * when the path doesn't correspond to a loaded board.
 *
 * Used by the sidebar `FileIcon` to render a type-specific icon (Mind Map /
 * Kanban / Task List) instead of the generic JSON icon every `.board.json`
 * otherwise shows. Document boards intentionally resolve like any other board
 * here; the caller decides to keep the generic icon for them.
 *
 * Why this is cheap: every board in the vault is eagerly parsed into
 * `project.boards` + `boardCacheStore.paths` at vault open (`loadAllBoards`),
 * so this is an in-memory lookup — no IPC, no disk read.
 *
 * Path handling mirrors VaultFileItem's double-click resolver and
 * `findBoardIdForPath` (stores/vaultExternalReconcilers.ts): the sidebar's
 * `FileTreeNode.path` is ABSOLUTE, while board placements are keyed by
 * vault-relative POSIX path, so we strip the vault root first and compare with
 * the case-folded `samePath` (Windows/macOS are case-insensitive, so the
 * OS-reported casing can diverge from the stored casing).
 *
 * Pure — every input is passed in, so it unit-tests without store mocks.
 */

import type { Board } from '../../schema/index';
import type { BoardType } from '../../../shared/types';
import { normalizePath, toPosix, stripLeadingSlash, samePath } from '../utils/path';

export function boardTypeForPath(
  nodePath: string,
  vaultRoot: string | null | undefined,
  boards: Board[],
  paths: Record<string, string>,
): BoardType | null {
  // Strip the vault root to a vault-relative path (mirrors
  // VaultFileItem.vaultRelativePath). If the root doesn't prefix the path we
  // fall back to the raw value; it simply won't match any relative board path,
  // yielding `null` (the generic icon) rather than a wrong match.
  const root = vaultRoot ? normalizePath(vaultRoot) : '';
  const abs = toPosix(nodePath);
  const rel = root && abs.startsWith(root) ? stripLeadingSlash(abs.slice(root.length)) : abs;

  for (const [boardId, boardPath] of Object.entries(paths)) {
    if (samePath(boardPath, rel)) {
      return boards.find((b) => b.id === boardId)?.type ?? null;
    }
  }
  return null;
}

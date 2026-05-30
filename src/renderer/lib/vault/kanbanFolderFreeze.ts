/**
 * Phase B / B.1 — Legacy Kanban kanbanFolder freeze helper.
 *
 * Phase 2.3 stamps `kanbanFolder` on NEW kanban boards in
 * `boardCacheStore.persistNewBoard`. Boards created before that landed
 * have no field, so `getConventionFolderForBoardType` falls through to
 * `sanitize(name)`. Once the user renames a legacy board, existing
 * cards (resolved via their explicit `filePath` in tile defs) keep
 * pointing at `Kanban/<oldname>/`, while every NEW card is written
 * under `Kanban/<newname>/` — split brain.
 *
 * `freezeLegacyKanbanFolder` mutates the board in place to seed
 * `kanbanFolder` to the sanitised CURRENT name, but ONLY if the board
 * is kanban AND has no existing field. Returns true when a mutation
 * was applied so callers can decide whether to schedule a persist.
 *
 * Idempotent: modern boards (already carrying `kanbanFolder`) are
 * untouched, as are non-kanban boards.
 */
import { fileNameSafe } from './conventionPaths';
import type { Board } from '../../schema/index';

export function freezeLegacyKanbanFolder(board: Board): boolean {
  if (board.type !== 'kanban') return false;
  const b = board as Board & { kanbanFolder?: string };
  if (b.kanbanFolder && b.kanbanFolder.trim().length > 0) return false;
  b.kanbanFolder = fileNameSafe(board.name);
  return true;
}

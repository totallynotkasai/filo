/**
 * Phase B / B.4 — Kanban folder MOVE (cross-folder) must propagate to the
 * board's `kanbanFolder` field so future card writes land at the new
 * location.
 *
 * Before this fix, moving `Kanban/Tasks/` → `Archive/Tasks/` left
 * `board.kanbanFolder` unchanged. Existing cards (with explicit refs
 * rewritten by `propagateRenameAcrossBoards`) still resolved at the new
 * path, but the convention abstraction (`Kanban/<kanbanFolder>`) still
 * pointed at the original folder — every newly-dropped card landed
 * back under the old folder. Split brain.
 *
 * The fix:
 *   - `propagateMarkdownRenameToTextTiles` detects folder-mode renames
 *     (neither path ends in `.md`) and updates `kanbanFolder` to the
 *     new full vault-relative path on every kanban board whose
 *     convention folder matched the old path.
 *   - `getConventionFolderForBoardType` treats `kanbanFolder` values
 *     containing a `/` as a full path (skip the `Kanban/` prefix).
 *
 * Legacy boards (no `kanbanFolder` field) get the new full path stamped
 * directly — the freeze-then-update sequence from B.1 collapses to a
 * single assignment because the legacy value would have pointed at the
 * old folder anyway.
 */

import { describe, it, expect } from 'vitest';
import {
  propagateMarkdownRenameToTextTiles,
  getConventionFolder,
  getConventionFolderForBoardType,
} from '@renderer/lib/vault/fileRefIntegrity';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

function makeKanban(
  id: string,
  name: string,
  kanbanFolder?: string,
): V7BoardFileData {
  return {
    board: {
      id,
      type: 'kanban',
      name,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
      ...(kanbanFolder !== undefined && { kanbanFolder }),
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('Kanban folder move propagation (Phase B.4)', () => {
  describe('getConventionFolderForBoardType — full-path kanbanFolder', () => {
    it('returns the full path verbatim when kanbanFolder contains a slash', () => {
      expect(getConventionFolderForBoardType('kanban', 'Tasks', 'Archive/Tasks')).toBe(
        'Archive/Tasks',
      );
    });

    it('still prefixes Kanban/ when kanbanFolder is a single segment', () => {
      expect(getConventionFolderForBoardType('kanban', 'Whatever', 'Tasks')).toBe(
        'Kanban/Tasks',
      );
    });

    it('handles deep nested moves (multi-segment new path)', () => {
      expect(getConventionFolderForBoardType('kanban', 'X', 'Archive/2026/Tasks')).toBe(
        'Archive/2026/Tasks',
      );
    });
  });

  describe('propagateMarkdownRenameToTextTiles — folder mode', () => {
    it('updates kanbanFolder on a modern kanban board whose convention matched the old folder', () => {
      const board = makeKanban('kb', 'Tasks', 'Tasks');
      const boards = { kb: board };

      // In-folder rename inside Kanban/ — same kanban-folder match.
      const result = propagateMarkdownRenameToTextTiles(boards, 'Kanban/Tasks', 'Kanban/Todo');

      expect(result.changedBoardIds).toEqual(['kb']);
      expect(getConventionFolder(board)).toBe('Kanban/Todo');
    });

    it('updates kanbanFolder on a cross-folder move (e.g. Kanban/Tasks → Archive/Tasks)', () => {
      const board = makeKanban('kb', 'Tasks', 'Tasks');
      const boards = { kb: board };

      const result = propagateMarkdownRenameToTextTiles(boards, 'Kanban/Tasks', 'Archive/Tasks');

      expect(result.changedBoardIds).toEqual(['kb']);
      // The kanbanFolder is now a full path; the convention resolver
      // skips the Kanban/ prefix because of the slash.
      expect((board.board as { kanbanFolder?: string }).kanbanFolder).toBe('Archive/Tasks');
      expect(getConventionFolder(board)).toBe('Archive/Tasks');
    });

    it('seeds kanbanFolder on a legacy board (no existing field) during a folder move', () => {
      // Legacy: created before Phase 2.3, so no kanbanFolder field. The
      // convention folder was name-derived (`Kanban/<sanitize(name)>`).
      const board = makeKanban('legacy', 'Tasks'); // no kanbanFolder
      const boards = { legacy: board };

      const result = propagateMarkdownRenameToTextTiles(boards, 'Kanban/Tasks', 'Archive/Tasks');

      expect(result.changedBoardIds).toEqual(['legacy']);
      // Legacy field is seeded straight to the new full path.
      expect((board.board as { kanbanFolder?: string }).kanbanFolder).toBe('Archive/Tasks');
      expect(getConventionFolder(board)).toBe('Archive/Tasks');
    });

    it('ignores boards whose convention folder did not match the old folder', () => {
      const matched = makeKanban('match', 'Tasks', 'Tasks');
      const unrelated = makeKanban('other', 'OtherBoard', 'OtherFolder');
      const boards = { match: matched, other: unrelated };

      const result = propagateMarkdownRenameToTextTiles(boards, 'Kanban/Tasks', 'Archive/Tasks');

      expect(result.changedBoardIds).toEqual(['match']);
      // Unrelated board's kanbanFolder stays untouched.
      expect((unrelated.board as { kanbanFolder?: string }).kanbanFolder).toBe('OtherFolder');
    });

    it('ignores non-kanban boards', () => {
      const mindmap: V7BoardFileData = {
        board: {
          id: 'mm',
          type: 'mindmap',
          name: 'Tasks',
          emoji: '',
          createdAt: 0,
          updatedAt: 0,
          settings: {},
          placements: {},
          inlineTiles: {},
          waypoints: [],
        } as never,
        tileDefs: {},
        connections: {},
        frames: [],
      };
      const boards = { mm: mindmap };

      const result = propagateMarkdownRenameToTextTiles(boards, 'Notes', 'Archive/Notes');

      // Mindmap convention folder is '' (root), and we're not renaming
      // the vault root — no match.
      expect(result.changedBoardIds).toEqual([]);
    });

    it('no-op when old and new folder paths are identical', () => {
      const board = makeKanban('kb', 'Tasks', 'Tasks');
      const boards = { kb: board };

      const result = propagateMarkdownRenameToTextTiles(boards, 'Kanban/Tasks', 'Kanban/Tasks');

      expect(result.changedBoardIds).toEqual([]);
      expect((board.board as { kanbanFolder?: string }).kanbanFolder).toBe('Tasks');
    });

    it('individual file renames inside the convention folder still rewrite titles (regression guard)', () => {
      // Sanity check that the file-mode branch (the original behaviour)
      // hasn't regressed. A single `Kanban/Tasks/Old.md` →
      // `Kanban/Tasks/New.md` rename should rewrite the matching tile's
      // title and leave kanbanFolder untouched.
      const board = makeKanban('kb', 'Tasks', 'Tasks');
      board.tileDefs = {
        t1: {
          id: 't1',
          type: 'text',
          title: 'Old',
          tags: [],
          style: { headerColor: '#fff', bodyColor: '#fff' },
          createdAt: 0,
          updatedAt: 0,
        } as never,
      };
      const boards = { kb: board };

      const result = propagateMarkdownRenameToTextTiles(
        boards,
        'Kanban/Tasks/Old.md',
        'Kanban/Tasks/New.md',
      );

      expect(result.changedBoardIds).toEqual(['kb']);
      // kanbanFolder stayed put (this is a file rename, not a folder move).
      expect((board.board as { kanbanFolder?: string }).kanbanFolder).toBe('Tasks');
      // Title was updated.
      expect((board.tileDefs.t1 as { title: string }).title).toBe('New');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  getConventionFolder,
  getConventionFolderForBoardType,
} from '@renderer/lib/vault/fileRefIntegrity';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 2 / 2.3 — Kanban convention folder must freeze at create-time and
 * survive subsequent board renames. Without this, renaming a Kanban board
 * orphans every existing card under the original (sanitised) folder.
 *
 *   - Create a Kanban board called "MyTasks" → on-disk `kanbanFolder = 'MyTasks'`.
 *   - Rename the board to "Archive" → `kanbanFolder` stays as `'MyTasks'`.
 *   - Legacy boards (no `kanbanFolder` field) fall back to name-derived.
 */

function makeKanban(
  boardId: string,
  name: string,
  kanbanFolder?: string,
): V7BoardFileData {
  return {
    board: {
      id: boardId,
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

describe('Kanban folder stability (Phase 2.3)', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
  });

  afterEach(() => {
    restoreFiloDefault();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
  });

  describe('getConventionFolderForBoardType (with explicit kanbanFolder)', () => {
    it('uses the kanbanFolder argument when provided for kanban boards', () => {
      const folder = getConventionFolderForBoardType('kanban', 'Renamed', 'OriginalName');
      expect(folder).toBe('Kanban/OriginalName');
    });

    it('falls back to the sanitised name when kanbanFolder is absent (legacy)', () => {
      const folder = getConventionFolderForBoardType('kanban', 'MyTasks', undefined);
      expect(folder).toBe('Kanban/MyTasks');
    });

    it('falls back to the sanitised name when kanbanFolder is empty', () => {
      const folder = getConventionFolderForBoardType('kanban', 'MyTasks', '');
      expect(folder).toBe('Kanban/MyTasks');
    });

    it('treats whitespace-only kanbanFolder as missing (fallback to name)', () => {
      const folder = getConventionFolderForBoardType('kanban', 'MyTasks', '   ');
      expect(folder).toBe('Kanban/MyTasks');
    });

    it('non-kanban types ignore the kanbanFolder argument', () => {
      expect(getConventionFolderForBoardType('mindmap', 'Foo', 'X')).toBe('');
      expect(getConventionFolderForBoardType('tasklist', 'Foo', 'X')).toBe('');
      expect(getConventionFolderForBoardType('document', 'Foo', 'X')).toBe(null);
    });

    it('sanitises both name-derived and explicit kanbanFolder paths', () => {
      // Name-derived strips illegal characters
      expect(getConventionFolderForBoardType('kanban', 'A<b>c', undefined)).toBe('Kanban/Abc');
      // Explicit value is passed through verbatim (caller is responsible for
      // sanitising at create-time)
      expect(getConventionFolderForBoardType('kanban', 'A<b>c', 'OriginalName')).toBe(
        'Kanban/OriginalName',
      );
    });
  });

  describe('getConventionFolder (reads kanbanFolder from board file)', () => {
    it('prefers the kanbanFolder field stored on a board', () => {
      const board = makeKanban('b1', 'RenamedBoard', 'OriginalFolder');
      expect(getConventionFolder(board)).toBe('Kanban/OriginalFolder');
    });

    it('falls back to name-derived for legacy boards without kanbanFolder', () => {
      const board = makeKanban('b1', 'MyTasks');
      expect(getConventionFolder(board)).toBe('Kanban/MyTasks');
    });

    it('returns null for unrelated board types', () => {
      const board = makeKanban('b1', 'Anything');
      // Spoof a non-kanban type so we exercise the default branch.
      (board.board as { type: string }).type = 'document';
      expect(getConventionFolder(board)).toBe(null);
    });
  });

  describe('persistNewBoard seeds kanbanFolder at create-time', () => {
    it('stamps kanbanFolder on new Kanban boards', async () => {
      installFiloMock({
        'board:create': () => ({ ok: true, path: 'b1.board.json' }),
      });

      const created = await boardCacheStore.createBoard('MyTasks', 'kanban');
      expect(created).not.toBeNull();
      expect((created as { kanbanFolder?: string }).kanbanFolder).toBe('MyTasks');
    });

    it('sanitises illegal filesystem characters at create-time', async () => {
      installFiloMock({
        'board:create': () => ({ ok: true, path: 'b2.board.json' }),
      });

      const created = await boardCacheStore.createBoard('A<b>c:d|e', 'kanban');
      expect((created as { kanbanFolder?: string }).kanbanFolder).toBe('Abcde');
    });

    it('does NOT stamp kanbanFolder on non-Kanban boards', async () => {
      installFiloMock({
        'board:create': () => ({ ok: true, path: 'mm.board.json' }),
      });

      const created = await boardCacheStore.createBoard('Map', 'mindmap');
      expect((created as { kanbanFolder?: string }).kanbanFolder).toBeUndefined();
    });

    it('survives a board rename (in-memory: name changes, kanbanFolder does not)', async () => {
      installFiloMock({
        'board:create': () => ({ ok: true, path: 'b3.board.json' }),
      });
      const created = await boardCacheStore.createBoard('Original', 'kanban');
      expect((created as { kanbanFolder?: string }).kanbanFolder).toBe('Original');

      // The rename flow only updates `board.name` — kanbanFolder is
      // intentionally NOT rewritten. Simulate that mutation directly.
      const cached = boardCacheStore.cache[created!.id];
      (cached.board as { name: string }).name = 'Archive';

      // The convention folder reflects the original kanbanFolder, not the
      // new name.
      expect(getConventionFolder(cached)).toBe('Kanban/Original');
    });
  });
});

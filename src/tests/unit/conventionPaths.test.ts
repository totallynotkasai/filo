import { describe, it, expect } from 'vitest';
import {
  fileNameSafe,
  nextUniqueMdPath,
  titleFromRelPath,
  normalizeRootFolder,
  getActiveContentFolder,
  getActiveContentFolderAbs,
} from '@renderer/lib/vault/conventionPaths';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Board } from '@renderer/schema/index';

function cacheWithTitles(titles: string[], _folder = ''): Record<string, V7BoardFileData> {
  const tileDefs: Record<string, Record<string, unknown>> = {};
  titles.forEach((t, i) => {
    tileDefs[`t${i}`] = {
      id: `t${i}`,
      type: 'text',
      title: t,
      style: {},
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    };
  });
  return {
    b1: {
      board: { id: 'b1', type: 'kanban' } as never,
      tileDefs: tileDefs as never,
      connections: {},
      frames: [],
    },
  };
}

describe('conventionPaths', () => {
  describe('fileNameSafe', () => {
    it('strips illegal filename characters', () => {
      expect(fileNameSafe('a<b>c:d|e?f*g')).toBe('abcdefg');
    });

    it('collapses whitespace runs into single spaces', () => {
      expect(fileNameSafe('  hello\t  world  \n')).toBe('hello world');
    });

    it('returns "Untitled" for empty inputs', () => {
      expect(fileNameSafe('')).toBe('Untitled');
      expect(fileNameSafe('   ')).toBe('Untitled');
      expect(fileNameSafe('///')).toBe('Untitled');
    });
  });

  describe('nextUniqueMdPath', () => {
    it('returns the base path when no collision exists', () => {
      const cache = cacheWithTitles([]);
      expect(nextUniqueMdPath(cache, '', 'Note')).toBe('Note.md');
    });

    it('appends "(2)" on first collision', () => {
      const cache = cacheWithTitles(['Note']);
      expect(nextUniqueMdPath(cache, '', 'Note')).toBe('Note (2).md');
    });

    it('finds the lowest available "(N)" suffix', () => {
      const cache = cacheWithTitles(['Note', 'Note (2)', 'Note (4)']);
      expect(nextUniqueMdPath(cache, '', 'Note')).toBe('Note (3).md');
    });

    it('honours the folder prefix', () => {
      const cache = cacheWithTitles(['Note']);
      expect(nextUniqueMdPath(cache, 'Kanban/Tasks', 'Note')).toBe('Kanban/Tasks/Note (2).md');
    });

    it('treats empty folder as vault root', () => {
      const cache = cacheWithTitles(['Note']);
      expect(nextUniqueMdPath(cache, '', 'Note (2)')).toBe('Note (2).md');
    });
  });

  describe('titleFromRelPath', () => {
    it('strips the folder prefix and .md suffix', () => {
      expect(titleFromRelPath('Tasks/Buy milk.md', 'Tasks')).toBe('Buy milk');
    });

    it('handles empty folder', () => {
      expect(titleFromRelPath('Note.md', '')).toBe('Note');
    });
  });

  describe('normalizeRootFolder', () => {
    it('returns empty string for null/undefined/empty', () => {
      expect(normalizeRootFolder(null)).toBe('');
      expect(normalizeRootFolder(undefined)).toBe('');
      expect(normalizeRootFolder('')).toBe('');
    });

    it('converts backslashes to forward slashes', () => {
      expect(normalizeRootFolder('My\\Folder\\Sub')).toBe('My/Folder/Sub');
    });

    it('strips leading and trailing slashes', () => {
      expect(normalizeRootFolder('/path/to/folder/')).toBe('path/to/folder');
      expect(normalizeRootFolder('///deeply///nested/')).toBe('deeply///nested');
    });
  });

  describe('getActiveContentFolder', () => {
    function makeBoard(defaultFolder: string): Board {
      return {
        id: 'b1',
        type: 'mindmap',
        name: 'Test',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {
          backgroundColor: '',
          backgroundPattern: 'grid',
          defaultFolder,
        },
        viewport: { x: 0, y: 0, scale: 1 },
        placements: {},
        inlineTiles: {},
        connections: [],
        frames: [],
        waypoints: [],
        groups: [],
      } as unknown as Board;
    }

    // No vault open in any test here, so vaultStore.activeRootFolder returns ''.
    // Vault-wide vs per-board precedence is covered separately in
    // fileRefIntegrity.test.ts (the cascade logic is exercised end-to-end via
    // detectBrokenRefs there).

    it('returns empty string when no board is provided', () => {
      expect(getActiveContentFolder(null)).toBe('');
    });

    it('returns empty string when board has no defaultFolder pin', () => {
      expect(getActiveContentFolder(makeBoard(''))).toBe('');
    });

    it('returns the per-board pin when set and no vault-wide pin', () => {
      expect(getActiveContentFolder(makeBoard('Inbox'))).toBe('Inbox');
    });

    it('normalises Windows separators and trailing slashes in per-board pin', () => {
      expect(getActiveContentFolder(makeBoard('Notes\\Sub\\'))).toBe('Notes/Sub');
    });
  });

  describe('getActiveContentFolderAbs', () => {
    it('returns empty string when no vault is open', () => {
      expect(getActiveContentFolderAbs(null)).toBe('');
    });
  });
});

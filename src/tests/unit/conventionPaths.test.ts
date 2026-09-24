import { describe, it, expect } from 'vitest';
import {
  fileNameSafe,
  nextUniqueMdPath,
  normalizeRootFolder,
  getActiveContentFolder,
  getActiveContentFolderAbs,
} from '@renderer/lib/vault/conventionPaths';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Board } from '@renderer/schema/index';

function cacheWithPaths(paths: string[]): Record<string, V7BoardFileData> {
  const tileDefs: Record<string, Record<string, unknown>> = {};
  paths.forEach((filePath, i) => {
    tileDefs[`t${i}`] = {
      id: `t${i}`,
      type: 'text',
      filePath,
      style: {},
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
    it('replaces illegal filename characters with "-"', () => {
      expect(fileNameSafe('a<b>c:d|e?f*g')).toBe('a-b-c-d-e-f-g');
      expect(fileNameSafe('What? / Why')).toBe('What- - Why');
      expect(fileNameSafe('///')).toBe('---');
    });

    it('replaces control characters (tab, newline) with "-"', () => {
      expect(fileNameSafe('a\tb\nc')).toBe('a-b-c');
    });

    it('collapses whitespace runs into single spaces', () => {
      expect(fileNameSafe('  hello    world  ')).toBe('hello world');
    });

    it('returns "Untitled" for empty inputs', () => {
      expect(fileNameSafe('')).toBe('Untitled');
      expect(fileNameSafe('   ')).toBe('Untitled');
    });

    // A trailing dot/space would build `Call Bob..md` (rejected by main,
    // stripped by Windows).
    it('strips trailing dots and spaces', () => {
      expect(fileNameSafe('Call Bob.')).toBe('Call Bob');
      expect(fileNameSafe('...')).toBe('Untitled');
      expect(fileNameSafe('a. ')).toBe('a');
      expect(fileNameSafe('Ideas... later')).toBe('Ideas... later');
    });
  });

  describe('nextUniqueMdPath', () => {
    it('returns the base path when no collision exists', () => {
      const cache = cacheWithPaths([]);
      expect(nextUniqueMdPath(cache, '', 'Note')).toBe('Note.md');
    });

    it('appends "(2)" on first collision', () => {
      const cache = cacheWithPaths(['Note.md']);
      expect(nextUniqueMdPath(cache, '', 'Note')).toBe('Note (2).md');
    });

    it('finds the lowest available "(N)" suffix', () => {
      const cache = cacheWithPaths(['Note.md', 'Note (2).md', 'Note (4).md']);
      expect(nextUniqueMdPath(cache, '', 'Note')).toBe('Note (3).md');
    });

    it('honours the folder prefix', () => {
      const cache = cacheWithPaths(['Kanban/Tasks/Note.md']);
      expect(nextUniqueMdPath(cache, 'Kanban/Tasks', 'Note')).toBe('Kanban/Tasks/Note (2).md');
    });

    it('a same-named note in another folder is not a collision', () => {
      const cache = cacheWithPaths(['Note.md']);
      expect(nextUniqueMdPath(cache, 'Kanban/Tasks', 'Note')).toBe('Kanban/Tasks/Note.md');
    });

    it('treats empty folder as vault root', () => {
      const cache = cacheWithPaths(['Note.md']);
      expect(nextUniqueMdPath(cache, '', 'Note (2)')).toBe('Note (2).md');
    });

    it('compares case-insensitively and folds in extra taken paths', () => {
      const cache = cacheWithPaths(['note.md']);
      expect(nextUniqueMdPath(cache, '', 'Note', ['Note (2).md'])).toBe('Note (3).md');
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

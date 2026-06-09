import { describe, it, expect } from 'vitest';
import { boardTypeForPath } from '@renderer/lib/vault/boardTypeForPath';
import type { Board } from '@renderer/schema/index';

/**
 * Pure helper behind the sidebar's board-type icons. The sidebar passes an
 * ABSOLUTE node path; board placements are keyed by vault-relative POSIX path,
 * so the helper strips the vault root and compares case-folded.
 */

const board = (id: string, type: string): Board => ({ id, type }) as unknown as Board;

const VAULT = 'C:/Users/me/Vault';

const boards = [
  board('b1', 'mindmap'),
  board('b2', 'kanban'),
  board('b3', 'tasklist'),
  board('b4', 'document'),
];

const paths: Record<string, string> = {
  b1: 'Maps/Brain.board.json',
  b2: 'Kanban.board.json',
  b3: 'Tasks/Todo.board.json',
  b4: 'Notes.board.json',
};

describe('boardTypeForPath', () => {
  it('resolves each board type from an absolute sidebar node path', () => {
    expect(boardTypeForPath(`${VAULT}/Maps/Brain.board.json`, VAULT, boards, paths)).toBe('mindmap');
    expect(boardTypeForPath(`${VAULT}/Kanban.board.json`, VAULT, boards, paths)).toBe('kanban');
    expect(boardTypeForPath(`${VAULT}/Tasks/Todo.board.json`, VAULT, boards, paths)).toBe('tasklist');
    expect(boardTypeForPath(`${VAULT}/Notes.board.json`, VAULT, boards, paths)).toBe('document');
  });

  it('matches case-insensitively and across separator styles (Windows backslashes)', () => {
    expect(boardTypeForPath(`${VAULT}\\maps\\brain.BOARD.json`, VAULT, boards, paths)).toBe('mindmap');
  });

  it('returns null for a path that is not a loaded board', () => {
    expect(boardTypeForPath(`${VAULT}/Unknown.board.json`, VAULT, boards, paths)).toBeNull();
    expect(boardTypeForPath(`${VAULT}/Notes.md`, VAULT, boards, paths)).toBeNull();
  });

  it('returns null when the path matches a stored path but no board carries that id', () => {
    expect(boardTypeForPath(`${VAULT}/Kanban.board.json`, VAULT, [board('b1', 'mindmap')], paths)).toBeNull();
  });

  it('falls back to the raw value when the vault root is missing (resolves a relative path)', () => {
    expect(boardTypeForPath('Kanban.board.json', null, boards, paths)).toBe('kanban');
  });
});

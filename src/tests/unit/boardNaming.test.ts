/**
 * A board's name is its `.board.json` file stem: the name rules, where a new
 * board goes, and when its folder follows a rename.
 */
import { describe, it, expect } from 'vitest';
import {
  boardNameFromPath,
  boardNameProblem,
  boardPathIn,
  folderFollowingRename,
  freeBoardName,
  parentFolder,
  plannedBoardPlace,
  renamedFolder,
} from '@renderer/lib/boards/boardNaming';

describe('boardNameFromPath', () => {
  it('is the file name without .board.json, in any folder or case', () => {
    expect(boardNameFromPath('Plan.board.json')).toBe('Plan');
    expect(boardNameFromPath('Work/Q3 Plan/Q3 Plan.board.json')).toBe('Q3 Plan');
    expect(boardNameFromPath('Work\\Plan.BOARD.JSON')).toBe('Plan');
    expect(boardNameFromPath('v1.2.board.json')).toBe('v1.2');
  });
});

describe('boardNameProblem', () => {
  it('accepts an ordinary name, trimmed', () => {
    expect(boardNameProblem('Roadmap 2027')).toBeNull();
    expect(boardNameProblem('  Roadmap  ')).toBeNull();
  });

  it.each([
    ['Q3: plan', '":"'],
    ['a/b', '"/"'],
    ['a\\b', '"\\"'],
    ['what?', '"?"'],
    ['say "hi"', '"""'],
    ['a|b', '"|"'],
    ['a*b', '"*"'],
    ['<x>', '"<"'],
  ])('refuses %s, naming the character', (name, shown) => {
    expect(boardNameProblem(name)).toContain(shown);
  });

  it('refuses a trailing dot, a reserved device name and an empty name', () => {
    expect(boardNameProblem('Draft.')).toMatch(/dot or a space/);
    expect(boardNameProblem('CON')).toMatch(/reserved/);
    expect(boardNameProblem('   ')).toMatch(/required/);
  });
});

describe('plannedBoardPlace', () => {
  it('board folders off: the vault root, no pin', () => {
    expect(plannedBoardPlace('Plan', { boardFolders: false, rootFolder: 'Work' })).toEqual({
      folder: '', path: 'Plan.board.json', defaultFolder: '',
    });
  });

  it('board folders on: a folder named after the board, which is also its pin', () => {
    expect(plannedBoardPlace(' Plan ', { boardFolders: true, rootFolder: '' })).toEqual({
      folder: 'Plan', path: 'Plan/Plan.board.json', defaultFolder: 'Plan',
    });
  });

  it('board folders on: inside the Root Directory when one is set', () => {
    expect(plannedBoardPlace('Plan', { boardFolders: true, rootFolder: '/Work\\Boards/' })).toEqual({
      folder: 'Work/Boards/Plan', path: 'Work/Boards/Plan/Plan.board.json', defaultFolder: 'Work/Boards/Plan',
    });
  });
});

describe('folderFollowingRename', () => {
  it("is the board's folder while it is still named after the board", () => {
    expect(folderFollowingRename('Plan/Plan.board.json', 'Plan', true)).toBe('Plan');
    expect(folderFollowingRename('Work/Plan/Plan.board.json', 'Plan', true)).toBe('Work/Plan');
  });

  it('compares case-folded, as the file system does', () => {
    expect(folderFollowingRename('plan/Plan.board.json', 'Plan', true)).toBe('plan');
  });

  it('leaves a folder the user renamed alone', () => {
    expect(folderFollowingRename('Mine/Plan.board.json', 'Plan', true)).toBeNull();
  });

  it('never moves the vault root, and nothing moves with board folders off', () => {
    expect(folderFollowingRename('Plan.board.json', 'Plan', true)).toBeNull();
    expect(folderFollowingRename('Plan/Plan.board.json', 'Plan', false)).toBeNull();
  });
});

describe('path helpers', () => {
  it('parentFolder, boardPathIn and renamedFolder', () => {
    expect(parentFolder('Work/Plan/Plan.board.json')).toBe('Work/Plan');
    expect(parentFolder('Plan.board.json')).toBe('');
    expect(boardPathIn('', 'Plan')).toBe('Plan.board.json');
    expect(boardPathIn('Work', 'Plan')).toBe('Work/Plan.board.json');
    expect(renamedFolder('Work/Plan', 'Roadmap')).toBe('Work/Roadmap');
    expect(renamedFolder('Plan', 'Roadmap')).toBe('Roadmap');
  });
});

describe('freeBoardName', () => {
  it('is the base when free, else the lowest free number from 2', () => {
    const taken = new Set(['Untitled Board', 'Untitled Board 2', 'Untitled Board 4']);
    expect(freeBoardName('Fresh', (n) => taken.has(n))).toBe('Fresh');
    expect(freeBoardName('Untitled Board', (n) => taken.has(n))).toBe('Untitled Board 3');
  });
});

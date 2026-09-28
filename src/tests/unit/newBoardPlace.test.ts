/**
 * A new board's name as the user types it (`newBoardNameProblem`) and as Filo
 * picks it itself (`freeNewBoardName`): a name the file system refuses, a
 * board file already there in any letter case, and a board the cache holds
 * before the tree lists it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { freeNewBoardName, newBoardNameProblem } from '@renderer/lib/boards/newBoardPlace';
import type { FileTreeNode } from '@shared/types';

const VAULT = '/vault';

function tree(...rels: string[]): void {
  const nodes: FileTreeNode[] = rels.map((rel) => ({
    name: rel.split('/').pop() ?? rel,
    path: `${VAULT}/${rel}`,
    isDirectory: false,
  }));
  vaultStore.setTree(nodes);
}

beforeEach(() => {
  vaultStore.setPath(VAULT);
  boardCacheStore.clear();
  tree();
});

afterEach(() => {
  boardCacheStore.clear();
  vaultStore.setTree([]);
  vaultStore.setPath('');
});

describe('newBoardNameProblem', () => {
  it('a free name is fine', () => {
    tree('Notes.md');
    expect(newBoardNameProblem('Plan')).toBeNull();
  });

  it('refuses a name the file system would refuse, and a reserved Windows name', () => {
    expect(newBoardNameProblem('a:b')).toBe('Names can\'t contain ":".');
    expect(newBoardNameProblem('   ')).toBe('A name is required.');
    expect(newBoardNameProblem('CON')).toBe('"CON" is reserved by Windows.');
  });

  it('refuses a board file already there, in any letter case', () => {
    tree('Plan.board.json');
    expect(newBoardNameProblem('Plan')).toBe('A board named "Plan" already exists.');
    expect(newBoardNameProblem('plan')).toBe('A board named "plan" already exists.');
  });

  it('refuses a board the cache holds before the tree lists its file', () => {
    boardCacheStore.hydrate({}, { b1: 'Fresh.board.json' });
    expect(newBoardNameProblem('Fresh')).toBe('A board named "Fresh" already exists.');
  });

  it("a typed name is only refused in its own folder: another folder's board is no clash", () => {
    tree('Work/Plan.board.json');
    boardCacheStore.hydrate({}, { b1: 'Work/Plan.board.json' });
    expect(newBoardNameProblem('Plan')).toBeNull();
  });
});

describe('freeNewBoardName', () => {
  it('keeps the base name when it is free', () => {
    expect(freeNewBoardName('Kanban')).toBe('Kanban');
  });

  it('counts past every taken name', () => {
    tree('Kanban.board.json', 'kanban 2.board.json');
    expect(freeNewBoardName('Kanban')).toBe('Kanban 3');
  });

  it("skips a name another board has anywhere in the vault", () => {
    tree('Work/Plan.board.json');
    boardCacheStore.hydrate({}, { b1: 'Work/Plan.board.json' });
    expect(freeNewBoardName('Plan')).toBe('Plan 2');
  });
});

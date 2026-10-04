/**
 * A new board's name as the user types it (`newBoardNameProblem`) and as Filo
 * picks it itself (`freeNewBoardName`): a name the file system refuses, a
 * board file already there in any letter case, and a board the cache holds
 * before the tree lists it. With board-specific folders on, a typed name and
 * a rename (`boardRenameProblem`) must be free in the whole vault.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardRenameProblem } from '@renderer/stores/boardIdentity';
import { freeNewBoardName, newBoardNameProblem } from '@renderer/lib/boards/newBoardPlace';
import { ProjectSettingsSchema } from '@renderer/schema/settings';
import type { Project } from '@renderer/schema/index';
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
  vi.restoreAllMocks();
  boardCacheStore.clear();
  vaultStore.setTree([]);
  vaultStore.setPath('');
});

function withBoardFolders(on: boolean): void {
  const settings = ProjectSettingsSchema.parse({});
  settings.general.boardFolders = on;
  vi.spyOn(vaultStore, 'project', 'get').mockReturnValue({ vaultPath: VAULT, settings, boards: [] } as unknown as Project);
}

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

describe('with board-specific folders on', () => {
  beforeEach(() => {
    tree('Kanban 1/Kanban 1.board.json', 'Mine/Plan.board.json', 'Kanban 2/Kanban 2.board.json');
    boardCacheStore.hydrate({}, {
      k1: 'Kanban 1/Kanban 1.board.json',
      plan: 'Mine/Plan.board.json',
      k2: 'Kanban 2/Kanban 2.board.json',
    });
  });

  it("a typed new board name is refused when a board anywhere in the vault has it", () => {
    withBoardFolders(true);
    expect(newBoardNameProblem('plan')).toBe('A board named "plan" already exists in "Mine".');
    expect(newBoardNameProblem('Roadmap')).toBeNull();
  });

  it("a rename to another board's name is refused, wherever that board is", () => {
    withBoardFolders(true);
    expect(boardRenameProblem('k2', 'Kanban 1')).toBe('A board named "Kanban 1" already exists in "Kanban 1".');
    expect(boardRenameProblem('k2', 'PLAN')).toBe('A board named "PLAN" already exists in "Mine".');
    expect(boardRenameProblem('k2', 'Roadmap')).toBeNull();
  });

  it('a rename to its own name in another letter case is no clash', () => {
    withBoardFolders(true);
    expect(boardRenameProblem('k2', 'kanban 2')).toBeNull();
  });

  it('with them off, only a board in the same folder counts', () => {
    withBoardFolders(false);
    expect(boardRenameProblem('k2', 'Kanban 1')).toBeNull();
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

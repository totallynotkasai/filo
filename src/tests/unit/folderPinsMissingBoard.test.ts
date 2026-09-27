/**
 * A board's folder pin is cleared when its folder is gone, except while the
 * board's own `.board.json` is missing too: then the board is only
 * provisionally missing (its folder renamed in Explorer, the rename not yet
 * paired), and clearing the pin gave it a false unsaved change, a "moved or
 * deleted with unsaved changes" prompt, and a duplicate board if the user
 * chose "Save at original location".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { clearPinsOfMissingFolders } from '@renderer/lib/vault/folderPins';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { FileTreeNode } from '@shared/types';

function board(id: string, defaultFolder: string): BoardFileData {
  return {
    board: {
      id, type: 'kanban', name: id, emoji: '', createdAt: 0, updatedAt: 0,
      settings: { defaultFolder }, columns: [],
    },
    tileDefs: {},
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
}

function file(rel: string): FileTreeNode {
  return { name: rel.split('/').pop() ?? rel, path: `/vault/${rel}`, isDirectory: false } as FileTreeNode;
}

const pin = (id: string): string =>
  ((boardCacheStore.cache[id]?.board as { settings?: { defaultFolder?: string } }).settings?.defaultFolder) ?? '';

describe('clearing folder pins whose folder is gone', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.hydrate(
      { here: board('here', 'Gone'), away: board('away', 'Gone') },
      { here: 'Here.board.json', away: 'Away.board.json' },
    );
  });
  afterEach(() => {
    boardCacheStore.clear();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
  });

  it("clears the pin of a board whose file is there, keeps the pin of a board whose file is missing too", () => {
    clearPinsOfMissingFolders([file('Here.board.json')], '/vault', undefined, () => {});
    expect(pin('here')).toBe('');
    expect(pin('away')).toBe('Gone');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pinIsUnder, rebasePin, folderMoveOfFileRename } from '@renderer/lib/vault/folderPinPaths';
import { folderMovesBetween } from '@renderer/lib/vault/treeFolderMoves';
import { noteFolderMoves, takeFolderMoves } from '@renderer/lib/vault/unreconciledFolderMoves';
import { markRecentSelfWrite } from '@renderer/lib/boards/writeStateTracking';
import { repairRenameCascade } from '@renderer/lib/vault/renameCascadeRepair';
import { __resetRenameCascadeSentinelForTests, type RenameCascadeEntry } from '@renderer/lib/vault/renameCascadeSentinel';
import { captureVaultIdentity } from '@renderer/lib/vault/vaultIdentity';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { UpdateBoardSettingsCommand } from '@renderer/commands/index';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Project } from '@renderer/schema/index';
import type { FileTreeNode } from '@shared/types';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Folder pins (the Root Directory and each board's `defaultFolder`) follow
 * their folder when it is renamed, case-folded, including when another
 * program renames it and when crash recovery replays the rename.
 */

function boardWithPin(boardId: string, defaultFolder: string): BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { defaultFolder },
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function pinOf(boardId: string): string | undefined {
  return (boardCacheStore.cache[boardId].board as { settings?: { defaultFolder?: string } }).settings?.defaultFolder;
}

const ROOT = 'C:/vault';

function dir(rel: string, children: FileTreeNode[]): FileTreeNode {
  return { name: rel.split('/').pop() ?? rel, path: `${ROOT}/${rel}`, isDirectory: true, children };
}

function file(rel: string, sizeBytes = 10): FileTreeNode {
  return { name: rel.split('/').pop() ?? rel, path: `${ROOT}/${rel}`, isDirectory: false, sizeBytes };
}

describe('folder pin path rules', () => {
  it('a pin is under a folder whatever the spelling, and only on a segment boundary', () => {
    expect(pinIsUnder('Notes', 'notes')).toBe(true);
    expect(pinIsUnder('Notes/Daily', 'NOTES')).toBe(true);
    expect(pinIsUnder('Notes2', 'Notes')).toBe(false);
    expect(pinIsUnder('Notes', '')).toBe(false);
  });

  it('rebases the pin onto the new folder, keeping its own remainder; clears it for a delete', () => {
    expect(rebasePin('notes/Daily', 'Notes', 'Journal')).toBe('Journal/Daily');
    expect(rebasePin('Notes', 'Notes', '')).toBe('');
    expect(rebasePin('Other', 'Notes', 'Journal')).toBeNull();
  });

  it('reads the folder move off a file rename, and nothing off a plain file rename', () => {
    expect(folderMoveOfFileRename('Old/a.md', 'New/a.md')).toEqual({ oldFolder: 'Old', newFolder: 'New' });
    expect(folderMoveOfFileRename('P/Old/sub/x.md', 'P/New/sub/x.md')).toEqual({ oldFolder: 'P/Old', newFolder: 'P/New' });
    expect(folderMoveOfFileRename('Old/a.md', 'Old/b.md')).toBeNull();
    expect(folderMoveOfFileRename('a.md', 'New/a.md')).toBeNull();
  });
});

describe('folderMovesBetween (a folder renamed by another program, seen as two tree reads)', () => {
  it('pairs the folder that left with the one that arrived holding the same files', () => {
    const before = [dir('Old', [file('Old/a.md'), dir('Old/sub', [file('Old/sub/b.png', 99)])]), file('Keep.md')];
    const after = [dir('New', [file('New/a.md'), dir('New/sub', [file('New/sub/b.png', 99)])]), file('Keep.md')];
    expect(folderMovesBetween(before, after, ROOT)).toEqual([{ oldFolder: 'Old', newFolder: 'New' }]);
  });

  it('finds a move into another folder', () => {
    const before = [dir('Old', [file('Old/a.md')]), dir('Archive', [])];
    const after = [dir('Archive', [dir('Archive/Old', [file('Archive/Old/a.md')])])];
    expect(folderMovesBetween(before, after, ROOT)).toEqual([{ oldFolder: 'Old', newFolder: 'Archive/Old' }]);
  });

  it('pairs nothing for a delete, an empty folder, different contents, or an ambiguous match', () => {
    expect(folderMovesBetween([dir('Old', [file('Old/a.md')])], [], ROOT)).toEqual([]);
    expect(folderMovesBetween([dir('Old', [])], [dir('New', [])], ROOT)).toEqual([]);
    expect(folderMovesBetween([dir('Old', [file('Old/a.md', 1)])], [dir('New', [file('New/a.md', 2)])], ROOT)).toEqual([]);
    const two = [dir('A', [file('A/x.md')]), dir('B', [file('B/x.md')])];
    expect(folderMovesBetween(two, [dir('C', [file('C/x.md')])], ROOT)).toEqual([]);
  });
});

describe('folder moves noted by any tree read', () => {
  it('keeps a move until the reconcile takes it, and skips a move Filo made itself', () => {
    takeFolderMoves([], ROOT);
    noteFolderMoves([dir('Old', [file('Old/a.md')])], [dir('New', [file('New/a.md')])], ROOT);
    markRecentSelfWrite('Mine');
    markRecentSelfWrite('Renamed');
    noteFolderMoves([dir('Mine', [file('Mine/b.md')])], [dir('Renamed', [file('Renamed/b.md')])], ROOT);
    const now = [dir('New', [file('New/a.md')]), dir('Renamed', [file('Renamed/b.md')])];
    expect(takeFolderMoves(now, ROOT)).toEqual([{ oldFolder: 'Old', newFolder: 'New' }]);
    expect(takeFolderMoves(now, ROOT)).toEqual([]);
  });

  it('drops a noted move that no longer holds when the reconcile takes it', () => {
    takeFolderMoves([], ROOT);
    noteFolderMoves([dir('Old', [file('Old/a.md')])], [dir('New', [file('New/a.md')])], ROOT);
    noteFolderMoves([dir('Left', [file('Left/b.md')])], [dir('Right', [file('Right/b.md')])], ROOT);
    noteFolderMoves([dir('Gone', [file('Gone/c.md')])], [dir('Went', [file('Went/c.md')])], ROOT);
    // Old was moved back; Right moved on elsewhere; Gone → Went still holds.
    const now = [dir('Old', [file('Old/a.md')]), dir('Elsewhere', [file('Elsewhere/b.md')]), dir('Went', [file('Went/c.md')])];
    expect(takeFolderMoves(now, ROOT)).toEqual([{ oldFolder: 'Gone', newFolder: 'Went' }]);
  });
});

describe('clearBoardDefaultFolderIfMatches', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });
  afterEach(() => {
    boardCacheStore.clear();
    vaultStore.setPath('');
  });

  it('matches a pin case-folded, for a rename and for a delete', () => {
    boardCacheStore.hydrate(
      { a: boardWithPin('a', 'Notes'), b: boardWithPin('b', 'notes/Daily'), c: boardWithPin('c', 'Notes2') },
      { a: 'a.board.json', b: 'b.board.json', c: 'c.board.json' },
    );
    expect(boardStore.clearBoardDefaultFolderIfMatches('NOTES', 'Journal').sort()).toEqual(['a', 'b']);
    expect(pinOf('a')).toBe('Journal');
    expect(pinOf('b')).toBe('Journal/Daily');
    expect(pinOf('c')).toBe('Notes2');

    expect(boardStore.clearBoardDefaultFolderIfMatches('journal')).toEqual(['a', 'b']);
    expect(pinOf('a')).toBe('');
  });
});

describe("a board-settings undo holding a board's folder follows a rename", () => {
  it('defaultFolder is a path field', () => {
    const cmd = new UpdateBoardSettingsCommand({ defaultFolder: 'Old/Sub' }, { defaultFolder: 'Old' }, [], 'pin', 'b1');
    cmd.renamePath('Old', 'New');
    const held = cmd as unknown as { patch: { defaultFolder: string }; inversePatch: { defaultFolder: string } };
    expect(held.patch.defaultFolder).toBe('New/Sub');
    expect(held.inversePatch.defaultFolder).toBe('New');
  });
});

function ctxWith(general: { activeRootFolder?: string }, markMetaDirty: () => void = () => {}): VaultContext {
  const project = { settings: { general } } as unknown as Project;
  return {
    getVaultPath: () => '/vault',
    setVaultPath: () => {},
    getFileTree: () => [],
    setFileTree: () => {},
    getSearchQuery: () => '',
    setSearchQuery: () => {},
    getIsLoading: () => false,
    setIsLoading: () => {},
    getExpandedFolders: () => new Set(),
    setExpandedFolders: () => {},
    getSelectedPaths: () => new Set(),
    setSelectedPaths: () => {},
    getProject: () => project,
    setProject: () => {},
    getRecoveryPendingPaths: () => [],
    setRecoveryPendingPaths: () => {},
    resolveRecoveryDismissed: () => {},
    markMetaDirty,
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

describe('a per-file rename from another program reveals a pinned folder move', () => {
  const SENTINEL = '.filo/rename-cascade-pending.a1b2c3d4e5f6.json';
  let exists: Set<string>;
  let sentinelWrites: string[];

  beforeEach(() => {
    noteStore.__resetForTests();
    boardCacheStore.clear();
    vaultStore.setPath('/vault');
    __resetRenameCascadeSentinelForTests();
    exists = new Set();
    sentinelWrites = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:file-exists') return exists.has(String(args[1]));
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      if (channel === 'vault:write-file-text' && args[1] === SENTINEL) sentinelWrites.push(String(args[2]));
      return { success: true };
    });
  });
  afterEach(() => {
    restoreFiloDefault();
    boardCacheStore.clear();
    noteStore.__resetForTests();
    vaultStore.setPath('');
    __resetRenameCascadeSentinelForTests();
    vi.restoreAllMocks();
  });

  it('moves the pins and records the folder move for recovery when the old folder is gone', async () => {
    boardCacheStore.hydrate({ a: boardWithPin('a', 'Old/Sub') }, { a: 'a.board.json' });
    const general = { activeRootFolder: 'old' };
    let dirty = 0;
    const slice = makeExternalChangesSlice(ctxWith(general, () => { dirty += 1; }));
    exists.add('New');

    await slice.handleExternalRename('Old/a.md', 'New/a.md');

    expect(general.activeRootFolder).toBe('New');
    expect(dirty).toBeGreaterThan(0);
    expect(pinOf('a')).toBe('New/Sub');
    const entries = sentinelWrites.flatMap((w) => (JSON.parse(w) as { entries: RenameCascadeEntry[] }).entries);
    expect(entries.some((e) => e.oldPath === 'Old' && e.newPath === 'New' && e.affectedBoardIds.includes('a'))).toBe(true);
  });

  it('leaves the pins alone when one file moved between two folders that both remain', async () => {
    boardCacheStore.hydrate({ a: boardWithPin('a', 'Old') }, { a: 'a.board.json' });
    const general = { activeRootFolder: 'Old' };
    const slice = makeExternalChangesSlice(ctxWith(general));
    exists.add('Old');
    exists.add('New');

    await slice.handleExternalRename('Old/a.md', 'New/a.md');

    expect(general.activeRootFolder).toBe('Old');
    expect(pinOf('a')).toBe('Old');
  });
});

describe('crash recovery replays the pin moves', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:file-exists') return String(args[1]) === 'New';
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      return { success: true };
    });
  });
  afterEach(() => {
    restoreFiloDefault();
    boardCacheStore.clear();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  it("re-points a board's folder pin and counts the board as repaired", async () => {
    boardCacheStore.hydrate({ a: boardWithPin('a', 'Old/Sub') }, { a: 'a.board.json' });
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue(undefined);
    vi.spyOn(boardCacheStore, 'flushAllDirty').mockResolvedValue({ failed: [] });
    vi.spyOn(fileTagsStore, 'flushPendingSave').mockResolvedValue({ ok: true });
    const entries: RenameCascadeEntry[] = [
      { id: 'e1', timestamp: 1, oldPath: 'Old', newPath: 'New', affectedBoardIds: ['a'] },
    ];

    const repaired = await repairRenameCascade(entries, '/vault', 'Retry', captureVaultIdentity());

    expect(pinOf('a')).toBe('New/Sub');
    expect(repaired).toBe(1);
  });
});

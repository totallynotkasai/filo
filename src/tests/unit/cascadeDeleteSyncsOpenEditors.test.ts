import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * `CascadeDeleteCommand.undo` writes each deleted note's captured bytes back.
 * An editor still mounted on that note (the delete arrived while it was open,
 * or the undo races a tab reopen) must follow the restored bytes: if it kept
 * its pre-delete body, its next save would silently revert the restore.
 */

function makeMindMap(boardId: string, tileId: string, filePath: string): V7BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        [tileId]: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      [tileId]: {
        id: tileId,
        type: 'text',
        title: 'T',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        boardId,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
        filePath,
      },
    },
    connections: {},
    frames: [],
  };
}

describe('CascadeDeleteCommand.undo — open editors follow the restored note', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'Notes.md': '---\ntitle: Notes\n---\nstale pre-delete body\n' });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('an open editor shows the restored body, and its next save builds on it', async () => {
    const relPath = 'Notes.md';
    const restoredBytes = '---\ntitle: Notes\n---\nrestored body\n';

    const boardData = makeMindMap('board-1', 't_1', relPath);
    boardCacheStore.hydrate({ 'board-1': boardData }, { 'board-1': 'board-1.board.json' });
    boardStore.setBoard(boardData.board, boardCacheStore.getFullTilesForBoard('board-1'), {}, []);

    // The editor is mounted, holding the pre-delete body; the file goes away.
    const m = noteStore.acquire(relPath, 'text-tile:t_1');
    await m.loaded;
    expect(m.body).toBe('stale pre-delete body\n');
    vault.remove(relPath);
    await noteStore.onDiskChanged(relPath);
    expect(m.status).toBe('missing');

    const cmd = new CascadeDeleteCommand(
      { 'board-1': Object.values(boardData.tileDefs) },
      [],
      { [relPath]: restoredBytes },
      '/vault',
    );
    cmd.execute();
    await cmd.undo();

    expect(vault.read(relPath)).toBe(restoredBytes);
    expect(m.status).toBe('ready');
    expect(m.body).toBe('restored body\n');
    expect(m.frontmatter).toEqual({ title: 'Notes' });

    // Our own restore coming back through the watcher changes nothing.
    await noteStore.onDiskChanged(relPath);
    expect(m.body).toBe('restored body\n');

    // The editor's next keystroke lands on the restored file.
    noteStore.setBody(relPath, 'restored body, edited', 'text-tile:t_1');
    await noteStore.flush(relPath);
    expect(vault.read(relPath)).toBe('---\ntitle: Notes\n---\nrestored body, edited\n');
  });

  it('restores the bytes when no editor is open on the file', async () => {
    const relPath = 'Orphan.md';
    const restoredBytes = '---\ntitle: Orphan\n---\norphan body\n';

    const boardData = makeMindMap('board-2', 't_2', relPath);
    boardCacheStore.hydrate({ 'board-2': boardData }, { 'board-2': 'board-2.board.json' });
    boardStore.setBoard(boardData.board, boardCacheStore.getFullTilesForBoard('board-2'), {}, []);

    const cmd = new CascadeDeleteCommand(
      { 'board-2': Object.values(boardData.tileDefs) },
      [],
      { [relPath]: restoredBytes },
      '/vault',
    );
    cmd.execute();
    await expect(cmd.undo()).resolves.toBeUndefined();
    expect(vault.read(relPath)).toBe(restoredBytes);
    expect(noteStore.get(relPath)).toBeUndefined();
  });
});

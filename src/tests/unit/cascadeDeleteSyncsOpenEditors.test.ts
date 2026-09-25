import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import { trashFiles } from '@renderer/commands/trashedFiles';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile } from '@renderer/schema/index';

/**
 * `CascadeDeleteCommand.undo` moves each deleted note back from Filo's trash.
 * An editor still mounted on that note (the delete arrived while it was open,
 * or the undo races a tab reopen) must follow the restored file: if it kept
 * the body it held before the delete, its next save would silently revert
 * whatever the file really contained.
 */

function makeMindMap(boardId: string, tileId: string, filePath: string): BoardFileData {
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
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: 0,
        updatedAt: 0,
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
    // The trash moves drain the board writer first; the memory vault has no
    // `.board.json` channel, so a board save must succeed here.
    const base = window.filo.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>;
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      if (channel === 'board:save') return { success: true };
      return base(channel, ...args);
    }) as typeof window.filo.invoke;
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
    const tiles = boardCacheStore.getFullTilesForBoard('board-1');
    boardStore.setBoard(boardData.board, tiles, {}, []);

    // The editor is mounted, holding a body the file no longer has by the
    // time it is deleted (another program changed it unseen).
    const m = noteStore.acquire(relPath, 'text-tile:t_1');
    await m.loaded;
    expect(m.body).toBe('stale pre-delete body\n');
    vault.writeExternally(relPath, restoredBytes);

    const [trashed] = await trashFiles('/vault', [relPath], 'test');
    expect(trashed).toBeDefined();
    expect(vault.read(relPath)).toBeUndefined();
    expect(m.status).toBe('missing');

    const byBoard: Record<string, Tile[]> = { 'board-1': Object.values(tiles) };
    const cmd = new CascadeDeleteCommand(byBoard, [], { vaultRoot: '/vault', trashed });
    await cmd.execute();
    await cmd.undo();
    await m.loaded;

    expect(vault.read(relPath)).toBe(restoredBytes);
    expect(m.status).toBe('ready');
    expect(m.body).toBe('restored body\n');
    expect(m.frontmatter).toEqual({ title: 'Notes' });

    // The restore itself coming back through the watcher changes nothing.
    await noteStore.onDiskChanged(relPath);
    expect(m.body).toBe('restored body\n');

    // The editor's next keystroke lands on the restored file.
    noteStore.setBody(relPath, 'restored body, edited', 'text-tile:t_1');
    await noteStore.flush(relPath);
    expect(vault.read(relPath)).toBe('---\ntitle: Notes\n---\nrestored body, edited\n');
  });

  it('restores the bytes when no editor is open on the file', async () => {
    const relPath = 'Orphan.md';
    const bytes = '---\ntitle: Orphan\n---\norphan body\n';
    vault.writeExternally(relPath, bytes);

    const boardData = makeMindMap('board-2', 't_2', relPath);
    boardCacheStore.hydrate({ 'board-2': boardData }, { 'board-2': 'board-2.board.json' });
    const tiles = boardCacheStore.getFullTilesForBoard('board-2');
    boardStore.setBoard(boardData.board, tiles, {}, []);

    const [trashed] = await trashFiles('/vault', [relPath], 'test');
    const cmd = new CascadeDeleteCommand({ 'board-2': Object.values(tiles) }, [], { vaultRoot: '/vault', trashed });
    await cmd.execute();
    await expect(cmd.undo()).resolves.toBeUndefined();
    expect(vault.read(relPath)).toBe(bytes);
    expect(noteStore.get(relPath)).toBeUndefined();
  });
});

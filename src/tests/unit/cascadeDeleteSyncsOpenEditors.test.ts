import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import { markHydrated, cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Phase 6.1.R1 — `CascadeDeleteCommand.undo` syncs open editors with the
 * restored file body.
 *
 * The cascade resurrected a file by writing its captured snapshot back via
 * `vault:write-file-text`. If an editor is still mounted on that file (the
 * delete fired through an external watcher while the editor was open, or
 * the undo races a tab reopen), the editor keeps its pre-delete in-memory
 * body. Without the sync, the next debounced write would carry that body
 * and silently revert the restored bytes. The fix routes the restored
 * (path, content) pairs through `syncOpenEditorsAfterDiskMutation`, which
 * goes through `applyReloadFromDisk` (self-cancelling per 6.0.C2).
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

describe('CascadeDeleteCommand.undo — syncs open editors (Phase 6.1.R1)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string) => {
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
      return { ok: true, success: true };
    });
  });

  afterEach(() => {
    cancelAllMarkdownWrites();
    __resetDirtyTrackingForTests();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it("syncs an open editor with the restored file body on undo", async () => {
    const relPath = 'Notes.md';
    const restoredBytes = '---\ntitle: Notes\n---\nrestored body\n';

    // Seed a cache so the cascade has something to undo against.
    const boardData = makeMindMap('board-1', 't_1', relPath);
    boardCacheStore.hydrate({ 'board-1': boardData }, { 'board-1': 'board-1.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('board-1');
    boardStore.setBoard(boardData.board, tilesA, {}, []);

    // Editor is still mounted, holding stale pre-delete in-memory body.
    documentStore.loadDocument({
      filename: relPath,
      title: 'Notes',
      body: 'stale pre-delete body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(relPath, { title: 'Notes' }, '---\ntitle: Notes\n---');
    markHydrated(relPath, false);

    // Capture the cascade in mid-state then undo.
    const tiles = Object.values(boardData.tileDefs);
    const cmd = new CascadeDeleteCommand(
      { 'board-1': tiles },
      [],
      { [relPath]: restoredBytes },
      '/vault',
    );
    cmd.execute();
    await cmd.undo();

    // Phase 6.1.R1 — the editor MUST reflect the restored bytes.
    const doc = documentStore.getDocument(relPath);
    expect(doc?.body).toBe('restored body\n');
    const fm = documentStore.getFrontmatter(relPath);
    expect(fm).toEqual({ title: 'Notes' });
  });

  it("is a no-op when no editor is open on the restored file", async () => {
    const relPath = 'Orphan.md';
    const restoredBytes = '---\ntitle: Orphan\n---\norphan body\n';

    const boardData = makeMindMap('board-2', 't_2', relPath);
    boardCacheStore.hydrate({ 'board-2': boardData }, { 'board-2': 'board-2.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('board-2');
    boardStore.setBoard(boardData.board, tilesA, {}, []);

    const tiles = Object.values(boardData.tileDefs);
    const cmd = new CascadeDeleteCommand(
      { 'board-2': tiles },
      [],
      { [relPath]: restoredBytes },
      '/vault',
    );
    cmd.execute();
    // No editor exists for relPath; the helper inside undo() must not throw.
    await expect(cmd.undo()).resolves.toBeUndefined();
  });
});

/**
 * Phase A.4 — `RenameTitleCommand.undo` must NOT mark the document
 * dirty.
 *
 * The forward rename surface (TileHeader / TaskListBoard) marks the doc
 * dirty via `documentStore.updateTitle` so the markdown writer flushes
 * the user's title change. Undo / redo reverse the title — but the
 * BODY is unchanged. Flipping `isDirty: true` from inside undo would
 * queue the markdown writer to write the in-memory body (potentially
 * stale after external edits during the rename window) back to the
 * freshly-renamed-back file — silently overwriting external changes.
 *
 * The fix adds `updateTitleClean(docId, title)` to documentStore: same
 * shape as `updateTitle` but preserves the current dirty flag.
 * `RenameTitleCommand.applyRename` now routes through the clean variant
 * since undo/redo only touch the title.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { RenameTitleCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TextTile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function installRenameStub(): void {
  installFiloMock({
    'vault:rename': () => ({ success: true }),
    'vault:file-exists': () => false,
    'vault:read-tree': () => ({ ok: true, tree: [] }),
  });
}

function makeTextTile(): TextTile {
  return {
    id: 't1',
    boardId: 'mm',
    type: 'text',
    title: 'Old',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    tags: [],
    locked: false,
    faded: false,
    contentId: 'doc-1',
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TextTile;
}

function activate(tile: TextTile): void {
  const fixture: V7BoardFileData = {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'M',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        [tile.id]: {
          id: tile.id,
          tileId: tile.id,
          position: tile.position,
          size: tile.size,
        },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      [tile.id]: {
        id: tile.id,
        type: 'text',
        title: tile.title,
        style: tile.style ?? {},
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        contentId: tile.contentId,
      } as unknown as V7BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
  boardStore.setBoard(fixture.board, { [tile.id]: tile }, {}, []);
}

describe('RenameTitleCommand.undo — clean dirty flag (Phase A.4)', () => {
  beforeEach(() => {
    installRenameStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('clean doc stays clean after undo', async () => {
    const tile = makeTextTile();
    activate(tile);

    documentStore.loadDocument({
      docId: 'doc-1',
      filename: 'New.md',
      title: 'New',
      body: 'Body content',
      htmlContent: '',
      richText: [],
    });
    // Doc was clean before the rename.
    expect(documentStore.getDocument('doc-1')?.isDirty).toBe(false);

    const cmd = new RenameTitleCommand(
      't1',
      'Old',
      'New',
      undefined,
      undefined,
      { oldPath: 'Old.md', newPath: 'New.md' },
      { boardId: null, contentId: 'doc-1' },
    );

    await cmd.undo();

    // Title reverted, filename reverted, BUT dirty flag stayed clean.
    expect(documentStore.getDocument('doc-1')?.title).toBe('Old');
    expect(documentStore.getDocument('doc-1')?.filename).toBe('Old.md');
    expect(documentStore.getDocument('doc-1')?.isDirty).toBe(false);
  });

  it('redo (execute) likewise preserves dirty flag', async () => {
    const tile = makeTextTile();
    activate(tile);

    documentStore.loadDocument({
      docId: 'doc-1',
      filename: 'Old.md',
      title: 'Old',
      body: 'Body content',
      htmlContent: '',
      richText: [],
    });
    // Pre-redo: doc is clean.
    expect(documentStore.getDocument('doc-1')?.isDirty).toBe(false);

    const cmd = new RenameTitleCommand(
      't1',
      'Old',
      'New',
      undefined,
      undefined,
      { oldPath: 'Old.md', newPath: 'New.md' },
      { boardId: null, contentId: 'doc-1' },
    );

    await cmd.execute();

    expect(documentStore.getDocument('doc-1')?.title).toBe('New');
    expect(documentStore.getDocument('doc-1')?.filename).toBe('New.md');
    // execute is also undoable-history-only — must not dirty the body.
    expect(documentStore.getDocument('doc-1')?.isDirty).toBe(false);
  });

  it('already-dirty doc keeps its dirty flag after undo (does not silently clean)', async () => {
    const tile = makeTextTile();
    activate(tile);

    documentStore.loadDocument({
      docId: 'doc-1',
      filename: 'New.md',
      title: 'New',
      body: 'Body content',
      htmlContent: '',
      richText: [],
    });
    // User edited the body between rename and undo.
    documentStore.markDirty('doc-1');
    expect(documentStore.getDocument('doc-1')?.isDirty).toBe(true);

    const cmd = new RenameTitleCommand(
      't1',
      'Old',
      'New',
      undefined,
      undefined,
      { oldPath: 'Old.md', newPath: 'New.md' },
      { boardId: null, contentId: 'doc-1' },
    );

    await cmd.undo();

    // Title reverted; the user's body edit is still pending a flush.
    expect(documentStore.getDocument('doc-1')?.title).toBe('Old');
    expect(documentStore.getDocument('doc-1')?.isDirty).toBe(true);
  });
});

/**
 * D.3 — `UpdateTilePathCommand` runs `vaultStore.refreshTree()` on both
 * execute and undo so the broken-ref badge updates immediately after a
 * relink (the tree itself hasn't changed, but `recomputeBrokenRefs` runs
 * inside refreshTree against the current snapshot).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UpdateTilePathCommand } from '@renderer/commands/index';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TextTile } from '@renderer/schema/index';

function setupTile(): void {
  const tile: TextTile = {
    id: 't1',
    boardId: 'mm',
    type: 'text',
    title: 'Notes',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    tags: [],
    locked: false,
    faded: false,
    contentId: 'doc-1',
    filePath: 'Old.md',
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TextTile;
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
        filePath: 'Old.md',
      } as unknown as V7BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
  boardStore.setBoard(fixture.board, { [tile.id]: tile }, {}, []);
}

describe('UpdateTilePathCommand — refresh tree on relink', () => {
  let readTreeCalls: number;

  beforeEach(() => {
    readTreeCalls = 0;
    installFiloMock({
      'vault:read-tree': () => {
        readTreeCalls += 1;
        return { ok: true, tree: [] };
      },
    });
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    setupTile();
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute() refreshes the tree so broken-ref recompute runs', async () => {
    const cmd = new UpdateTilePathCommand('t1', 'Old.md', 'New.md');
    const before = readTreeCalls;
    await cmd.execute();

    expect(boardStore.getTile('t1')?.type).toBe('text');
    expect((boardStore.getTile('t1') as { filePath?: string }).filePath).toBe(
      'New.md',
    );
    expect(readTreeCalls).toBeGreaterThan(before);
  });

  it('undo() refreshes the tree so broken-ref recompute runs', async () => {
    const cmd = new UpdateTilePathCommand('t1', 'Old.md', 'New.md');
    await cmd.execute();
    const beforeUndo = readTreeCalls;
    await cmd.undo();

    expect((boardStore.getTile('t1') as { filePath?: string }).filePath).toBe(
      'Old.md',
    );
    expect(readTreeCalls).toBeGreaterThan(beforeUndo);
  });
});

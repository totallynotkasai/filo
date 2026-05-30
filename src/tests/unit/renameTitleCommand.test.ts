/**
 * Phase 5 / 5.6 — RenameTitleCommand regression guard.
 *
 * Rename a tile via TileHeader → Ctrl+Z restores filename and title.
 * The command is symmetric: redo (execute) renames forward; undo renames
 * backward. Non-text tiles skip the file rename and only restore titles.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { RenameTitleCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TextTile, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

interface FiloRecorder {
  calls: Array<{ channel: string; args: unknown[] }>;
}

function installRecorder(): FiloRecorder {
  const calls: FiloRecorder['calls'] = [];
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    calls.push({ channel: channel as string, args });
    if (channel === 'vault:rename') return { success: true };
    if (channel === 'vault:file-exists') return false;
    if (channel === 'vault:read-tree') return { ok: true, tree: [] };
    return undefined;
  });
  return { calls };
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

function activate(tile: Tile): void {
  const fixture: V7BoardFileData = {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'M',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: { [tile.id]: { id: tile.id, tileId: tile.id, position: tile.position, size: tile.size } },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      [tile.id]: {
        id: tile.id,
        type: tile.type,
        title: tile.title,
        style: tile.style ?? {},
        tags: tile.tags ?? [],
        createdAt: 0,
        updatedAt: 0,
        ...(tile.type === 'text' ? { contentId: (tile as TextTile).contentId } : {}),
      } as unknown as V7BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
  boardStore.setBoard(fixture.board, { [tile.id]: tile }, {}, []);
}

describe('RenameTitleCommand', () => {
  let recorder: FiloRecorder;

  beforeEach(() => {
    recorder = installRecorder();
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

  it('undo restores filename and title for text tiles', async () => {
    const tile = makeTextTile();
    activate(tile);
    // Pretend the rename already happened: tile now says "New", on-disk
    // file is at "New.md".
    boardStore.updateTile('t1', { title: 'New' });

    const cmd = new RenameTitleCommand(
      't1',
      'Old',
      'New',
      undefined,
      undefined,
      { oldPath: 'Old.md', newPath: 'New.md' },
    );

    await cmd.undo();
    expect(boardStore.getTile('t1')?.title).toBe('Old');
    const renames = recorder.calls.filter((c) => c.channel === 'vault:rename');
    expect(renames.length).toBe(1);
    // Undo reverses: rename New.md → Old.md
    expect(renames[0].args[1]).toBe('/vault/New.md');
    expect(renames[0].args[2]).toBe('/vault/Old.md');
  });

  it('execute (redo) reapplies the forward rename + title', async () => {
    const tile = makeTextTile();
    activate(tile);

    const cmd = new RenameTitleCommand(
      't1',
      'Old',
      'New',
      undefined,
      undefined,
      { oldPath: 'Old.md', newPath: 'New.md' },
    );

    await cmd.execute();
    expect(boardStore.getTile('t1')?.title).toBe('New');
    const renames = recorder.calls.filter((c) => c.channel === 'vault:rename');
    expect(renames[0].args[1]).toBe('/vault/Old.md');
    expect(renames[0].args[2]).toBe('/vault/New.md');

    await cmd.undo();
    expect(boardStore.getTile('t1')?.title).toBe('Old');
  });

  it('non-text tile: skip vault:rename and only update title', async () => {
    const linkTile: Tile = {
      id: 't1',
      boardId: 'mm',
      type: 'link',
      title: 'OldLink',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      style: { headerColor: '', bodyColor: '', borderColor: '' },
      tags: [],
      locked: false,
      faded: false,
      url: 'https://example.com',
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Tile;
    activate(linkTile);

    const cmd = new RenameTitleCommand('t1', 'OldLink', 'NewLink', undefined, undefined);
    await cmd.execute();
    expect(boardStore.getTile('t1')?.title).toBe('NewLink');
    expect(recorder.calls.find((c) => c.channel === 'vault:rename')).toBeUndefined();

    await cmd.undo();
    expect(boardStore.getTile('t1')?.title).toBe('OldLink');
  });

  it('does not update title when undo vault:rename fails', async () => {
    // Override the recorder so the second rename fails (ENOENT).
    const calls: FiloRecorder['calls'] = [];
    let callIdx = 0;
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      calls.push({ channel: channel as string, args });
      if (channel === 'vault:rename') {
        callIdx++;
        if (callIdx === 1) return { success: true };
        return { success: false, code: 'ENOENT' };
      }
      if (channel === 'vault:file-exists') return false;
      if (channel === 'vault:read-tree') return { ok: true, tree: [] };
      return undefined;
    });
    const tile = makeTextTile();
    activate(tile);

    const cmd = new RenameTitleCommand(
      't1',
      'Old',
      'New',
      undefined,
      undefined,
      { oldPath: 'Old.md', newPath: 'New.md' },
    );
    await cmd.execute();
    expect(boardStore.getTile('t1')?.title).toBe('New');

    await cmd.undo();
    // ENOENT on the reverse rename → title stays at "New" (UI reflects disk).
    expect(boardStore.getTile('t1')?.title).toBe('New');
  });

  it('titleHtml round-trips through undo/redo', async () => {
    const tile = makeTextTile();
    activate(tile);

    const cmd = new RenameTitleCommand(
      't1',
      'Old',
      'New',
      '<p>Old <strong>bold</strong></p>',
      '<p>New</p>',
      { oldPath: 'Old.md', newPath: 'New.md' },
    );

    await cmd.execute();
    expect(boardStore.getTile('t1')?.titleHtml).toBe('<p>New</p>');
    await cmd.undo();
    expect(boardStore.getTile('t1')?.titleHtml).toBe('<p>Old <strong>bold</strong></p>');
  });

  it('description reflects the new title', () => {
    const cmd = new RenameTitleCommand('t1', 'a', 'b', undefined, undefined);
    expect(cmd.description).toBe('Rename to "b"');
  });
});

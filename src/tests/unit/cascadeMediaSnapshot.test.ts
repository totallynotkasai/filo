import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import {
  isCascadeMediaPath,
  TILE_DELETE_MEDIA_SNAPSHOT_MAX_BYTES,
} from '@renderer/lib/canvas/deleteTileSnapshots';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 2 / 2.5 — cascade-delete undo restores captured media bodies
 * (image/video/audio/pdf) up to the 5 MB per-file cap. Verifies:
 *  - The media-extension classifier covers the expected extensions.
 *  - CascadeDeleteCommand stores a separate mediaSnapshots map and
 *    invokes `vault:write-file-binary` on undo for each entry.
 *  - The 5 MB cap is enforced upstream (snapshot walker filter) — tested
 *    via direct cap probe.
 *  - `hasFileSnapshots()` returns true when only media snapshots are
 *    populated so the escalated history-truncation toast surfaces.
 */

function makeMindMapWithImage(boardId: string, tileId: string, src: string): V7BoardFileData {
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
        type: 'image',
        title: 'photo',
        boardId,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
        src,
      },
    },
    connections: {},
    frames: [],
  };
}

describe('isCascadeMediaPath', () => {
  it('returns true for known image extensions', () => {
    expect(isCascadeMediaPath('attachments/hero.png')).toBe(true);
    expect(isCascadeMediaPath('img.jpg')).toBe(true);
    expect(isCascadeMediaPath('img.JPEG')).toBe(true); // case-insensitive
    expect(isCascadeMediaPath('cover.webp')).toBe(true);
    expect(isCascadeMediaPath('shot.heic')).toBe(true);
  });

  it('returns true for video and audio extensions', () => {
    expect(isCascadeMediaPath('clip.mp4')).toBe(true);
    expect(isCascadeMediaPath('demo.webm')).toBe(true);
    expect(isCascadeMediaPath('audio.mp3')).toBe(true);
    expect(isCascadeMediaPath('voice.m4a')).toBe(true);
    expect(isCascadeMediaPath('chord.midi')).toBe(true);
  });

  it('returns true for .pdf', () => {
    expect(isCascadeMediaPath('docs/report.pdf')).toBe(true);
  });

  it('returns false for .md and other text files', () => {
    expect(isCascadeMediaPath('Notes.md')).toBe(false);
    expect(isCascadeMediaPath('config.json')).toBe(false);
    expect(isCascadeMediaPath('script.ts')).toBe(false);
  });

  it('returns false for paths without an extension', () => {
    expect(isCascadeMediaPath('README')).toBe(false);
    expect(isCascadeMediaPath('attachments/hero')).toBe(false);
  });
});

describe('CascadeDeleteCommand — media restore', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
  });

  afterEach(() => {
    restoreFiloDefault();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
  });

  it('writes mediaSnapshots via vault:write-file-binary on undo', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

    const writes: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      return { success: true };
    });

    const tile = tilesA.t_img as Tile;
    const cmd = new CascadeDeleteCommand(
      { a: [tile] },
      [],
      {},
      '/vault',
      { coverImage: {}, frameBackground: {}, boardSettings: {} },
      { 'attachments/hero.png': 'ZmFrZWltYWdlYnl0ZXM=' /* base64 'fakeimagebytes' */ },
    );
    cmd.execute();
    expect(boardStore.getTile('t_img')).toBeUndefined();

    await cmd.undo();
    // Drain any microtask tail.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const binaryWrite = writes.find(
      (w) =>
        w.channel === 'vault:write-file-binary' &&
        w.args[1] === 'attachments/hero.png',
    );
    expect(binaryWrite).toBeDefined();
    expect(binaryWrite?.args[2]).toBe('ZmFrZWltYWdlYnl0ZXM=');
  });

  it('hasFileSnapshots() is true when only mediaSnapshots are present', () => {
    const cmd = new CascadeDeleteCommand(
      {},
      [],
      {}, // no text snapshots
      '/vault',
      { coverImage: {}, frameBackground: {}, boardSettings: {} },
      { 'img.png': 'AAAA' }, // media-only
    );
    expect(cmd.hasFileSnapshots()).toBe(true);
  });

  it('hasFileSnapshots() is false when both snapshot maps are empty', () => {
    const cmd = new CascadeDeleteCommand(
      {},
      [],
      {},
      '/vault',
      { coverImage: {}, frameBackground: {}, boardSettings: {} },
      {},
    );
    expect(cmd.hasFileSnapshots()).toBe(false);
  });

  it('snapshots both text and media in the same cascade', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

    const writes: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      return { success: true };
    });

    const tile = tilesA.t_img as Tile;
    const cmd = new CascadeDeleteCommand(
      { a: [tile] },
      [],
      { 'Notes.md': '# Title\nbody' },
      '/vault',
      { coverImage: {}, frameBackground: {}, boardSettings: {} },
      { 'attachments/hero.png': 'AAAA' },
    );
    cmd.execute();
    await cmd.undo();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const textWrite = writes.find(
      (w) => w.channel === 'vault:write-file-text' && w.args[1] === 'Notes.md',
    );
    const binaryWrite = writes.find(
      (w) =>
        w.channel === 'vault:write-file-binary' &&
        w.args[1] === 'attachments/hero.png',
    );
    expect(textWrite).toBeDefined();
    expect(binaryWrite).toBeDefined();
  });

  it('TILE_DELETE_MEDIA_SNAPSHOT_MAX_BYTES is 5 MB', () => {
    expect(TILE_DELETE_MEDIA_SNAPSHOT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

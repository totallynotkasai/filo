/**
 * Phase 5 / 5.2 — UpdateAttachmentSrcCommand regression guard.
 *
 * One Command class is shared by the six attachment tile types (image,
 * video, audio, file, iframe, link). The clear/replace src actions used
 * to bypass history; the new command makes them undoable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { UpdateAttachmentSrcCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function installSilentBridge(): void {
  installFiloMock(() => null);
}

function makeFixture(tile: Tile): BoardFileData {
  return {
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
        ...(tile as unknown as Record<string, unknown>),
      } as unknown as BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
}

function activate(tile: Tile): void {
  const fixture = makeFixture(tile);
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
  boardStore.setBoard(fixture.board, { [tile.id]: tile }, {}, []);
}

function baseFields(id: string, type: Tile['type']) {
  return {
    id,
    boardId: 'mm',
    type,
    title: id,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 200 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    tags: [],
    locked: false,
    faded: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('UpdateAttachmentSrcCommand', () => {
  beforeEach(() => {
    installSilentBridge();
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

  it('image tile: clear src then undo restores', () => {
    const tile = { ...baseFields('img', 'image'), src: 'attachments/hero.png' } as unknown as Tile;
    activate(tile);

    const cmd = new UpdateAttachmentSrcCommand(
      'img',
      { kind: 'src', src: 'attachments/hero.png' },
      { kind: 'src', src: '' },
      'Clear image',
    );
    cmd.execute();
    expect((boardStore.getTile('img') as unknown as { src: string }).src).toBe('');

    cmd.undo();
    expect((boardStore.getTile('img') as unknown as { src: string }).src).toBe('attachments/hero.png');

    cmd.execute();
    expect((boardStore.getTile('img') as unknown as { src: string }).src).toBe('');
  });

  it('video tile: src-with-playback round-trip', () => {
    const tile = {
      ...baseFields('vid', 'video'),
      src: 'attachments/clip.mp4',
      isPlaying: true,
    } as unknown as Tile;
    activate(tile);

    const cmd = new UpdateAttachmentSrcCommand(
      'vid',
      { kind: 'src-with-playback', src: 'attachments/clip.mp4', isPlaying: true },
      { kind: 'src-with-playback', src: '', isPlaying: false },
    );
    cmd.execute();
    const after = boardStore.getTile('vid') as unknown as { src: string; isPlaying: boolean };
    expect(after.src).toBe('');
    expect(after.isPlaying).toBe(false);

    cmd.undo();
    const restored = boardStore.getTile('vid') as unknown as { src: string; isPlaying: boolean };
    expect(restored.src).toBe('attachments/clip.mp4');
    expect(restored.isPlaying).toBe(true);
  });

  it('audio tile: src-with-playback + recording flag', () => {
    const tile = {
      ...baseFields('aud', 'audio'),
      src: 'attachments/song.webm',
      isPlaying: false,
      isRecording: false,
    } as unknown as Tile;
    activate(tile);

    const cmd = new UpdateAttachmentSrcCommand(
      'aud',
      { kind: 'src-with-playback', src: 'attachments/song.webm', isPlaying: false, isRecording: false },
      { kind: 'src-with-playback', src: '', isPlaying: false, isRecording: false },
    );
    cmd.execute();
    expect((boardStore.getTile('aud') as unknown as { src: string }).src).toBe('');

    cmd.undo();
    expect((boardStore.getTile('aud') as unknown as { src: string }).src).toBe('attachments/song.webm');
  });

  it('file tile: filePath + fileName + fileExtension trio', () => {
    const tile = {
      ...baseFields('fil', 'file'),
      filePath: 'attachments/report.pdf',
      fileName: 'report.pdf',
      fileExtension: 'pdf',
    } as unknown as Tile;
    activate(tile);

    const cmd = new UpdateAttachmentSrcCommand(
      'fil',
      { kind: 'file', filePath: 'attachments/report.pdf', fileName: 'report.pdf', fileExtension: 'pdf' },
      { kind: 'file', filePath: '', fileName: '', fileExtension: '' },
    );
    cmd.execute();
    const after = boardStore.getTile('fil') as unknown as {
      filePath: string; fileName: string; fileExtension: string;
    };
    expect(after.filePath).toBe('');
    expect(after.fileName).toBe('');
    expect(after.fileExtension).toBe('');

    cmd.undo();
    const restored = boardStore.getTile('fil') as unknown as {
      filePath: string; fileName: string; fileExtension: string;
    };
    expect(restored.filePath).toBe('attachments/report.pdf');
    expect(restored.fileName).toBe('report.pdf');
    expect(restored.fileExtension).toBe('pdf');
  });

  it('iframe tile: url round-trip', () => {
    const tile = { ...baseFields('ifr', 'iframe'), url: 'https://example.com' } as unknown as Tile;
    activate(tile);

    const cmd = new UpdateAttachmentSrcCommand(
      'ifr',
      { kind: 'url', url: 'https://example.com' },
      { kind: 'url', url: '' },
    );
    cmd.execute();
    expect((boardStore.getTile('ifr') as unknown as { url: string }).url).toBe('');

    cmd.undo();
    expect((boardStore.getTile('ifr') as unknown as { url: string }).url).toBe('https://example.com');
  });

  it('link tile: url round-trip (and replace, not clear)', () => {
    const tile = { ...baseFields('lnk', 'link'), url: 'https://old.example.com' } as unknown as Tile;
    activate(tile);

    const cmd = new UpdateAttachmentSrcCommand(
      'lnk',
      { kind: 'url', url: 'https://old.example.com' },
      { kind: 'url', url: 'https://new.example.com' },
    );
    cmd.execute();
    expect((boardStore.getTile('lnk') as unknown as { url: string }).url).toBe('https://new.example.com');

    cmd.undo();
    expect((boardStore.getTile('lnk') as unknown as { url: string }).url).toBe('https://old.example.com');
  });

  it('snapshots are deep-cloned so caller-side mutation cannot poison', () => {
    const tile = {
      ...baseFields('img2', 'image'),
      src: 'attachments/a.png',
    } as unknown as Tile;
    activate(tile);

    const before = { kind: 'src' as const, src: 'attachments/a.png' };
    const after = { kind: 'src' as const, src: 'attachments/b.png' };
    const cmd = new UpdateAttachmentSrcCommand('img2', before, after);

    // Mutate caller-side objects.
    before.src = 'poisoned';
    after.src = 'poisoned';

    cmd.execute();
    expect((boardStore.getTile('img2') as unknown as { src: string }).src).toBe('attachments/b.png');
    cmd.undo();
    expect((boardStore.getTile('img2') as unknown as { src: string }).src).toBe('attachments/a.png');
  });
});

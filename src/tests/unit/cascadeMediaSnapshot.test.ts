import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import { seedBoard } from '../helpers/seedBoard';

/**
 * A sidebar delete of a media file, or of a folder holding media, moves it
 * into Filo's trash; Ctrl+Z (the pushed CascadeDeleteCommand) moves it back
 * and restores the image tiles that showed it. Undo never copies the bytes
 * into memory, so there is no size cap: a file far past any in-memory limit
 * comes back exactly as it went.
 */

let vault: MemoryVault;
let channels: string[] = [];

/** Memory vault plus a succeeding `board:save` and an empty tree, recording every channel asked for. */
function installVault(files: Record<string, string>): void {
  vault = installMemoryVault(files);
  channels = [];
  const base = window.filo.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>;
  window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
    channels.push(channel);
    if (channel === 'board:save') return { success: true };
    if (channel === 'vault:read-tree') return { ok: true, tree: [] };
    return base(channel, ...args);
  }) as typeof window.filo.invoke;
}

function makeMindMapWithImage(boardId: string, tileId: string, src: string): BoardFileData {
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
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: 0,
        updatedAt: 0,
        src,
      },
    },
    connections: {},
    frames: [],
  };
}

/** Confirms the delete prompt as soon as it opens. */
async function autoConfirm(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (uiStore.confirmDialog) {
      const cfg = uiStore.confirmDialog;
      uiStore.closeConfirm();
      cfg.onConfirm(false);
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function deleteConfirmed(absPath: string): Promise<boolean> {
  const pending = vaultStore.delete(absPath);
  await autoConfirm();
  return pending;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Well past the old 5 MB per-file / 25 MB per-delete in-memory caps. */
const BIG_VIDEO = 'v'.repeat(30 * 1024 * 1024);
const PHOTO = '\u0089PNG fake image bytes';

describe('sidebar delete of media goes to the trash; undo brings the bytes back', () => {
  beforeEach(() => {
    restoreFiloDefault();
    uiStore.closeConfirm();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    tabStore.closeAll();
    historyStore.clear();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    noteStore.__resetForTests();
    restoreFiloDefault();
    uiStore.closeConfirm();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    tabStore.closeAll();
    historyStore.clear();
    historyStore.setActiveBoard(null);
    vaultStore.setPath('');
  });

  function openBoardShowing(src: string): void {
    const fixture = makeMindMapWithImage('mm', 't_img', src);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'Boards/mm.board.json' });
    seedBoard(boardStore, fixture.board, boardCacheStore.getFullTilesForBoard('mm'), {}, []);
    historyStore.setActiveBoard('mm');
  }

  it('an image file: trash, then undo restores the bytes and the image tile', async () => {
    installVault({ 'attachments/photo.png': PHOTO });
    openBoardShowing('attachments/photo.png');

    expect(await deleteConfirmed('/vault/attachments/photo.png')).toBe(true);
    expect(vault.read('attachments/photo.png')).toBeUndefined();
    expect(vault.trash.size).toBe(1);
    expect(boardCacheStore.cache.mm.tileDefs.t_img).toBeUndefined();

    await historyStore.undo();
    await settle();

    expect(vault.read('attachments/photo.png')).toBe(PHOTO);
    expect(vault.trash.size).toBe(0);
    expect(boardCacheStore.cache.mm.tileDefs.t_img).toBeDefined();
    // Moved back, never re-written from a copy.
    expect(vault.writes.filter(([, rel]) => rel === 'attachments/photo.png')).toEqual([]);
    expect(channels).not.toContain('vault:write-file-binary');
  });

  it('a folder holding a large video comes back whole, whatever its size', async () => {
    installVault({
      'media/clip.mp4': BIG_VIDEO,
      'media/photo.png': PHOTO,
    });
    openBoardShowing('media/photo.png');

    expect(await deleteConfirmed('/vault/media')).toBe(true);
    expect(vault.read('media/clip.mp4')).toBeUndefined();
    expect(vault.read('media/photo.png')).toBeUndefined();
    expect(boardCacheStore.cache.mm.tileDefs.t_img).toBeUndefined();

    await historyStore.undo();
    await settle();

    expect(vault.read('media/clip.mp4')?.length).toBe(BIG_VIDEO.length);
    expect(vault.read('media/clip.mp4') === BIG_VIDEO).toBe(true);
    expect(vault.read('media/photo.png')).toBe(PHOTO);
    expect(vault.trash.size).toBe(0);
    expect(boardCacheStore.cache.mm.tileDefs.t_img).toBeDefined();
  });

  it('redo moves the media back into the trash, and removes the tile again', async () => {
    installVault({ 'attachments/photo.png': PHOTO });
    openBoardShowing('attachments/photo.png');

    expect(await deleteConfirmed('/vault/attachments/photo.png')).toBe(true);
    await historyStore.undo();
    await settle();
    expect(vault.read('attachments/photo.png')).toBe(PHOTO);

    await historyStore.redo();
    await settle();
    expect(vault.read('attachments/photo.png')).toBeUndefined();
    expect(vault.trash.size).toBe(1);
    expect(boardCacheStore.cache.mm.tileDefs.t_img).toBeUndefined();
  });

  it('undo puts the attachment\'s tags.json file tags back', async () => {
    installVault({ 'attachments/photo.png': PHOTO });
    openBoardShowing('attachments/photo.png');
    fileTagsStore.setFileTags('attachments/photo.png', ['trip']);

    expect(await deleteConfirmed('/vault/attachments/photo.png')).toBe(true);
    expect(fileTagsStore.file.fileTags['attachments/photo.png']).toBeUndefined();

    await historyStore.undo();
    await settle();
    expect(fileTagsStore.file.fileTags['attachments/photo.png']).toEqual(['trip']);
  });
});

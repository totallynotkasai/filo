import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 2 / 2.1 — when an attachment file (image/video/audio) is deleted
 * externally and at least one tile / cover image / frame background still
 * references it, the renderer must surface a confirm toast that routes
 * through the undoable cascade-delete command. Correlated renames are
 * already handled by the rename pipeline; this test only covers the
 * uncorrelated-delete case.
 */

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) {
    uiStore.dismissToast(t.id);
  }
}

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

function ctxFor(): VaultContext {
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
    getProject: () => null,
    setProject: () => {},
    getRecoveryPendingPaths: () => [],
    setRecoveryPendingPaths: () => {},
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

describe('vaultExternalChanges — external attachment delete', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    clearToasts();
    vaultStore.setPath('/vault');
    ctx = ctxFor();
    slice = makeExternalChangesSlice(ctx);
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    clearToasts();
  });

  it('surfaces a confirm toast when an attachment with references is deleted externally', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    installFiloMock({
      'vault:file-exists': () => false,
    });

    await slice.handleExternalAttachmentChanges(['attachments/hero.png']);

    const toast = uiStore.toasts.find((t) =>
      t.text.includes('hero.png') && t.text.includes('deleted externally'),
    );
    expect(toast).toBeDefined();
    expect(toast?.type).toBe('warning');
    expect(toast?.duration).toBe(0);
    expect(toast?.actions).toHaveLength(2);
    expect(toast?.actions?.[0].label).toBe('Remove references');
    expect(toast?.actions?.[1].label).toBe('Dismiss');
  });

  it('does NOT surface a toast when the deleted attachment has no references', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    installFiloMock({
      'vault:file-exists': () => false,
    });

    // Delete a DIFFERENT attachment that no tile references.
    await slice.handleExternalAttachmentChanges(['attachments/unused.png']);

    expect(uiStore.toasts).toHaveLength(0);
  });

  it('does NOT surface a toast when the attachment still exists on disk (create/change event)', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    installFiloMock({
      'vault:file-exists': () => true,
    });

    await slice.handleExternalAttachmentChanges(['attachments/hero.png']);

    expect(uiStore.toasts).toHaveLength(0);
  });

  it('Remove references action invokes the undoable cascade-delete', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });
    const tilesA = boardCacheStore.getFullTilesForBoard('a');
    boardStore.setBoard(a.board, tilesA, {}, []);

    expect(boardStore.getTile('t_img')).toBeDefined();

    installFiloMock({
      'vault:file-exists': () => false,
    });

    await slice.handleExternalAttachmentChanges(['attachments/hero.png']);

    const toast = uiStore.toasts.find((t) =>
      t.text.includes('hero.png') && t.text.includes('deleted externally'),
    );
    expect(toast).toBeDefined();

    // Invoke "Remove references".
    toast?.actions?.[0].handler();

    // Tile got removed via cascade.
    expect(boardStore.getTile('t_img')).toBeUndefined();
  });

  it('IPC failure on vault:file-exists treats the file as missing (defensive default)', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    installFiloMock(() => {
      throw new Error('IPC busted');
    });

    await slice.handleExternalAttachmentChanges(['attachments/hero.png']);

    // We default to "missing" on IPC failure so a watcher event isn't silently
    // dropped. The user can still dismiss the toast if they know it's wrong.
    const toast = uiStore.toasts.find((t) =>
      t.text.includes('hero.png') && t.text.includes('deleted externally'),
    );
    expect(toast).toBeDefined();
  });
});

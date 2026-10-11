/**
 * D.4 — when the watcher reports an attachment as deleted, the
 * "deleted externally" toast must wait 500ms and re-check whether a
 * matching rename event landed in the interim. A cross-folder external
 * move typically arrives as a deleted-old / created-new pair before the
 * main-process correlator pairs them into a synthetic rename event;
 * without the grace window the user sees a spurious deletion toast
 * during a normal move-into-folder operation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeExternalChangesSlice,
  _resetAttachmentDeleteGraceForTests,
} from '@renderer/stores/vaultExternalChanges';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
}

function makeMindMapWithImage(
  boardId: string,
  tileId: string,
  src: string,
): BoardFileData {
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
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        title: 'photo',
        createdAt: 0,
        updatedAt: 0,
        src,
      },
    },
    connections: {},
    frames: [],
  };
}

function ctxFor(): VaultContext {
  return {
    getVaultPath: () => vaultStore.path,
    setVaultPath: () => {},
    resolveRecoveryDismissed: () => {},
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

describe('handleExternalAttachmentChanges — D.4 grace window', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(() => {
    _resetAttachmentDeleteGraceForTests();
    noteStore.__resetForTests();
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
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    clearToasts();
    _resetAttachmentDeleteGraceForTests();
  });

  it('suppresses the prompt when a matching rename arrives during the grace window', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    installFiloMock({
      'vault:file-exists': () => false,
    });

    // Kick off the attachment-delete handler. It will wait the grace
    // window before deciding to prompt.
    const settled = slice.handleExternalAttachmentChanges(['attachments/hero.png']);

    // Simulate a synthetic rename arriving mid-grace (the correlator's
    // typical cadence for a cross-folder move). Even though we're not
    // propagating the rename here, the rename handler records the path
    // in the grace map so the deferred prompt can short-circuit.
    await slice.handleExternalRename('attachments/hero.png', 'archive/hero.png');

    await settled;

    const toast = uiStore.toasts.find(
      (t) => t.text.includes('hero.png') && t.text.includes('deleted externally'),
    );
    expect(toast).toBeUndefined();
  });

  it('still surfaces the prompt when no rename arrives in the grace window', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    installFiloMock({
      'vault:file-exists': () => false,
    });

    await slice.handleExternalAttachmentChanges(['attachments/hero.png']);

    const toast = uiStore.toasts.find(
      (t) => t.text.includes('hero.png') && t.text.includes('deleted externally'),
    );
    expect(toast).toBeDefined();
  });

  it('drops the prompt if the file comes back on disk during the grace window', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    // First file-exists probe says "missing" (the watcher's initial
    // event), second probe says "present" (the file landed back during
    // the grace window — typical of an editor rewriting in place).
    let calls = 0;
    installFiloMock({
      'vault:file-exists': () => {
        calls += 1;
        return calls === 1 ? false : true;
      },
    });

    await slice.handleExternalAttachmentChanges(['attachments/hero.png']);

    const toast = uiStore.toasts.find(
      (t) => t.text.includes('hero.png') && t.text.includes('deleted externally'),
    );
    expect(toast).toBeUndefined();
  });

  it('drops the prompt when the vault swaps during the grace window', async () => {
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    installFiloMock({
      'vault:file-exists': () => false,
    });

    const settled = slice.handleExternalAttachmentChanges(['attachments/hero.png']);
    // Vault swap before the grace expires.
    vaultStore.setPath('/other-vault');
    await settled;

    const toast = uiStore.toasts.find(
      (t) => t.text.includes('hero.png') && t.text.includes('deleted externally'),
    );
    expect(toast).toBeUndefined();
  });

  it('drops the prompt on a close→reopen of the SAME path during the grace window', async () => {
    // The grace guard was a path-string compare
    // (`ctx.getVaultPath() !== vaultRoot`), which a close→reopen of the SAME path
    // (a new vault generation, unchanged path string) silently passes — so a
    // deferred "attachment deleted externally" prompt could surface against the
    // reopened vault. The fix captures `captureVaultIdentity()` before the grace
    // window and bails via `isStillSameVault`, which the generation bump trips.
    const a = makeMindMapWithImage('a', 't_img', 'attachments/hero.png');
    boardCacheStore.hydrate({ a }, { a: 'a.board.json' });

    installFiloMock({
      'vault:file-exists': () => false,
    });

    const settled = slice.handleExternalAttachmentChanges(['attachments/hero.png']);
    // Close→reopen the SAME path during the grace window. `setPath` bumps the
    // vault generation (via beginVaultGeneration) while leaving the path string
    // unchanged — exactly what a same-path reopen does. The pre-fix string
    // compare would NOT bail here; the generation-aware guard does.
    vaultStore.setPath('/vault');
    await settled;

    const toast = uiStore.toasts.find(
      (t) => t.text.includes('hero.png') && t.text.includes('deleted externally'),
    );
    expect(toast).toBeUndefined();
  });
});

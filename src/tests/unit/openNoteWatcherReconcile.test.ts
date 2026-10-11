import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { noteStore } from '@renderer/stores/notes.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import { __resetDrainGuardForTests } from '@renderer/lib/vault/vaultOperations';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

/**
 * External-edit reconciliation cluster.
 *
 *  - A note that absorbed an external edit is built on the new bytes,
 *    so the next keystroke saves without re-detecting that edit as a conflict.
 *  - The reconcile defers while a full index rebuild is in flight, so it
 *    never reads a half-cleared index.
 *  - Our own write coming back through the watcher changes nothing.
 *  - The rename-cascade breadcrumb is laid down BEFORE the tag-flush bail,
 *    so a swap-interrupted cascade still leaves a recovery trail.
 */

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
    resolveRecoveryDismissed: () => {},
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

// ── A reload re-bases the note; our own write is ignored ──

describe('watcher events on an open note', () => {
  let vault: MemoryVault;
  const bigBody = '# Note\n' + 'x'.repeat(2000) + '\n';

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'Notes.md': bigBody });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('a clean note absorbs an external edit, and the next keystroke saves without a conflict', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    const m = noteStore.acquire('Notes.md', 'doc');
    await m.loaded;

    const newBody = '# Note\n' + 'y'.repeat(2000) + '\n';
    vault.writeExternally('Notes.md', newBody);
    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await settle();

    expect(m.body).toBe(newBody);

    noteStore.setBody('Notes.md', `${newBody}\nTyped after the reload`, 'doc');
    expect(await noteStore.flush('Notes.md')).toBe(true);
    expect(m.status).toBe('ready');
    expect(uiStore.toasts).toHaveLength(0);
    expect(vault.read('Notes.md')).toBe(`${newBody}\nTyped after the reload\n`);
  });

  it('our own write coming back through the watcher changes nothing and asks nothing', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    const m = noteStore.acquire('Notes.md', 'doc');
    await m.loaded;
    noteStore.setBody('Notes.md', 'Mine', 'doc');
    await noteStore.flush('Notes.md');
    const rev = m.bodyRevision;

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await settle();

    expect(m.bodyRevision).toBe(rev);
    expect(m.body).toBe('Mine');
    expect(m.status).toBe('ready');
    expect(uiStore.toasts).toHaveLength(0);
  });

  it('refreshes the index for every changed path', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    const applyChanges = vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);

    await slice.handleExternalMarkdownChanges(['Fresh.md']);

    expect(applyChanges).toHaveBeenCalledWith(['Fresh.md']);
    applyChanges.mockRestore();
  });
});

// ── Defer reconcile while the index is rebuilding ────────────────────────

describe('reconcile defers while the index rebuilds', () => {
  beforeEach(() => {
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    __resetDirtyTrackingForTests();
    clearToasts();
    vaultStore.setPath('/vault');
  });

  afterEach(() => {
    restoreFiloDefault();
    vi.restoreAllMocks();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('');
  });

  it('awaits whenBuildComplete BEFORE reading the index (no null-baseline capture)', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    const order: string[] = [];
    vi.spyOn(vaultIndexStore, 'isBuilding', 'get').mockReturnValue(true);
    const whenComplete = vi
      .spyOn(vaultIndexStore, 'whenBuildComplete')
      .mockImplementation(async () => {
        order.push('whenBuildComplete');
      });
    vi
      .spyOn(vaultIndexStore, 'applyChanges')
      .mockImplementation(async () => {
        order.push('applyChanges');
      });

    await slice.handleExternalMarkdownChanges(['X.md']);

    expect(whenComplete).toHaveBeenCalled();
    // The build-complete gate fires before the index read that would otherwise
    // capture previousByPath=null mid-clear.
    expect(order).toEqual(['whenBuildComplete', 'applyChanges']);
  });
});

// ── Rename-cascade breadcrumb survives a swap-during-flush ────────────────

describe('rename-cascade sentinel laid before the tag-flush bail', () => {
  let sentinelWrites: string[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetRenameCascadeSentinelForTests();
    __resetVaultIdentityForTests();
    __resetDrainGuardForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    clearToasts();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');

    sentinelWrites = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return null;
      if (channel === 'tags:save') return undefined;
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      if (
        channel === 'vault:write-file-text' &&
        String(args[1]).includes('rename-cascade-pending.')
      ) {
        sentinelWrites.push(String(args[2]));
        return { success: true };
      }
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    vi.restoreAllMocks();
    __resetDirtyTrackingForTests();
    __resetRenameCascadeSentinelForTests();
    __resetVaultIdentityForTests();
    __resetDrainGuardForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    vaultStore.setPath('');
  });

  it('writes the breadcrumb for the OUTGOING vault even when a swap lands mid tag-flush', async () => {
    // propagateRename touched a board → cache mutated → an interrupted cascade
    // must leave a recovery trail.
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue([]);
    vi.spyOn(boardStore, 'propagateRename').mockReturnValue(['b1']);
    vi.spyOn(boardCacheStore, 'renameBoardPath').mockReturnValue([]);
    // The swap lands DURING the synchronous tag flush — the window under test.
    vi.spyOn(fileTagsStore, 'flushPendingSave').mockImplementation(async () => {
      beginVaultGeneration('/vault2');
      return { ok: true };
    });
    // renameKey only runs AFTER the post-flush bail; spying lets us assert the
    // cascade bailed (didn't corrupt the new vault's index).
    const renameKey = vi.spyOn(vaultIndexStore, 'renameKey').mockReturnValue(undefined);

    const slice = makeExternalChangesSlice(ctxFor());
    await slice.handleExternalRename('Old.md', 'New.md');

    // The breadcrumb was written before the bail, against the outgoing vault.
    expect(sentinelWrites.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(sentinelWrites[sentinelWrites.length - 1]);
    const entry = payload.entries[payload.entries.length - 1];
    expect(entry.oldPath).toBe('Old.md');
    expect(entry.newPath).toBe('New.md');
    expect(entry.affectedBoardIds).toEqual(['b1']);

    // …and the swap actually triggered the post-flush bail.
    expect(renameKey).not.toHaveBeenCalled();
  });
});

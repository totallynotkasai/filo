import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * F3 (2026-05-28) — atomic rename cascade across `.filo/tags.json`.
 *
 * The rename cascade awaits the board flush (`flushAllDirty`) but the tag
 * rename went through a DEBOUNCED misc-write. A crash after the boards landed
 * but before the 300ms tag debounce fired left `tags.json` keyed by the OLD
 * path while every `.board.json` already pointed at the new one — silent
 * tag-membership loss the (board-only) rename-cascade sentinel can't recover.
 *
 * The fix drains the tag write synchronously inside the cascade
 * (`fileTagsStore.flushPendingSave`), in the same critical section as the
 * board flush. This suite asserts the new key is on disk before the cascade
 * returns — including the tags-only rename that hits the `hasCascadeWork`
 * early-return.
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
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

describe('rename cascade — synchronous tags.json flush (F3)', () => {
  let tagsSaves: string[];

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    __resetRenameCascadeSentinelForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('/vault');

    tagsSaves = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return null;
      if (channel === 'tags:save') {
        tagsSaves.push(String(args[1]));
        return undefined;
      }
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      return { success: true };
    });

    // Seed a tag on Old.md and drain the resulting write so the rename's
    // flush is the only tags:save we observe.
    await fileTagsStore.hydrate('/vault');
    fileTagsStore.setFileTags('Old.md', ['mytag']);
    await fileTagsStore.flushPendingSave();
    tagsSaves.length = 0;
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetRenameCascadeSentinelForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    vaultStore.setPath('');
  });

  it('flushPendingSave drains a tag rename to disk synchronously (no debounce)', async () => {
    fileTagsStore.renameFile('Old.md', 'New.md');
    // The rename only armed the 300ms misc debounce — nothing on disk yet.
    expect(tagsSaves).toHaveLength(0);

    await fileTagsStore.flushPendingSave();

    expect(tagsSaves).toHaveLength(1);
    // tags.json keys are canonicalised to lowercase (normalizeVaultRelative).
    const snap = JSON.parse(tagsSaves[0]);
    expect(snap.fileTags['new.md']).toEqual(['mytag']);
    expect(snap.fileTags['old.md']).toBeUndefined();
  });

  it('external rename cascade persists tags.json before it returns', async () => {
    const slice = makeExternalChangesSlice(ctxFor());

    await slice.handleExternalRename('Old.md', 'New.md');

    // By the time the cascade resolved, the tag rename was already on disk —
    // not left on the misc debounce a crash could straddle. This rename
    // touches no boards, so it also exercises the hasCascadeWork early-return
    // (the flush must run BEFORE that bail).
    expect(tagsSaves.length).toBeGreaterThanOrEqual(1);
    const latest = JSON.parse(tagsSaves[tagsSaves.length - 1]);
    expect(latest.fileTags['new.md']).toEqual(['mytag']);
    expect(latest.fileTags['old.md']).toBeUndefined();
  });
});

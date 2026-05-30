import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 4.2 (2026-05-30) — when a tagged `.md` file is deleted externally and
 * the user confirms the deletion (Reload / Reload-all / Mark broken refs),
 * its `.filo/tags.json:fileTags[path]` entry must be dropped. Otherwise the
 * orphan lingers until the next vault-open `pruneOrphanFileTags`, inflating
 * tag counts for the rest of the session.
 *
 * Per the chosen scope (confirmed paths only), the drop fires from the
 * user-confirmed deletion handlers — NOT eagerly from the `file-missing`
 * branch, which deliberately defers cleanup because an uncorrelated external
 * move can surface as delete-then-rename within ~500ms (an early drop would
 * lose the tags on the moved file). The "Keep local" recreate path must NOT
 * drop — the file (and its tags) come back.
 */

function makeCtx(): VaultContext {
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

describe('vaultExternalChanges — external delete drops tags.json entry (Phase 4.2)', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    fileTagsStore.reset();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('/vault');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    slice = makeExternalChangesSlice(makeCtx());
  });

  afterEach(() => {
    restoreFiloDefault();
    vi.restoreAllMocks();
    documentStore.clear();
    vaultIndexStore.clear();
    fileTagsStore.reset();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('');
  });

  async function primeTaggedFile(rel: string): Promise<void> {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: '# Notes\nbody' };
      if (channel === 'tags:load') return null;
      return { success: true };
    });
    await vaultIndexStore.applyChanges([rel]);
    await fileTagsStore.hydrate('/vault');
    fileTagsStore.setFileTags(rel, ['mytag']);
  }

  function loadDirtyEditor(rel: string): void {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: rel,
      title: 'Notes',
      body: 'dirty',
      htmlContent: '<p>dirty</p>',
      richText: [],
    });
    documentStore.updateContent('doc_A', '<p>dirty</p>', 'dirty');
  }

  function installFileGoneMock(): void {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: false };
      if (channel === 'tags:load') return null;
      return { success: true };
    });
  }

  it('drops the file from tags.json when the user picks Reload (accepts the delete)', async () => {
    await primeTaggedFile('Notes.md');
    expect(fileTagsStore.file.fileTags['notes.md']).toEqual(['mytag']);

    loadDirtyEditor('Notes.md');
    installFileGoneMock();

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast?.actions?.[0].label).toBe('Reload');

    await toast?.actions?.[0].handler();

    // Reload accepted the deletion → the orphan fileTags entry is gone.
    expect(fileTagsStore.file.fileTags['notes.md']).toBeUndefined();
  });

  it('keeps the tags.json entry when the user picks Keep local (re-creates the file)', async () => {
    await primeTaggedFile('Notes.md');
    documentStore.setFrontmatter('doc_A', { tags: ['mytag'] });

    loadDirtyEditor('Notes.md');
    installFileGoneMock();

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast?.actions?.[1].label).toBe('Keep local');

    await toast?.actions?.[1].handler();

    // Keep local re-creates the file → its tags are still valid, not dropped.
    expect(fileTagsStore.file.fileTags['notes.md']).toBeDefined();
  });
});

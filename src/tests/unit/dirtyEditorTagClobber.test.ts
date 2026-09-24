import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 3 / 3.3 — dirty editor + external frontmatter edit must NOT clobber
 * the tag store.
 *
 * Pre-fix, vaultExternalChanges's `prompt-user` switch arm eagerly called
 * `boardStore.applyFrontmatterToBackedTiles` + `fileTagsStore.setFileTags`
 * with the disk frontmatter BEFORE the user picked Reload / Keep local. If
 * they later picked Keep local, the editor's writer would push its own
 * (different) frontmatter back to disk — but the tag store + tile-def caches
 * were already updated to the external version, leaving a three-way
 * inconsistency between disk, store, and editor.
 *
 * The fix defers those updates to the Reload handler. Keep local leaves the
 * stores on the editor's view and force-writes the editor's frontmatter +
 * tags back to disk.
 */

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) {
    uiStore.dismissToast(t.id);
  }
}

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
    resolveRecoveryDismissed: () => {},
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

describe('vaultExternalChanges — dirty editor + external frontmatter (Phase 3 / 3.3)', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(async () => {
    documentStore.clear();
    vaultIndexStore.clear();
    fileTagsStore.reset();
    clearToasts();
    vaultStore.setPath('/vault');
    ctx = makeCtx();
    slice = makeExternalChangesSlice(ctx);

    // Prime: index sees `Notes.md` with [mine]. Reload returns the same
    // content so subsequent dirty-state checks use [mine] as baseline.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [mine]\n---\nlocal body' };
      }
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Notes.md']);
    fileTagsStore.setFileTags('Notes.md', ['mine']);

    // Open a dirty editor with the editor frontmatter cache holding
    // the editor's view of tags.
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'local body',
      htmlContent: '<p>local body</p>',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { tags: ['mine'] });
    // Flip to dirty by simulating a content edit.
    documentStore.updateContent('Notes.md', '<p>local body+</p>', 'local body+');
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    fileTagsStore.reset();
    clearToasts();
  });

  it('does NOT push external tags into the tag store at prompt-open time', async () => {
    // External edit: disk now has [theirs].
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [theirs]\n---\nexternally rewritten body' };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    // The tag store must NOT yet include `theirs` — the user hasn't
    // chosen Reload.
    expect(fileTagsStore.tagsForFile('Notes.md')).toEqual(['mine']);

    // The persistent prompt should be visible.
    const toast = uiStore.toasts.find((t) => t.text.includes('modified externally'));
    expect(toast).toBeDefined();
    expect(toast?.actions?.[0].label).toBe('Reload');
    expect(toast?.actions?.[1].label).toBe('Keep local');
  });

  it('Reload applies external frontmatter + tags atomically with body', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [theirs]\n---\nexternally rewritten body' };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    const toast = uiStore.toasts.find((t) => t.text.includes('modified externally'));
    expect(toast).toBeDefined();

    await toast?.actions?.[0].handler(); // Reload

    expect(fileTagsStore.tagsForFile('Notes.md')).toEqual(['theirs']);
    const doc = documentStore.getDocument('Notes.md');
    expect(doc?.body).toBe('externally rewritten body');
    expect(doc?.isDirty).toBe(false);
  });

  it('Keep local leaves tag store on the editor\'s view (no external clobber)', async () => {
    // Track every write so we can confirm the editor's frontmatter
    // lands on disk after Keep local.
    const writes: Array<{ channel: string; args: unknown[] }> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [theirs]\n---\nexternally rewritten body' };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    const toast = uiStore.toasts.find((t) => t.text.includes('modified externally'));
    expect(toast).toBeDefined();

    await toast?.actions?.[1].handler(); // Keep local

    // Tag store must still show `[mine]` — Keep local does NOT pull in
    // the external tags.
    expect(fileTagsStore.tagsForFile('Notes.md')).toEqual(['mine']);

    // The editor doc is still in memory with the editor's body.
    const doc = documentStore.getDocument('Notes.md');
    expect(doc?.body).toBe('local body+');
  });
});

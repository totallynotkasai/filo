/**
 * A Kanban card / Task toggle queues a frontmatter change for a note no
 * editor has open. A frontmatter-only edit made by another program before
 * that change lands must not clobber it, and the change must not clobber the
 * other program's edit: the queued change is a delta applied to a fresh read
 * of the file, so both survive, silently (there is nothing to ask about).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { noteStore } from '@renderer/stores/notes.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
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

describe('a queued card frontmatter change meets an external frontmatter edit', () => {
  let vault: MemoryVault;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'Card.md': '---\ncompleted: false\n---\nBody\n' });
    slice = makeExternalChangesSlice(makeCtx());
    await vaultIndexStore.applyChanges(['Card.md']);

    // The card toggle: a frontmatter change is queued, no editor holds the note.
    noteStore.patchFrontmatter('Card.md', patchToFrontmatterDelta({ completed: true }));
  });

  afterEach(() => {
    noteStore.__resetForTests();
    vaultStore.setPath('');
    vaultIndexStore.clear();
    clearToasts();
    restoreFiloDefault();
  });

  it('both the local toggle and the external tag land, with no prompt', async () => {
    expect(noteStore.get('Card.md')).toBeUndefined();
    expect(noteStore.hasPendingWrites('Card.md')).toBe(true);

    vault.writeExternally('Card.md', '---\ncompleted: false\ntags: [theirs]\n---\nBody\n');
    await slice.handleExternalMarkdownChanges(['Card.md']);

    // The card still shows the local toggle over the refreshed index.
    expect(noteStore.frontmatter('Card.md')).toEqual({ completed: true, tags: ['theirs'] });
    expect(uiStore.toasts).toHaveLength(0);
    // The local change is still queued: the external edit didn't drop it.
    expect(noteStore.hasPendingWrites('Card.md')).toBe(true);

    await noteStore.flushAll();
    expect(vault.read('Card.md')).toBe('---\ncompleted: true\ntags: [theirs]\n---\nBody\n');
    expect(vaultIndexStore.getMetadata('Card.md')?.frontmatter).toEqual({ completed: true, tags: ['theirs'] });
  });

  it('an external edit to the same key loses to the later local toggle, and other keys survive', async () => {
    vault.writeExternally('Card.md', '---\ncompleted: false\npriority: high\n---\nBody\n');
    await slice.handleExternalMarkdownChanges(['Card.md']);
    await noteStore.flushAll();
    expect(vault.read('Card.md')).toBe('---\ncompleted: true\npriority: high\n---\nBody\n');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { scheduleFrontmatterWrite } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { hasPendingWrite, __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * F4 (2026-05-28) — pending-local-write guard on the markdown classifier.
 *
 * The external-change classifier defines "dirty" as "has an OPEN editor"
 * (`documentStore.findByFilename`). A Kanban card / Task whose `completed`
 * toggle scheduled a frontmatter write but whose editor isn't mounted has a
 * pending local write the classifier can't see. A frontmatter-only external
 * edit to the same file therefore classified as `sync-frontmatter` and
 * silently applied disk over the in-memory state — then the pending local
 * debounce fired last-write-wins, clobbering one side without the user's say.
 *
 * The fix mirrors the board-JSON reconciler: before applying a silent
 * `sync-frontmatter` / `reload-silently`, consult the shared
 * `hasPendingWrite` ledger (which the frontmatter scheduler populates on
 * schedule). If a local write is pending, surface a Reload / Keep-local
 * prompt instead of silently reconciling.
 *
 * This suite reproduces the no-editor scenario the audit called out and
 * asserts the local pending write is never silently dropped.
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

describe('vaultExternalChanges — pending-write guard (F4)', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(async () => {
    __resetDirtyTrackingForTests(); // also resets the frontmatter scheduler
    documentStore.clear();
    vaultIndexStore.clear();
    fileTagsStore.reset();
    clearToasts();
    vaultStore.setPath('/vault');
    ctx = makeCtx();
    slice = makeExternalChangesSlice(ctx);

    // Prime: index sees Card.md with completed=false, no tags, body "Body".
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ncompleted: false\n---\nBody', mtimeMs: 1000 };
      }
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Card.md']);

    // Simulate the Kanban card toggle: the live frontmatter cache holds
    // completed=true, and a frontmatter write is scheduled — but NO editor
    // is mounted (no `loadDocument`), so `findByFilename` returns null.
    documentStore.setFrontmatter('doc_card', { completed: true });
    scheduleFrontmatterWrite('Card.md', 'doc_card');
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    fileTagsStore.reset();
    clearToasts();
  });

  it('frontmatter-only external edit + pending write → prompt, no silent sync', async () => {
    // Sanity: the toggle armed a pending write the classifier can't see.
    expect(hasPendingWrite('Card.md')).toBe(true);
    expect(documentStore.findByFilename('Card.md')).toBeNull();

    // External editor adds a tag (frontmatter-only; body unchanged).
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ncompleted: false\ntags: [theirs]\n---\nBody', mtimeMs: 2000 };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Card.md']);

    // A Reload / Keep-local prompt fired instead of a silent sync-frontmatter.
    const toast = uiStore.toasts.find((t) => t.text.includes('modified externally'));
    expect(toast).toBeDefined();
    expect(toast?.actions?.[0].label).toBe('Reload');
    expect(toast?.actions?.[1].label).toBe('Keep local');

    // The local pending write was NOT silently dropped — it is still armed.
    expect(hasPendingWrite('Card.md')).toBe(true);

    // The external tags were NOT silently pushed into the tag store (the bug:
    // the old sync-frontmatter path called setFileTags unconditionally).
    expect(fileTagsStore.tagsForFile('Card.md')).toEqual([]);
  });

  it('Reload cancels the pending write and applies the disk frontmatter', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ncompleted: false\ntags: [theirs]\n---\nBody', mtimeMs: 2000 };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Card.md']);
    const toast = uiStore.toasts.find((t) => t.text.includes('modified externally'));
    expect(toast).toBeDefined();

    toast!.actions![0].handler(); // Reload

    // Pending write cancelled so it can't fire and re-clobber the reload.
    expect(hasPendingWrite('Card.md')).toBe(false);
    // Disk frontmatter applied to the tag store.
    expect(fileTagsStore.tagsForFile('Card.md')).toEqual(['theirs']);
  });

  it('Keep local leaves the pending write armed to overwrite on next save', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ncompleted: false\ntags: [theirs]\n---\nBody', mtimeMs: 2000 };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Card.md']);
    const toast = uiStore.toasts.find((t) => t.text.includes('modified externally'));
    expect(toast).toBeDefined();

    toast!.actions![1].handler(); // Keep local

    // Pending write still armed → the local toggle wins on the next flush.
    expect(hasPendingWrite('Card.md')).toBe(true);
    // External tags NOT applied — the user kept their local view.
    expect(fileTagsStore.tagsForFile('Card.md')).toEqual([]);
    // A follow-up info toast confirms the choice.
    const info = uiStore.toasts.find((t) => t.text.includes('overwrite the external edit'));
    expect(info).toBeDefined();
  });
});

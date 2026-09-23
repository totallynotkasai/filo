import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { __clearRecentSelfWritesForTests } from '@renderer/lib/boards/writeStateTracking';
import { beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-19 EXT-3 — a sync client replaces a file as delete, then create. The
 * "deleted externally" toast stays clickable while the other machine's
 * version lands; "Keep local" used to re-create the file through the
 * create-OR-OVERWRITE channel (no probe, no drift gate, no backup), destroying
 * that version. And "Reload" dropped the tags of a file that was back.
 */

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
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
  } as unknown as VaultContext;
}

describe('deleted-externally prompt re-probes (Audit-19 EXT-3)', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let calls: Array<{ channel: string; args: unknown[] }>;
  let diskContent: string | null;

  beforeEach(async () => {
    documentStore.clear();
    vaultIndexStore.clear();
    clearToasts();
    __clearRecentSelfWritesForTests();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
    slice = makeExternalChangesSlice(ctxFor());
    calls = [];
    diskContent = '# Notes\nbody';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return diskContent === null ? { success: false, code: 'ENOENT' } : { success: true, content: diskContent };
      }
      if (channel === 'vault:file-exists') return diskContent !== null;
      if (channel === 'vault:create-file-text') {
        return diskContent === null ? { success: true } : { success: false, code: 'EEXIST', error: 'exists' };
      }
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Notes.md']);
    documentStore.loadDocument({
      docId: 'doc_A', filename: 'Notes.md', title: 'Notes', body: 'local body',
      htmlContent: '<p>local body</p>', richText: [],
    });
    documentStore.setFrontmatter('doc_A', { tags: ['local-tag'] });
    documentStore.markDirty('doc_A');
    // The file is deleted externally → the toast.
    diskContent = null;
    await slice.handleExternalMarkdownChanges(['Notes.md']);
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    clearToasts();
    vi.restoreAllMocks();
  });

  function deletedToast() {
    const t = uiStore.toasts.find((x) => x.text.includes('deleted externally'));
    expect(t).toBeDefined();
    return t!;
  }

  it('the file reappears with other bytes, then Keep local → NOT overwritten; the modified prompt shows (bite)', async () => {
    const toast = deletedToast();
    diskContent = '# Notes\nthe OTHER machine\'s version';
    await toast.actions!.find((a) => a.label === 'Keep local')!.handler();
    const overwrites = calls.filter(
      (c) => (c.channel === 'vault:write-file-text' || c.channel === 'vault:create-file-text') && c.args[1] === 'Notes.md',
    );
    expect(overwrites.every((c) => c.channel === 'vault:create-file-text')).toBe(true);
    expect(uiStore.toasts.some((t) => t.text.includes('was modified externally'))).toBe(true);
  });

  it('the file reappears between the probe and the write → EEXIST, still not overwritten', async () => {
    const toast = deletedToast();
    // The probe says missing, but the O_EXCL create finds it back.
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:file-exists') return false;
      if (channel === 'vault:create-file-text') return { success: false, code: 'EEXIST', error: 'exists' };
      if (channel === 'vault:read-file-text') return { success: true, content: '# Notes\nother' };
      return { success: true };
    });
    await toast.actions!.find((a) => a.label === 'Keep local')!.handler();
    expect(calls.some((c) => c.channel === 'vault:write-file-text' && c.args[1] === 'Notes.md')).toBe(false);
    expect(uiStore.toasts.some((t) => t.text.includes('was modified externally'))).toBe(true);
  });

  it('a still-missing file → re-created exclusively', async () => {
    const toast = deletedToast();
    await toast.actions!.find((a) => a.label === 'Keep local')!.handler();
    const create = calls.find((c) => c.channel === 'vault:create-file-text' && c.args[1] === 'Notes.md');
    expect(create).toBeDefined();
    expect(String(create!.args[2])).toContain('local body');
  });

  it('Reload with the file back → tags kept, editor shows the disk bytes', async () => {
    const drop = vi.spyOn(fileTagsStore, 'dropFile');
    const toast = deletedToast();
    diskContent = '# Notes\nsynced back';
    await toast.actions!.find((a) => a.label === 'Reload')!.handler();
    expect(drop).not.toHaveBeenCalled();
    expect(documentStore.getDocument('doc_A')?.body).toContain('synced back');
  });

  it('a vault swap during the re-probe → bail (nothing written or applied)', async () => {
    const toast = deletedToast();
    installFiloMock((channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === 'vault:file-exists') {
        beginVaultGeneration('/other');
        return false;
      }
      return { success: true };
    });
    await toast.actions!.find((a) => a.label === 'Keep local')!.handler();
    expect(calls.some((c) => c.channel === 'vault:create-file-text')).toBe(false);
  });
});

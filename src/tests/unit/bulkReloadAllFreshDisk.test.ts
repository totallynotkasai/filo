/**
 * L3 (Audit-12) — the bulk "Reload all" toast (fired when > 5 dirty editors are
 * affected by an external-change batch) used to replay each file's
 * detection-time `p.next` snapshot. A SECOND external write landing between the
 * watcher event and the user's click was then lost — "Reload all" applied the
 * stale first-detection content. The single-file `promptModifiedFile` Reload was
 * already hardened (Write-path Phase 3.4) to re-read current disk; this pins the
 * same fix on the bulk loop (`vaultIndexStore.applyChanges` + `getMetadata`
 * per file before `applyReloadFromDisk`).
 *
 * Bite-verify: revert the per-file re-read (use `p.next`) → the docs reload the
 * v2 snapshot (`body2`) and the v3-after-click assertions go red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { __clearRecentSelfWritesForTests } from '@renderer/lib/boards/writeStateTracking';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

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

describe('bulk Reload-all re-reads current disk per file (Audit-12 L3)', () => {
  // 6 files → over PROMPT_AGGREGATION_THRESHOLD (5) → the bulk toast.
  const FILES = Array.from({ length: 6 }, (_, i) => `Notes${i}.md`);
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let diskContent: string;

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    __clearRecentSelfWritesForTests();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('/vault');
    diskContent = '---\nstatus: v1\n---\nbody1';
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: diskContent };
      return { success: true };
    });
    ctx = ctxFor();
    slice = makeExternalChangesSlice(ctx);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vi.restoreAllMocks();
  });

  it('applies the LATEST bytes on Reload all when a file changed again after detection', async () => {
    // Seed the index at v1 and load a dirty editor doc per file.
    await vaultIndexStore.applyChanges(FILES); // index v1 for all
    FILES.forEach((rel, i) => {
      documentStore.loadDocument({
        docId: `doc_${i}`,
        filename: rel,
        title: rel,
        body: 'dirty local',
        htmlContent: '<p>dirty local</p>',
        richText: [],
      });
      documentStore.updateContent(`doc_${i}`, '<p>dirty local</p>', 'dirty local'); // isDirty
    });

    // External edit #1 → v2 for every file; the batch surfaces the bulk toast
    // with each file's v2 snapshot captured as `p.next`.
    diskContent = '---\nstatus: v2\n---\nbody2';
    await slice.handleExternalMarkdownChanges(FILES);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const bulk = uiStore.toasts.find((t) => t.actions?.some((a) => a.label === 'Reload all'));
    expect(bulk, 'bulk Reload-all toast should appear for > 5 dirty files').toBeDefined();

    // External edit #2 → v3 lands BEFORE the user clicks (no new dispatch).
    diskContent = '---\nstatus: v3\n---\nbody3';

    const reloadAll = bulk!.actions!.find((a) => a.label === 'Reload all')!;
    await reloadAll.handler();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Every doc reflects the CURRENT disk (v3), not the stale v2 snapshot.
    for (let i = 0; i < FILES.length; i++) {
      expect(documentStore.getDocument(`doc_${i}`)?.body, `${FILES[i]} should reload v3`).toBe(
        'body3',
      );
    }
  });
});

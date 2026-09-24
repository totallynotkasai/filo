import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeExternalChangesSlice, resetPartialReadRetryInflight } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * M5 (2026-05-28) — a silent reload of a CLEAN editor now snapshots the prior
 * body/frontmatter so a mis-judged transient / partial read (one that slipped
 * past the partial-read heuristic) is recoverable. When the reload is a
 * material shrink (>50% of a non-trivial file) a one-shot "Undo reload" toast
 * surfaces; its action restores the pre-reload content. Routine edits / growth
 * reload silently as before (no toast).
 */

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
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

describe('vaultExternalChanges — reload-silently recovery (M5)', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  // Prior body well above RELOAD_RECOVERY_MIN_PRIOR_BYTES (256) and the
  // partial-read floor (1024) so a non-drastic shrink classifies as
  // reload-silently (not partial-read-retry).
  const bigBody = '# Note\n' + 'x'.repeat(2000) + '\n';

  async function primeAndOpen(): Promise<void> {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: bigBody, mtimeMs: 1 };
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Notes.md']);
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: bigBody,
      htmlContent: '',
      richText: [],
    });
  }

  beforeEach(async () => {
    documentStore.clear();
    vaultIndexStore.clear();
    resetPartialReadRetryInflight();
    clearToasts();
    vaultStore.setPath('/vault');
    ctx = makeCtx();
    slice = makeExternalChangesSlice(ctx);
    await primeAndOpen();
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    resetPartialReadRetryInflight();
    clearToasts();
  });

  it('surfaces an Undo-reload toast on a material shrink and restores prior content', async () => {
    // External edit drops the body to ~35% of its prior size — material
    // (>50% lost) but not drastic enough (>90%) to be a partial-read.
    const shrunk = '# Note\n' + 'x'.repeat(700) + '\n';
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: shrunk, mtimeMs: 2 };
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    // The silent reload landed the shrunk body…
    expect(documentStore.getDocument('Notes.md')?.body).toBe(shrunk);

    // …and a recovery toast was surfaced.
    const toast = uiStore.toasts.find((t) => t.text.includes('shrank sharply'));
    expect(toast).toBeDefined();
    const undo = toast?.actions?.find((a) => a.label === 'Undo reload');
    expect(undo).toBeDefined();

    // Undo restores the pre-reload body and marks the doc dirty so the
    // recovery is force-written back over the external truncation.
    await undo!.handler();
    const doc = documentStore.getDocument('Notes.md');
    expect(doc?.body).toBe(bigBody);
    expect(doc?.isDirty).toBe(true);
  });

  it('does NOT surface a recovery toast for a modest shrink (real edit)', async () => {
    // ~25% smaller — below the material-shrink bar — reloads silently.
    const trimmed = '# Note\n' + 'x'.repeat(1500) + '\n';
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: trimmed, mtimeMs: 2 };
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    expect(documentStore.getDocument('Notes.md')?.body).toBe(trimmed);
    expect(uiStore.toasts.find((t) => t.text.includes('shrank sharply'))).toBeUndefined();
  });

  it('does NOT surface a recovery toast when the file grew', async () => {
    const grown = '# Note\n' + 'x'.repeat(3000) + '\n';
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: grown, mtimeMs: 2 };
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    expect(documentStore.getDocument('Notes.md')?.body).toBe(grown);
    expect(uiStore.toasts.find((t) => t.text.includes('shrank sharply'))).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice, resetPartialReadRetryInflight } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 3 / 3.2 — partial-read retries are bounded. The classifier returns
 * `partial-read-retry` when a clean editor's previously-indexed body shrank
 * by >90% in a single watcher pass (`isLikelyPartialRead`). The retry path
 * used to fire forever every 500 ms, burning CPU on a file the user might
 * have actually truncated externally.
 *
 * The fix caps at 3 attempts (500 / 1500 / 3000 ms backoff). On exhaustion a
 * confirm toast asks the user: Reload from disk (force-apply the shrunk
 * content) or Keep my view (leave the editor on the restored baseline). The
 * retry counter clears either way so a future external edit gets a fresh
 * budget.
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

describe('vaultExternalChanges — partial-read retry is bounded (Phase 3 / 3.2)', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  // A body big enough that a >90% shrink fires the classifier's
  // `isLikelyPartialRead` heuristic — the threshold is 1024 bytes prior
  // size. 5 KB leaves a comfortable margin.
  const bigBody = '# Big\n' + 'x'.repeat(5000) + '\n';
  // Tiny body — well below 10% of `bigBody`, so the classifier returns
  // `partial-read-retry`.
  const tinyBody = '# Tiny\n';

  beforeEach(async () => {
    documentStore.clear();
    vaultIndexStore.clear();
    resetPartialReadRetryInflight();
    clearToasts();
    vaultStore.setPath('/vault');
    ctx = makeCtx();
    slice = makeExternalChangesSlice(ctx);

    // Prime the index with the big body so subsequent re-reads see it as
    // the previous baseline.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: bigBody };
      }
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Notes.md']);

    // Open a clean editor for the same file — required for the classifier
    // to enter the partial-read-retry branch (dirty editors get
    // prompt-user; missing editors get ignore/sync-frontmatter).
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: bigBody,
      htmlContent: `<p>${bigBody}</p>`,
      richText: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    resetPartialReadRetryInflight();
    clearToasts();
  });

  it('schedules a bounded backoff (500 / 1500 / 3000 ms) and surfaces a toast on exhaustion', async () => {
    // Now flip the mock to return the truncated body. Every subsequent
    // applyChanges -> read will surface the partial-read condition.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: tinyBody };
      }
      return { success: true };
    });

    vi.useFakeTimers();

    // Attempt 1: triggers retry scheduled at 500 ms.
    await slice.handleExternalMarkdownChanges(['Notes.md']);
    // No toast yet — we have a retry budget to consume.
    expect(uiStore.toasts.find((t) => t.text.includes('shrunk externally'))).toBeUndefined();

    // Drain attempt 1's timer + its async re-classification work.
    await vi.advanceTimersByTimeAsync(500);
    expect(uiStore.toasts.find((t) => t.text.includes('shrunk externally'))).toBeUndefined();

    // Attempt 2 was scheduled at 1500 ms.
    await vi.advanceTimersByTimeAsync(1500);
    expect(uiStore.toasts.find((t) => t.text.includes('shrunk externally'))).toBeUndefined();

    // Attempt 3 was scheduled at 3000 ms.
    await vi.advanceTimersByTimeAsync(3000);
    // After the 3rd retry's pass, the 4th classification hits the cap
    // and surfaces the toast immediately (no further timer).
    const toast = uiStore.toasts.find((t) => t.text.includes('shrunk externally'));
    expect(toast).toBeDefined();
    expect(toast?.type).toBe('warning');
    expect(toast?.duration).toBe(0);
    expect(toast?.actions?.[0].label).toBe('Reload from disk');
    expect(toast?.actions?.[1].label).toBe('Keep my view');
  });

  it('does NOT loop forever — no more than PARTIAL_READ_MAX_RETRIES + 1 reads occur', async () => {
    let readCount = 0;
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        readCount += 1;
        return { success: true, content: tinyBody };
      }
      return { success: true };
    });

    vi.useFakeTimers();

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    // Run every queued timer to exhaustion.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    // Initial call + 3 retries = 4 reads. The exhaustion path does
    // not re-read inside the toast handler (only when the user clicks
    // Reload), so the count must not grow further with more time.
    expect(readCount).toBe(4);
  });

  it('Keep my view leaves the editor untouched (still on the pre-shrink baseline)', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: tinyBody };
      }
      return { success: true };
    });

    vi.useFakeTimers();
    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await vi.advanceTimersByTimeAsync(10_000);

    const toast = uiStore.toasts.find((t) => t.text.includes('shrunk externally'));
    expect(toast).toBeDefined();

    // The editor was loaded clean and never marked dirty by the retry
    // path. Its body is whatever was last applied via load — the
    // pre-shrink baseline.
    vi.useRealTimers();
    await toast?.actions?.[1].handler();
    const doc = documentStore.getDocument('doc_A');
    expect(doc?.body).toBe(bigBody);
    expect(doc?.isDirty).toBe(false);
  });

  it('Reload from disk applies the shrunk content to the editor unconditionally', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: tinyBody };
      }
      return { success: true };
    });

    vi.useFakeTimers();
    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await vi.advanceTimersByTimeAsync(10_000);

    const toast = uiStore.toasts.find((t) => t.text.includes('shrunk externally'));
    expect(toast).toBeDefined();

    vi.useRealTimers();
    await toast?.actions?.[0].handler();
    const doc = documentStore.getDocument('doc_A');
    expect(doc?.body).toBe(tinyBody);
    expect(doc?.isDirty).toBe(false);
  });
});

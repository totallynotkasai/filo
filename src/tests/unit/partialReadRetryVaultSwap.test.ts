/**
 * Phase A.5 — `resetPartialReadRetryInflight()` must `clearTimeout`
 * pending retry handles, not just clear the Set + counter.
 *
 * Before this fix, `setTimeout` handles armed against vault A still
 * fired their callback after the vault-swap reset. The callback ran
 * `handleExternalMarkdownChanges([rel])` against whatever vault was
 * open at fire time — if vault B happened to have a same-named file,
 * the late timer re-classified it against vault A's baseline and could
 * surface a phantom Reload/Keep prompt on the new vault.
 *
 * The fix tracks each `setTimeout` handle in a `Map<path, Timer>`. The
 * reset walks the map calling `clearTimeout` before clearing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeExternalChangesSlice,
  resetPartialReadRetryInflight,
} from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

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

describe('vaultExternalChanges — partial-read retry timer cleanup (Phase A.5)', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  const bigBody = '# Big\n' + 'x'.repeat(5000) + '\n';
  const tinyBody = '# Tiny\n';

  beforeEach(async () => {
    documentStore.clear();
    vaultIndexStore.clear();
    resetPartialReadRetryInflight();
    clearToasts();
    vaultStore.setPath('/vault');
    ctx = makeCtx();
    slice = makeExternalChangesSlice(ctx);

    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: bigBody };
      }
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Notes.md']);

    documentStore.loadDocument({
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

  it('reset cancels the pending retry timer — handler does NOT fire', async () => {
    // Trigger a partial-read classification → schedules retry at 500 ms.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: tinyBody };
      }
      return { success: true };
    });

    vi.useFakeTimers();

    let postResetReadCount = 0;
    await slice.handleExternalMarkdownChanges(['Notes.md']);

    // Switch the mock to a counter we can assert was NOT incremented
    // after reset. If the timer fired post-reset, this counter would
    // climb.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        postResetReadCount++;
        return { success: true, content: tinyBody };
      }
      return { success: true };
    });

    // Reset BEFORE the timer fires.
    resetPartialReadRetryInflight();

    // Advance past the longest backoff (3000 ms cumulative). If the
    // timer fired, it would re-enter the classifier and consume the
    // mock's read path.
    await vi.advanceTimersByTimeAsync(5000);

    expect(postResetReadCount).toBe(0);
  });

  it('reset is idempotent — second reset is safe', () => {
    expect(() => {
      resetPartialReadRetryInflight();
      resetPartialReadRetryInflight();
    }).not.toThrow();
  });
});

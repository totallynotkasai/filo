import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  markHydrated,
  registerForceWriter,
  unregisterForceWriter,
  cancelAllMarkdownWrites,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 6.1.R1 — `recreateDeletedFile` routes through
 * `syncOpenEditorsAfterDiskMutation`, which cancels armed body writers for
 * the docId via `applyReloadFromDisk`'s 6.0.C2 self-cancel.
 *
 * Mechanism: the user typed into a now-deleted file, the classifier surfaced
 * a "Keep local" toast, the debounced write timer is still armed against the
 * OLD body. The user clicks Keep local; `recreateDeletedFile` writes the
 * authoritative bytes to disk. Without the cancel the still-armed timer
 * would fire ~300 ms later carrying the closure-captured pre-click body and
 * silently revert the recreation. The pre-R1 implementation called
 * `documentStore.markClean(...)` which only flipped the dirty flag — it
 * never disarmed the timer.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWriteContent(captured: Captured[], rel: string): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (
      captured[i].channel === 'vault:write-existing-file-text'
      && captured[i].args[1] === rel
    ) {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

function makeArgs(
  docId: string,
  relPath: string,
  fm: Record<string, unknown>,
  body: string,
): WriteArgs {
  return {
    vaultRoot: '/vault',
    relPath,
    frontmatter: fm,
    body,
    callerId: `text-tile:${docId}`,
    docId,
  };
}

describe('recreateDeletedFile — cancels armed body writers (Phase 6.1.R1)', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let captured: Captured[];

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    vaultStore.setPath('/vault');

    ctx = {
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
    } as VaultContext;
    slice = makeExternalChangesSlice(ctx);

    captured = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    cancelAllMarkdownWrites();
    __resetDirtyTrackingForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vi.restoreAllMocks();
  });

  it('disarms the armed body writer so the post-recovery bytes are not reverted', async () => {
    const relPath = 'Notes.md';
    const docId = 'doc_recover';
    const callerId = `text-tile:${docId}`;

    // Prime the index so the classifier can see the file exists, then
    // simulate the external delete via `applyChanges([rel])`.
    installFiloMock((channel: string) => {
      captured.push({ channel, args: [] });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntitle: Notes\n---\noriginal disk body\n' };
      }
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
      return { success: true };
    });
    await vaultIndexStore.applyChanges([relPath]);

    // Editor mounted; user typed (dirty); local body diverges from disk.
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'Notes',
      body: 'local typed body',
      htmlContent: '<p>local typed body</p>',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'Notes' }, '---\ntitle: Notes\n---');
    documentStore.updateContent(docId, '<p>local typed body</p>', 'local typed body');
    markHydrated(relPath, false);

    // Armed body writer: a debounced keystroke captured the pre-Keep-local body.
    registerForceWriter(callerId, docId, () => null);
    scheduleMarkdownWrite(makeArgs(docId, relPath, { title: 'Notes' }, 'PRE-RECOVERY armed body'));

    // Swap to a recording mock for the recovery write step so we can see what
    // hits disk.
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: false };
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 2, size: 2 };
      return { success: true };
    });

    // External delete → classifier surfaces the "deleted externally" toast.
    await slice.handleExternalMarkdownChanges([relPath]);
    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast).toBeDefined();

    // User clicks Keep local → recreateDeletedFile writes the authoritative
    // bytes AND routes through syncOpenEditorsAfterDiskMutation, which cancels
    // the still-armed body writer.
    await toast?.actions?.[1].handler();

    // Drain anything still pending. With the cancel in place the armed timer
    // was disarmed before this flush — its PRE-RECOVERY body never lands.
    await flushMarkdownWrite(callerId);
    unregisterForceWriter(callerId);

    // Confirm: no `vault:write-existing-file-text` carrying the armed PRE-RECOVERY body.
    const existingWrite = lastWriteContent(captured, relPath);
    expect(existingWrite ?? '').not.toContain('PRE-RECOVERY armed body');

    // The doc itself is no longer dirty after the recovery (applyReloadFromDisk
    // resets isDirty to false alongside the cancel).
    const doc = documentStore.getDocument(docId);
    expect(doc?.isDirty).toBe(false);
  });
});

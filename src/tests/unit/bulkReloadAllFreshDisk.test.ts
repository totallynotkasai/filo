/**
 * "Reload" on a conflict prompt applies the file as it is when the user
 * clicks, not as it was when the conflict was detected: a second external
 * write landing between the watcher event and the click must not be lost.
 * The same holds for every note in a batch of external changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

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

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('Reload applies the current disk bytes', () => {
  const FILES = Array.from({ length: 6 }, (_, i) => `Notes${i}.md`);
  const v = (n: number): string => `---\nstatus: v${n}\n---\nbody${n}\n`;
  let vault: MemoryVault;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('/vault');
    vault = installMemoryVault(Object.fromEntries(FILES.map((f) => [f, v(1)])));
    registerNotePrompts();
    slice = makeExternalChangesSlice(makeCtx());
  });

  afterEach(() => {
    noteStore.__resetForTests();
    vaultStore.setPath('');
    vaultIndexStore.clear();
    clearToasts();
    restoreFiloDefault();
  });

  it('every conflicted note reloads the LATEST bytes when a file changed again after detection', async () => {
    for (const rel of FILES) {
      const m = noteStore.acquire(rel, `doc:${rel}`);
      await m.loaded;
      noteStore.setBody(rel, 'dirty local', `doc:${rel}`);
    }

    // External edit #1: every file moves to v2 while the local edits are unsaved.
    for (const rel of FILES) vault.writeExternally(rel, v(2));
    await slice.handleExternalMarkdownChanges(FILES);
    await settle();

    const prompts = uiStore.toasts.filter((t) => t.actions?.some((a) => a.label === 'Reload'));
    expect(prompts).toHaveLength(FILES.length);
    for (const rel of FILES) expect(noteStore.get(rel)?.status).toBe('conflict');

    // External edit #2 (v3) lands before the user clicks; no new watcher event.
    for (const rel of FILES) vault.writeExternally(rel, v(3));

    for (const toast of prompts) {
      await toast.actions?.find((a) => a.label === 'Reload')?.handler();
    }
    await settle();

    for (const rel of FILES) {
      const m = noteStore.get(rel);
      expect(m?.body, `${rel} should reload v3`).toBe('body3\n');
      expect(m?.frontmatter).toEqual({ status: 'v3' });
      expect(m?.hasUnsavedBody).toBe(false);
    }
    await noteStore.flushAll();
    for (const rel of FILES) expect(vault.read(rel)).toBe(v(3));
  });
});

/**
 * A clean note follows a change on disk without asking. When that reload is a
 * material shrink (the new body under half of a non-trivial prior body, as a
 * sync client's truncation looks), an "Undo reload" toast offers the prior
 * body back: it backs up the short version, then puts the prior body in as an
 * unsaved edit that the writer lands over the truncation. Routine edits and
 * growth reload silently.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { noteStore, type NoteModel } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetKeepLocalBackupForTests } from '@renderer/lib/vault/keepLocalBackup';
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

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
}

const shrankToast = () => uiStore.toasts.find((t) => t.text.includes('much shorter'));

describe('a clean note reloaded from disk', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let vault: MemoryVault;
  let m: NoteModel;

  const bigBody = '# Note\n' + 'x'.repeat(2000) + '\n';

  async function changeOnDisk(body: string): Promise<void> {
    vault.writeExternally('Notes.md', body);
    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await waitFor(() => m.body === body);
  }

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    __resetKeepLocalBackupForTests();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    registerNotePrompts();
    vault = installMemoryVault({ 'Notes.md': bigBody });
    slice = makeExternalChangesSlice(makeCtx());
    m = noteStore.acquire('Notes.md', 'tile');
    await m.loaded;
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
    vaultIndexStore.clear();
    clearToasts();
    vi.restoreAllMocks();
  });

  it('offers Undo reload on a material shrink, which writes the prior body back', async () => {
    const shrunk = '# Note\n' + 'x'.repeat(700) + '\n';
    await changeOnDisk(shrunk);

    // The reload landed the shrunk body…
    expect(m.body).toBe(shrunk);
    // …and a recovery toast was surfaced.
    const undo = shrankToast()?.actions?.find((a) => a.label === 'Undo reload');
    expect(undo).toBeDefined();

    await undo?.handler();
    expect(m.body).toBe(bigBody);
    expect(m.hasUnsavedBody).toBe(true);
    // The short version was backed up before the prior body goes back over it.
    expect(vi.mocked(window.filo.invoke).mock.calls.some((c) => c[0] === 'recovery:snapshot' && c[2] === 'Notes.md')).toBe(true);

    await noteStore.flushAll();
    expect(vault.read('Notes.md')).toBe(bigBody);
  });

  it('Keep reloaded leaves the disk version', async () => {
    const shrunk = '# Note\n' + 'x'.repeat(700) + '\n';
    await changeOnDisk(shrunk);
    await shrankToast()?.actions?.find((a) => a.label === 'Keep reloaded')?.handler();
    await noteStore.flushAll();
    expect(m.body).toBe(shrunk);
    expect(vault.read('Notes.md')).toBe(shrunk);
  });

  it('does NOT offer recovery for a modest shrink (a real edit)', async () => {
    const trimmed = '# Note\n' + 'x'.repeat(1500) + '\n';
    await changeOnDisk(trimmed);
    expect(m.body).toBe(trimmed);
    expect(shrankToast()).toBeUndefined();
  });

  it('does NOT offer recovery when the file grew', async () => {
    const grown = '# Note\n' + 'x'.repeat(3000) + '\n';
    await changeOnDisk(grown);
    expect(m.body).toBe(grown);
    expect(shrankToast()).toBeUndefined();
  });
});

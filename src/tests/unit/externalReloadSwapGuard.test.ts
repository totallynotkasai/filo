/**
 * An external change to a note re-reads disk and then updates the open note
 * keyed by its relative path. A vault swap landing on that await would apply
 * the OUTGOING vault's bytes to the NEW vault's same-named note. Each step
 * re-checks the vault after its read: the external-change handler after the
 * index refresh, `noteStore.onDiskChanged` after its fresh read, and the
 * conflict's "Reload" after its read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { noteStore, setNotePromptHandlers, type NoteModel } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), reloadShrank: vi.fn(), dismiss: vi.fn() };

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
    resolveRecoveryDismissed: () => {},
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

async function loaded(rel: string): Promise<NoteModel> {
  const m = noteStore.acquire(rel, 'view');
  await m.loaded;
  return m;
}

/** Lets the fire-and-forget `onDiskChanged` the handler starts settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** What a vault swap's pre-swap does to the note store, plus the new vault's identity. */
function swapVault(): void {
  noteStore.__resetForTests();
  setActiveVaultPath('/vault-B');
  beginVaultGeneration('/vault-B');
}

describe('external note reloads bail on a vault swap mid-read', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    beginVaultGeneration('/vault');
    setActiveVaultPath('/vault');
    vault = installMemoryVault({ 'Note.md': '---\ntitle: Note\n---\nLocal body\n' });
    vaultIndexStore.clear();
    noteStore.__resetForTests();
    for (const fn of Object.values(prompts)) fn.mockReset();
    setNotePromptHandlers(prompts);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    __resetVaultIdentityForTests();
    setActiveVaultPath('');
    restoreFiloDefault();
  });

  it('the external-change handler leaves the open note alone when the vault swaps during the index refresh', async () => {
    const m = await loaded('Note.md');
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nOutgoing vault body\n');
    const onDisk = vi.spyOn(noteStore, 'onDiskChanged');
    vi.spyOn(vaultIndexStore, 'applyChanges').mockImplementation(async () => {
      beginVaultGeneration('/vault-B');
    });

    await makeExternalChangesSlice(ctxFor()).handleExternalMarkdownChanges(['Note.md']);
    await settle();

    expect(onDisk).not.toHaveBeenCalled();
    expect(m.body).toBe('Local body\n');
  });

  it('control: with no swap the clean open note follows the disk', async () => {
    const m = await loaded('Note.md');
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nDisk body\n');

    await makeExternalChangesSlice(ctxFor()).handleExternalMarkdownChanges(['Note.md']);
    await settle();

    expect(m.body).toBe('Disk body\n');
  });

  it('onDiskChanged does not adopt a read that finished after the vault changed', async () => {
    const m = await loaded('Note.md');
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nOutgoing vault body\n');
    vault.afterRead = () => {
      setActiveVaultPath('/vault-B');
      beginVaultGeneration('/vault-B');
    };

    await noteStore.onDiskChanged('Note.md');

    expect(m.body).toBe('Local body\n');
    expect(m.base?.rawText).toBe('---\ntitle: Note\n---\nLocal body\n');
  });

  it('a conflict\'s Reload does not apply the outgoing vault\'s bytes after a swap mid-read', async () => {
    const m = await loaded('Note.md');
    noteStore.setBody('Note.md', 'Mine', 'view');
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nTheirs\n');
    await noteStore.onDiskChanged('Note.md');
    expect(m.status).toBe('conflict');

    vault.afterRead = () => swapVault();
    await noteStore.resolveConflict('Note.md', 'reload');

    expect(m.body).toBe('Mine');
    expect(m.status).toBe('conflict');
    expect(vault.writes.filter(([, rel]) => rel.endsWith('.md'))).toHaveLength(0);
  });
});

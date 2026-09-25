/**
 * An unsaved body edit meets an external rewrite of the same note (body and
 * tags). Until the user answers the prompt, nothing the app shows moves to
 * the external version: not the body, not the tags. "Reload" then takes the
 * external body and tags together; "Keep mine" writes the local body onto the
 * external version, so the external tags (which the user never edited here)
 * survive alongside it and nothing from either side is lost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { noteStore, type NoteModel } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetKeepLocalBackupForTests } from '@renderer/lib/vault/keepLocalBackup';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const THEIRS = '---\ntags: [theirs]\n---\nexternally rewritten body\n';

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

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('dirty editor + external body and tag rewrite', () => {
  let vault: MemoryVault;
  let snapshots: string[];
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let model: NoteModel;

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    __resetKeepLocalBackupForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'Notes.md': '---\ntags: [mine]\n---\nlocal body\n' });
    // The memory vault answers the note channels; the Keep-mine backup
    // snapshot is recorded here.
    const memoryFilo: object = Reflect.get(window, 'filo');
    const memoryInvoke: (channel: string, ...args: unknown[]) => Promise<unknown> = Reflect.get(memoryFilo, 'invoke');
    snapshots = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'recovery:snapshot') {
        snapshots.push(args[1] as string);
        return { success: true, path: '/vault/.filo/recovery/Notes.md' };
      }
      return memoryInvoke(channel, ...args);
    });
    registerNotePrompts();
    slice = makeExternalChangesSlice(makeCtx());
    await vaultIndexStore.applyChanges(['Notes.md']);

    model = noteStore.acquire('Notes.md', 'doc');
    await model.loaded;
    noteStore.setBody('Notes.md', 'local body+', 'doc');

    vault.writeExternally('Notes.md', THEIRS);
    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await settle();
  });

  afterEach(() => {
    noteStore.__resetForTests();
    vaultStore.setPath('');
    vaultIndexStore.clear();
    clearToasts();
    restoreFiloDefault();
  });

  function prompt(): (typeof uiStore.toasts)[number] | undefined {
    return uiStore.toasts.find((t) => t.actions?.some((a) => a.label === 'Reload'));
  }

  it('does NOT show the external tags or body while the prompt is open', () => {
    expect(model.status).toBe('conflict');
    expect(fileTagsStore.tagsForFile('Notes.md')).toEqual(['mine']);
    expect(model.body).toBe('local body+');
    expect(prompt()?.actions?.map((a) => a.label)).toEqual(['Reload', 'Keep mine']);
    expect(vault.read('Notes.md')).toBe(THEIRS);
  });

  it('Reload applies the external frontmatter + tags together with the body', async () => {
    await prompt()?.actions?.find((a) => a.label === 'Reload')?.handler();
    await settle();

    expect(fileTagsStore.tagsForFile('Notes.md')).toEqual(['theirs']);
    expect(model.body).toBe('externally rewritten body\n');
    expect(model.hasUnsavedBody).toBe(false);
    await noteStore.flushAll();
    expect(vault.read('Notes.md')).toBe(THEIRS);
  });

  it('Keep mine backs up the external version, then writes the local body over it', async () => {
    await prompt()?.actions?.find((a) => a.label === 'Keep mine')?.handler();
    await settle();

    expect(snapshots).toEqual(['Notes.md']);
    expect(model.body).toBe('local body+');
    expect(model.status).toBe('ready');
    expect(vault.read('Notes.md')).toBe('---\ntags: [theirs]\n---\nlocal body+\n');
    expect(fileTagsStore.tagsForFile('Notes.md')).toEqual(['theirs']);
  });
});

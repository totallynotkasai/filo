import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { noteStore } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { TaskListBoard as TaskListBoardType } from '@renderer/schema/index';
import { boardDefaults } from '@renderer/core/boardDefaults';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * When a tagged `.md` file is deleted externally and the user confirms the
 * deletion, its `.filo/tags.json:fileTags[path]` entry must be dropped.
 * Otherwise the orphan lingers until the next vault-open `pruneOrphanFileTags`,
 * inflating tag counts for the rest of the session.
 *
 * The drop fires only from a user-confirmed removal, never eagerly on the
 * delete event: an uncorrelated external move can surface as delete-then-rename
 * within ~500ms, and an early drop would lose the tags on the moved file.
 * Keeping the tiles, or writing the note back ("Keep mine"), must NOT drop.
 */

const NOTE = '---\ntitle: Notes\n---\nbody\n';

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

/** A closed Task List board with one row backed by `filePath`. */
function hydrateBoardPointingAt(filePath: string): void {
  const base = boardDefaults.tasklist('k1', 'T');
  if (base.type !== 'tasklist') throw new Error('expected a Task List board');
  const board: TaskListBoardType = { ...base, tasks: [{ tileId: 't1', position: 0 }] };
  boardCacheStore.hydrate(
    {
      k1: {
        version: 8,
        board,
        tileDefs: {
          t1: {
            id: 't1',
            type: 'text',
            filePath,
            style: { headerColor: '', bodyColor: '', borderColor: '' },
            createdAt: 0,
            updatedAt: 0,
          },
        },
        connections: {},
        frames: [],
      },
    },
    { k1: 'T.board.json' },
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('vaultExternalChanges — external delete drops tags.json entry only when confirmed', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let vault: MemoryVault;

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'Notes.md': NOTE });
    noteStore.__resetForTests();
    registerNotePrompts();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    slice = makeExternalChangesSlice(makeCtx());
    await vaultIndexStore.applyChanges(['Notes.md']);
    await fileTagsStore.hydrate('/vault');
    fileTagsStore.setFileTags('Notes.md', ['mytag']);
    expect(fileTagsStore.file.fileTags['notes.md']).toEqual(['mytag']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  function missingToast() {
    return uiStore.toasts.find((t) => t.text.includes('Notes.md') && t.text.includes('missing from the vault'));
  }

  it('drops the file from tags.json when the user confirms removing its tiles', async () => {
    hydrateBoardPointingAt('Notes.md');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    // Not dropped eagerly on the delete event.
    expect(fileTagsStore.file.fileTags['notes.md']).toEqual(['mytag']);

    const toast = missingToast();
    const remove = toast?.actions?.find((a) => a.label.startsWith('Remove'));
    expect(remove).toBeDefined();
    await remove?.handler();
    const dialog = uiStore.confirmDialog!;
    expect(dialog.danger).toBe(true);
    uiStore.closeConfirm();
    dialog.onConfirm(false);
    for (let i = 0; i < 20 && fileTagsStore.file.fileTags['notes.md']; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(fileTagsStore.file.fileTags['notes.md']).toBeUndefined();
  });

  it('keeps the tags.json entry when the user keeps the tiles', async () => {
    hydrateBoardPointingAt('Notes.md');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    const keep = missingToast()?.actions?.find((a) => a.label.startsWith('Keep tiles'));
    expect(keep).toBeDefined();
    await keep?.handler();
    await settle();

    expect(fileTagsStore.file.fileTags['notes.md']).toEqual(['mytag']);
  });

  it('keeps the tags.json entry when the user writes an edited note back (Keep mine)', async () => {
    const m = noteStore.acquire('Notes.md', 'view');
    await m.loaded;
    noteStore.setBody('Notes.md', 'unsaved edit', 'view');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await settle();
    const toast = uiStore.toasts.find((t) => t.text.includes('deleted by another program'));
    const keepMine = toast?.actions?.find((a) => a.label === 'Keep mine');
    expect(keepMine).toBeDefined();
    await keepMine?.handler();
    await settle();

    // The note is back with the local body, so its tags are still valid.
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\n---\nunsaved edit\n');
    expect(fileTagsStore.file.fileTags['notes.md']).toEqual(['mytag']);
  });

  it('drops the tags.json entry when the user discards an edited note deleted on disk', async () => {
    hydrateBoardPointingAt('Notes.md');
    const m = noteStore.acquire('Notes.md', 'view');
    await m.loaded;
    noteStore.setBody('Notes.md', 'unsaved edit', 'view');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await settle();
    const toast = uiStore.toasts.find((t) => t.text.includes('deleted by another program'));
    const discard = toast?.actions?.find((a) => a.label === 'Discard');
    expect(discard).toBeDefined();
    await discard?.handler();
    await settle();

    // Discard accepted the deletion: the orphan fileTags entry is gone, and
    // the tiles that point at nothing get the "remove tiles" offer.
    expect(fileTagsStore.file.fileTags['notes.md']).toBeUndefined();
    expect(uiStore.toasts.some((t) => t.dedupeKey === 'missing:Notes.md')).toBe(true);
  });
});

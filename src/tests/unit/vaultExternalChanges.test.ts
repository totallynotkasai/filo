import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { noteStore, type NoteModel } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import { __resetKeepLocalBackupForTests } from '@renderer/lib/vault/keepLocalBackup';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * `handleExternalMarkdownChanges` — what the watcher's `.md` changes do:
 *  - an open note with an unsaved edit that another program deleted asks
 *    "Keep mine" / "Discard" and writes nothing until the user answers; Keep
 *    mine re-creates the file exclusively with its frontmatter and the local
 *    body;
 *  - a clean open note follows the disk, keeping the other program's
 *    frontmatter source (comments) for the next save;
 *  - a deleted file that tiles still point at offers to remove them;
 *  - a vault swap during the index refresh drops the change.
 */

function clearToasts(): void {
  // Snapshot the array first — dismissToast filters in place.
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

function makeCtx(): VaultContext {
  return {
    getVaultPath: () => '/vault',
    // Unused by the slice — minimal stub to satisfy the VaultContext shape.
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
    resolveRecoveryDismissed: () => {},
  };
}

let vault: MemoryVault;
let slice: ReturnType<typeof makeExternalChangesSlice>;

beforeEach(() => {
  // Runs the test-reset callbacks, which clear the active vault path.
  __resetDirtyTrackingForTests();
  vaultStore.setPath('/vault');
  noteStore.__resetForTests();
  __resetErrorBusForTests();
  __resetKeepLocalBackupForTests();
  vaultIndexStore.clear();
  boardCacheStore.clear();
  clearToasts();
  registerNotePrompts();
  vault = installMemoryVault({ 'Notes.md': '---\ntags:\n  - local-tag\n---\nbody\n' });
  slice = makeExternalChangesSlice(makeCtx());
});

afterEach(() => {
  noteStore.__resetForTests();
  restoreFiloDefault();
  vaultStore.setPath('');
  vaultIndexStore.clear();
  boardCacheStore.clear();
  clearToasts();
  vi.restoreAllMocks();
});

/** Opens `rel` in a view and types `body` without saving it. */
async function openWithUnsavedBody(rel: string, body: string): Promise<NoteModel> {
  const m = noteStore.acquire(rel, 'editor');
  await m.loaded;
  noteStore.setBody(rel, body, 'editor');
  return m;
}

const deletedToast = () => uiStore.toasts.find((t) => t.text.includes('was deleted by another program'));
const noteWrites = (rel: string) => vault.writes.filter(([, r]) => r === rel);

describe('vaultExternalChanges — external delete of a note with an unsaved edit', () => {
  it('a failed Keep mine is surfaced and keeps the edit unsaved', async () => {
    const m = await openWithUnsavedBody('Notes.md', 'local\n');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await vi.waitFor(() => expect(deletedToast()).toBeDefined());

    vault.failNextWrite('Notes.md', 'EROFS');
    await Promise.resolve(deletedToast()?.actions?.[0].handler()).catch(() => undefined);

    expect(vault.read('Notes.md')).toBeUndefined();
    expect(m.body).toBe('local\n');
    expect(m.hasUnsavedBody).toBe(true);
    expect(noteStore.hasPendingWrites('Notes.md')).toBe(true);
  });

  it('surfaces a persistent Keep mine / Discard toast', async () => {
    await openWithUnsavedBody('Notes.md', 'dirty\n');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    await vi.waitFor(() => expect(deletedToast()).toBeDefined());
    const toast = deletedToast();
    expect(toast?.type).toBe('warning');
    expect(toast?.duration).toBe(0);
    expect(toast?.actions?.map((a) => a.label)).toEqual(['Keep mine', 'Discard']);
  });

  it('does NOT silently re-create the deleted file (no write fires before the user chooses)', async () => {
    await openWithUnsavedBody('Notes.md', 'dirty\n');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await vi.waitFor(() => expect(deletedToast()).toBeDefined());
    await noteStore.flushAll();

    expect(noteWrites('Notes.md')).toEqual([]);
    expect(vault.read('Notes.md')).toBeUndefined();
  });

  it('Discard drops the unsaved edit and leaves the file deleted', async () => {
    const m = await openWithUnsavedBody('Notes.md', 'dirty\n');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await vi.waitFor(() => expect(deletedToast()).toBeDefined());

    await deletedToast()?.actions?.[1].handler();

    expect(m.hasUnsavedBody).toBe(false);
    expect(m.status).toBe('missing');
    await noteStore.flushAll();
    expect(vault.read('Notes.md')).toBeUndefined();
  });

  it('Keep mine re-creates the file exclusively with its frontmatter and the local body', async () => {
    const m = await openWithUnsavedBody('Notes.md', 'local body\n');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await vi.waitFor(() => expect(deletedToast()).toBeDefined());

    await deletedToast()?.actions?.[0].handler();

    const writes = noteWrites('Notes.md');
    expect(writes.map(([channel]) => channel)).toEqual(['vault:create-file-text']);
    expect(vault.read('Notes.md')).toBe('---\ntags:\n  - local-tag\n---\nlocal body\n');
    expect(m.hasUnsavedBody).toBe(false);
  });

});

describe('vaultExternalChanges — changes that ask nothing', () => {
  it('a change to a file nobody has open and no tile uses surfaces no toast', async () => {
    await slice.handleExternalMarkdownChanges(['Phantom.md']);
    expect(uiStore.toasts).toHaveLength(0);
  });

  it('a new file first seen by the watcher surfaces no toast', async () => {
    vault.writeExternally('NewTile.md', '---\ntags: []\n---\nfresh body\n');
    await slice.handleExternalMarkdownChanges(['NewTile.md']);
    expect(uiStore.toasts).toHaveLength(0);
    expect(vaultIndexStore.getMetadata('NewTile.md')).toBeDefined();
  });
});

describe('vaultExternalChanges — a clean open note follows a frontmatter edit', () => {
  it('keeps the other program\'s frontmatter source (inline comment) through the next save', async () => {
    vault.writeExternally('Note.md', '---\ntitle: Hello\npriority: low   # inline note\n---\nbody\n');
    const m = noteStore.acquire('Note.md', 'editor');
    await m.loaded;

    // External editor flips priority and keeps the inline comment.
    vault.writeExternally('Note.md', '---\ntitle: Hello\npriority: high   # inline note\n---\nbody\n');
    await slice.handleExternalMarkdownChanges(['Note.md']);
    await vi.waitFor(() => expect(m.frontmatter.priority).toBe('high'));

    // A body-only save must not re-emit the changed line and lose its comment.
    noteStore.setBody('Note.md', 'edited body\n', 'editor');
    expect(await noteStore.flush('Note.md')).toBe(true);
    expect(vault.read('Note.md')).toBe('---\ntitle: Hello\npriority: high   # inline note\n---\nedited body\n');
    expect(uiStore.toasts).toHaveLength(0);
  });
});

describe('vaultExternalChanges — a deleted file that tiles still use', () => {
  function kanbanWithTileOn(rel: string): V7BoardFileData {
    return {
      board: {
        id: 'kb',
        type: 'kanban',
        name: 'Tasks',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        columns: [{ id: 'c1', title: 'To Do', position: 0, collapsed: false, tilePlacements: [{ tileId: 't1' }] }],
      } satisfies Partial<KanbanBoard> as KanbanBoard,
      tileDefs: {
        t1: { id: 't1', type: 'text', filePath: rel, style: { headerColor: '', bodyColor: '', borderColor: '' }, createdAt: 0, updatedAt: 0 },
      },
      connections: {},
      frames: [],
    };
  }

  it('offers to keep or remove the tiles, and removes nothing by itself', async () => {
    boardCacheStore.hydrate({ kb: kanbanWithTileOn('Notes.md') }, { kb: 'tasks.board.json' });
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    const toast = uiStore.toasts.find((t) => t.text.includes('is missing from the vault'));
    expect(toast).toBeDefined();
    expect(toast?.actions?.[0].label).toBe('Keep tiles (show as missing)');
    expect(boardCacheStore.cache.kb.tileDefs.t1).toBeDefined();
  });

  it('a note with an unsaved edit gets the note prompt instead of the tiles prompt', async () => {
    boardCacheStore.hydrate({ kb: kanbanWithTileOn('Notes.md') }, { kb: 'tasks.board.json' });
    await openWithUnsavedBody('Notes.md', 'dirty\n');
    vault.remove('Notes.md');

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await vi.waitFor(() => expect(deletedToast()).toBeDefined());
    expect(uiStore.toasts.find((t) => t.text.includes('is missing from the vault'))).toBeUndefined();
  });
});

/**
 * `handleExternalMarkdownChanges` captures the active vault identity before
 * its awaits and bails if a vault swap lands during them. Without the guard,
 * a swap mid-await applies the OUTGOING vault's change to the NEW vault's
 * same-named note — here, replacing a clean note's body with the other
 * vault's content.
 */
describe('vaultExternalChanges — vault swap during the index refresh bails before clobbering', () => {
  it('does NOT reload a clean note when the vault swaps during the refresh', async () => {
    vault.writeExternally('Notes.md', '---\ntags: [a]\n---\noriginal body\n');
    const m = noteStore.acquire('Notes.md', 'editor');
    await m.loaded;

    vault.writeExternally('Notes.md', '---\ntags: [a]\n---\nEXTERNAL CLOBBER\n');
    let swapped = false;
    vault.afterRead = () => {
      if (swapped) return;
      swapped = true;
      beginVaultGeneration('/vault'); // close→reopen: stale captured identity
    };

    await slice.handleExternalMarkdownChanges(['Notes.md']);
    await new Promise((r) => setTimeout(r, 20));

    expect(swapped).toBe(true);
    expect(m.body).toBe('original body\n');
  });

  it('control: WITHOUT a swap, the same external change DOES reload the clean note', async () => {
    vault.writeExternally('Notes.md', '---\ntags: [a]\n---\noriginal body\n');
    const m = noteStore.acquire('Notes.md', 'editor');
    await m.loaded;

    vault.writeExternally('Notes.md', '---\ntags: [a]\n---\nEXTERNAL CLOBBER\n');
    await slice.handleExternalMarkdownChanges(['Notes.md']);

    await vi.waitFor(() => expect(m.body).toBe('EXTERNAL CLOBBER\n'));
  });
});

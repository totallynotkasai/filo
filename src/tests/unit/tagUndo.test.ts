import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  undoRemoval,
  undoRename,
  isMergingRename,
  resumeTagSweep,
  removeTagWithUndo,
  renameTagWithUndo,
  type TagRemovalSnapshot,
  type TagRenameSnapshot,
} from '@renderer/stores/tagUndo.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { beginVaultGeneration, captureVaultIdentity, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import { ViewHydration } from '@renderer/stores/boardViewRevision.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

/**
 * Undo of a vault-wide tag delete puts the tag back in the notes the delete
 * rewrote, on their bytes as they stand at Undo time, and does nothing once
 * the vault has changed. Undo of a rename refuses to merge.
 */

let vault: MemoryVault;

function snapshot(overrides: Partial<TagRemovalSnapshot> = {}): TagRemovalSnapshot {
  return {
    identity: captureVaultIdentity(),
    tagName: 'work',
    color: '#123456',
    writtenPaths: ['A.md'],
    mediaPaths: [],
    tiles: [],
    chips: [],
    ...overrides,
  };
}

beforeEach(() => {
  __resetVaultIdentityForTests();
  vault = installMemoryVault({ 'A.md': '---\ntitle: A\n---\nBody\n', 'B.md': '---\ntitle: B\n---\nOther\n' });
  vaultStore.setPath('/vault');
  beginVaultGeneration('/vault');
  vi.spyOn(fileTagsStore, 'flushPendingSave').mockResolvedValue({ ok: true });
  vi.spyOn(boardCacheStore, 'flushAllDirty').mockResolvedValue({ failed: [] } as unknown as Awaited<ReturnType<typeof boardCacheStore.flushAllDirty>>);
});

afterEach(() => {
  vi.restoreAllMocks();
  noteStore.__resetForTests();
  vaultStore.setPath('');
  restoreFiloDefault();
});

describe('undo of a tag delete', () => {
  it('re-adds the tag to exactly the notes the delete rewrote, keeping an edit made since', async () => {
    const snap = snapshot();
    vault.writeExternally('A.md', '---\ntitle: A\n---\nBody, edited since\n');

    await undoRemoval(snap);

    expect(vault.read('A.md')).toBe('---\ntitle: A\ntags:\n  - work\n---\nBody, edited since\n');
    expect(vault.read('B.md')).toBe('---\ntitle: B\n---\nOther\n');
    expect(fileTagsStore.getDefinition('work').color).toBe('#123456');
  });

  it('a note deleted since is skipped without an error toast', async () => {
    const toast = vi.spyOn(uiStore, 'pushToast');
    vault.remove('A.md');

    await undoRemoval(snapshot());

    expect(vault.read('A.md')).toBeUndefined();
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('after a vault swap, Undo writes nothing', async () => {
    const snap = snapshot();
    beginVaultGeneration('/other');
    const writesBefore = vault.writes.length;

    await undoRemoval(snap);

    expect(vault.writes.length).toBe(writesBefore);
    expect(vault.read('A.md')).toBe('---\ntitle: A\n---\nBody\n');
  });
});

describe('undo of a tag rename', () => {
  function renameSnapshot(overrides: Partial<TagRenameSnapshot> = {}): TagRenameSnapshot {
    return {
      identity: captureVaultIdentity(),
      oldName: 'old',
      newName: 'fresh',
      color: undefined,
      writtenPaths: [],
      mediaPaths: [],
      tiles: [],
      chips: [],
      ...overrides,
    };
  }

  afterEach(() => fileTagsStore.reset());

  it('refuses when the old name exists again, in any spelling, since renaming back would merge', async () => {
    vi.spyOn(fileTagsStore, 'allTagNames').mockReturnValue(['Old', 'fresh']);
    const setFileTags = vi.spyOn(fileTagsStore, 'setFileTags');
    const toast = vi.spyOn(uiStore, 'toast');

    await undoRename(renameSnapshot({ mediaPaths: ['pic.png'] }));

    expect(setFileTags).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('exists again'), 'warning', expect.any(Number));
  });

  it('renames back only the attachments the rename changed', async () => {
    fileTagsStore.commitFromCandidate('/vault', {
      version: 1,
      tags: { fresh: { color: '#3a86ff', createdAt: 0 } },
      fileTags: { 'a.png': ['fresh'], 'b.png': ['fresh'] },
    } as unknown as Parameters<typeof fileTagsStore.commitFromCandidate>[1]);

    await undoRename(renameSnapshot({ mediaPaths: ['a.png'], color: '#123456' }));

    expect(fileTagsStore.tagsForFile('a.png')).toEqual(['old']);
    expect(fileTagsStore.tagsForFile('b.png')).toEqual(['fresh']);
    expect(fileTagsStore.getDefinition('old').color).toBe('#123456');
    // Still carried by b.png, so its definition stays.
    expect(fileTagsStore.allTagNames()).toContain('fresh');
  });

  it("Resume of a crashed Undo renames back only the attachments that Undo recorded", async () => {
    // Renamed old → fresh; b.png was tagged "fresh" afterwards; the Undo crashed.
    fileTagsStore.commitFromCandidate('/vault', {
      version: 1,
      tags: { fresh: { color: '#3a86ff', createdAt: 0 } },
      fileTags: { 'a.png': ['fresh'], 'b.png': ['fresh'] },
    } as unknown as Parameters<typeof fileTagsStore.commitFromCandidate>[1]);

    await resumeTagSweep({
      timestamp: 1,
      oldName: 'fresh',
      newName: 'old',
      plan: [],
      preexistingNewNamePaths: [],
      committedPaths: [],
      scoped: true,
      undoOfRename: { mediaPaths: ['a.png'], tiles: [], chips: [] },
    });

    expect(fileTagsStore.tagsForFile('a.png')).toEqual(['old']);
    expect(fileTagsStore.tagsForFile('b.png')).toEqual(['fresh']);
  });

  it('after a vault swap, Undo renames nothing', async () => {
    const snap = renameSnapshot({ mediaPaths: ['pic.png'] });
    beginVaultGeneration('/other');
    const setFileTags = vi.spyOn(fileTagsStore, 'setFileTags');

    await undoRename(snap);

    expect(setFileTags).not.toHaveBeenCalled();
  });
});

describe('tagExists', () => {
  afterEach(() => fileTagsStore.reset());

  it('is case-folded, and counts a tag carried but never registered', () => {
    fileTagsStore.commitFromCandidate('/vault', {
      version: 1,
      tags: { review: { color: '#3a86ff', createdAt: 0 } },
      fileTags: { 'a.png': ['Waiting'] },
    } as unknown as Parameters<typeof fileTagsStore.commitFromCandidate>[1]);

    expect(fileTagsStore.tagExists('Review')).toBe(true);
    expect(fileTagsStore.tagExists('waiting')).toBe(true);
    expect(fileTagsStore.tagExists('blocked')).toBe(false);
    expect(isMergingRename('review', 'Review')).toBe(false);
    expect(isMergingRename('blocked', 'WAITING')).toBe(true);
  });
});

describe('undo of a tag delete: filter chips on a mounted view', () => {
  function kanban(filterTags: string[]): BoardFileData {
    return {
      version: 8,
      board: {
        id: 'kb', type: 'kanban', name: 'K', emoji: '', createdAt: 0, updatedAt: 0,
        settings: { lastView: { sortBy: 'manual', filterTags: [...filterTags], filterProp: null } },
        columns: [],
      } as unknown as KanbanBoard,
      tileDefs: {},
      connections: {},
      frames: [],
    };
  }

  function lastViewTags(): string[] {
    const s = boardCacheStore.cache.kb?.board.settings as { lastView?: { filterTags?: string[] } } | undefined;
    return s?.lastView?.filterTags ?? [];
  }

  afterEach(() => boardCacheStore.clear());

  it('the restored chip survives the view writing its filters back on its next save', async () => {
    // The state after the delete: the chip is gone, and the mounted view has
    // hydrated its filters from that `lastView`.
    boardCacheStore.hydrate({ kb: kanban(['keep']) }, { kb: 'K.board.json' });
    vi.spyOn(boardCacheStore, 'markDirty').mockImplementation(() => {});
    const view = new ViewHydration();
    view.mark('kb');
    let viewFilters = [...lastViewTags()];
    const settingsBefore = boardCacheStore.cache.kb?.board.settings;

    await undoRemoval(snapshot({ writtenPaths: [], chips: [{ boardId: 'kb', slot: 'lastView', index: 0 }] }));

    // What a mounted Kanban / Task List does before its save: hydrate again
    // only when the revision moved on, then write its filters to `lastView`.
    if (view.needs('kb')) {
      viewFilters = [...lastViewTags()];
      view.mark('kb');
    }
    const settings = boardCacheStore.cache.kb!.board.settings as { lastView: { filterTags: string[] } };
    settings.lastView.filterTags = viewFilters;

    expect(lastViewTags()).toEqual(['work', 'keep']);
    expect(boardCacheStore.cache.kb?.board.settings).not.toBe(settingsBefore);
  });
});

describe('the Undo on a vault-wide tag action toast', () => {
  const tagToasts = (): Array<{ text: string; actions: string[] }> =>
    uiStore.toasts
      .filter((t) => /^(Deleted tag|Renamed|Merged) /.test(t.text))
      .map((t) => ({ text: t.text, actions: (t.actions ?? []).map((a) => a.label) }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(boardCacheStore, 'ensureAllLoaded').mockResolvedValue([]);
    vi.spyOn(vaultIndexStore, 'whenBuildComplete').mockResolvedValue(undefined);
    vi.spyOn(fileTagsStore, 'removeTagEverywhere').mockResolvedValue({ committed: true, writtenPaths: ['A.md'] });
    vi.spyOn(fileTagsStore, 'renameTagEverywhere').mockResolvedValue({ committed: true, writtenPaths: ['A.md'] });
  });

  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    vi.useRealTimers();
  });

  it('stays on offer until dismissed', async () => {
    expect(await removeTagWithUndo('work')).toBe(true);
    expect(tagToasts()).toEqual([{ text: 'Deleted tag "#work" from 1 item.', actions: ['Undo'] }]);

    vi.advanceTimersByTime(10 * 60_000);
    expect(tagToasts()).toEqual([{ text: 'Deleted tag "#work" from 1 item.', actions: ['Undo'] }]);

    uiStore.dismissToast(uiStore.toasts.find((t) => t.text.startsWith('Deleted tag'))!.id);
    expect(tagToasts()).toEqual([]);
  });

  it('a newer tag action replaces it, Undo and all', async () => {
    vi.spyOn(fileTagsStore, 'tagExists').mockReturnValue(false);
    await removeTagWithUndo('work');
    await renameTagWithUndo('old', 'fresh');
    expect(tagToasts()).toEqual([{ text: 'Renamed "#old" to "#fresh".', actions: ['Undo'] }]);

    // A merge has no Undo; it still replaces the older Undo, and goes in time.
    vi.spyOn(fileTagsStore, 'tagExists').mockReturnValue(true);
    await renameTagWithUndo('fresh', 'other');
    expect(tagToasts()).toEqual([{ text: 'Merged "#fresh" into "#other".', actions: [] }]);
    vi.advanceTimersByTime(60_000);
    expect(tagToasts()).toEqual([]);
  });
});

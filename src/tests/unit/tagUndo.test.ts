import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { undoRemoval, undoRename, type TagRemovalSnapshot } from '@renderer/stores/tagUndo.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { beginVaultGeneration, captureVaultIdentity, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

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
  it('refuses when the old name exists again, since renaming back would merge', async () => {
    vi.spyOn(fileTagsStore, 'allTagNames').mockReturnValue(['old', 'fresh']);
    const rename = vi.spyOn(fileTagsStore, 'renameTagEverywhere');
    const toast = vi.spyOn(uiStore, 'toast');

    await undoRename(captureVaultIdentity(), 'old', 'fresh', undefined);

    expect(rename).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('exists again'), 'warning', expect.any(Number));
  });

  it('after a vault swap, Undo renames nothing', async () => {
    const identity = captureVaultIdentity();
    beginVaultGeneration('/other');
    const rename = vi.spyOn(fileTagsStore, 'renameTagEverywhere');

    await undoRename(identity, 'old', 'fresh', undefined);

    expect(rename).not.toHaveBeenCalled();
  });
});

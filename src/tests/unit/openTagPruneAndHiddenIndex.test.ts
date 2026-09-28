import { describe, it, expect, afterEach } from 'vitest';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { tidyTagsAfterOpen } from '@renderer/stores/openTagHousekeeping';
import { captureVaultIdentity } from '@renderer/lib/vault/vaultIdentity';
import { namedByPendingRename, type ReadResult } from '@renderer/lib/vault/renameCascadeSentinel';
import type { FileTreeNode } from '@shared/types';
import { installMemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Attachment tags live only in `.filo/tags.json`, so the open-time prune of
 * entries whose file is gone must wait for an unfinished rename's Retry (it
 * moves them) and spare the paths that rename names. A sync client's
 * `.stversions/` archive stays out of the vault index, as it is out of the
 * sidebar tree.
 */

afterEach(() => {
  restoreFiloDefault();
  fileTagsStore.reset();
  vaultStore.setPath('');
  vaultIndexStore.clear();
});

function file(rel: string): FileTreeNode {
  return { name: rel.split('/').pop() ?? rel, path: `/vault/${rel}`, isDirectory: false };
}

const PENDING: ReadResult = {
  entries: [{ id: 'r1', timestamp: 0, oldPath: 'img/old.png', newPath: 'moved/old.png', affectedBoardIds: [] }],
};

describe('open-time prune of attachment tags', () => {
  it('waits for the recovery prompts, and spares paths an unfinished rename names', async () => {
    fileTagsStore.commitFromCandidate('/vault', {
      version: 1,
      tags: { t: { color: '#3a86ff', createdAt: 0 } },
      fileTags: { 'img/old.png': ['t'], 'gone.png': ['t'], 'kept.png': ['t'] },
    });
    let finishPrompts: () => void = () => {};
    const recovered = new Promise<void>((resolve) => { finishPrompts = resolve; });
    const done = tidyTagsAfterOpen({
      identity: captureVaultIdentity(),
      vaultRoot: '/vault',
      tree: () => [file('kept.png')],
      rebuilt: Promise.resolve(),
      recovered,
      pendingRenames: Promise.resolve(PENDING),
    });
    await new Promise((r) => setTimeout(r, 20));
    // Nothing is pruned while a prompt (the rename Retry) is still open.
    expect(Object.keys(fileTagsStore.file.fileTags).sort()).toEqual(['gone.png', 'img/old.png', 'kept.png']);
    finishPrompts();
    await done;
    expect(Object.keys(fileTagsStore.file.fileTags).sort()).toEqual(['img/old.png', 'kept.png']);
  });

  it('namedByPendingRename matches both sides and what is under them, case-folded', () => {
    const named = namedByPendingRename([
      { id: 'a', timestamp: 0, oldPath: 'Media', newPath: 'Archive/Media', affectedBoardIds: [] },
    ]);
    expect(named('media/pic.png')).toBe(true);
    expect(named('Archive/Media/pic.png')).toBe(true);
    expect(named('Media')).toBe(true);
    expect(named('Mediaeval/pic.png')).toBe(false);
    expect(named('other.png')).toBe(false);
  });
});

describe('vault index and hidden folders', () => {
  it('a note under .stversions is not indexed', async () => {
    installMemoryVault({
      'Note.md': '---\ntags: [real]\n---\nbody\n',
      '.stversions/Note~20260928-101112.md': '---\ntags: [ghost]\n---\nold body\n',
    });
    vaultStore.setPath('/vault');
    await vaultIndexStore.applyChanges(['Note.md', '.stversions/Note~20260928-101112.md']);
    expect(vaultIndexStore.getMetadata('Note.md')).not.toBeNull();
    expect(vaultIndexStore.getMetadata('.stversions/Note~20260928-101112.md')).toBeNull();
    expect([...vaultIndexStore.allTags().keys()]).toEqual(['real']);
  });
});

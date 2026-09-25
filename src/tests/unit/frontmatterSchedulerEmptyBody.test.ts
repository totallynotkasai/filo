/**
 * A frontmatter change must never write an empty or stale body. The note
 * writer applies the change to a fresh read of the file and keeps the body it
 * finds there, whether or not a view still holds the note and however far the
 * vault index lags the disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

describe('frontmatter writes keep the body on disk', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vaultIndexStore.clear();
  });
  afterEach(() => {
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('a view closing mid-debounce leaves the body on disk as it is', async () => {
    vault = installMemoryVault({ 'Notes.md': '---\ntitle: T\n---\nreal body\n' });
    const m = noteStore.acquire('Notes.md', 'view');
    await m.loaded;
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'done' }, unset: [] });

    // The editor goes away before the debounce fires (tab close).
    noteStore.release('Notes.md', 'view');

    expect((await noteStore.flushAll()).failed).toEqual([]);
    expect(vault.read('Notes.md')).toBe('---\ntitle: T\nstatus: done\n---\nreal body\n');
  });

  it('writes the fresh disk body, not the stale index content', async () => {
    vault = installMemoryVault({ 'Notes.md': '---\ntitle: T\n---\nOLD body\n' });
    // The index parses OLD content.
    await vaultIndexStore.applyChanges(['Notes.md']);
    // Another program replaces the body; the index hasn't caught up.
    vault.writeExternally('Notes.md', '---\ntitle: T\n---\nNEW body\n');

    noteStore.patchFrontmatter('Notes.md', { set: { status: 'done' }, unset: [] });
    await noteStore.flushAll();

    const written = vault.read('Notes.md') ?? '';
    expect(written).toBe('---\ntitle: T\nstatus: done\n---\nNEW body\n');
    expect(written).not.toContain('OLD body');
  });

  it('a frontmatter-only change keeps a body without a final newline byte-exact', async () => {
    vault = installMemoryVault({ 'Notes.md': '---\ntitle: T\n---\nreal body' });
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'done' }, unset: [] });
    await noteStore.flushAll();
    expect(vault.read('Notes.md')).toBe('---\ntitle: T\nstatus: done\n---\nreal body');
  });
});

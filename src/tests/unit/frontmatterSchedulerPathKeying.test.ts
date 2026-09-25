/**
 * A queued frontmatter change is keyed by the note's case-folded path: it is
 * found under any spelling of the path and moves with the note on a rename.
 * Left behind, it would target a path that no longer exists (and must never
 * recreate it); a stale index copy is never what lands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

describe('queued frontmatter changes are path-keyed', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    vault = installMemoryVault({ 'Notes.md': '---\ntitle: Notes\ntag: a1\n---\nA body\n' });
  });
  afterEach(() => {
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('is found under any spelling and carried across a rename', async () => {
    vaultIndexStore.restoreMetadata('Notes.md', parseMarkdown('Notes.md', vault.read('Notes.md') ?? ''));
    noteStore.patchFrontmatter('Notes.md', { set: { tag: 'a2' }, unset: [] });
    expect(noteStore.frontmatter('notes.MD').tag).toBe('a2');
    expect(noteStore.hasPendingWrites('NOTES.md')).toBe(true);

    // The file moves before the debounce fires.
    vault.writeExternally('Sub/Notes.md', vault.read('Notes.md') ?? '');
    vault.remove('Notes.md');
    renameAllPathKeys('Notes.md', 'Sub/Notes.md');
    expect(noteStore.hasPendingWrites('Notes.md')).toBe(false);
    expect(noteStore.hasPendingWrites('sub/notes.md')).toBe(true);

    expect((await noteStore.flushAll()).failed).toEqual([]);
    expect(vault.read('Sub/Notes.md')).toBe('---\ntitle: Notes\ntag: a2\n---\nA body\n');
    expect(vault.read('Notes.md')).toBeUndefined();
  });

  it('an open note writes its own frontmatter, not a stale index copy', async () => {
    const m = noteStore.acquire('Notes.md', 'view');
    await m.loaded;
    // A stale copy of the same file in the search index.
    vaultIndexStore.restoreMetadata('Notes.md', parseMarkdown('Notes.md', '---\nstatus: stale\n---\nbody'));

    noteStore.patchFrontmatter('Notes.md', { set: { tag: 'b1' }, unset: [] });
    await noteStore.flushAll();

    const written = vault.read('Notes.md') ?? '';
    expect(written).toBe('---\ntitle: Notes\ntag: b1\n---\nA body\n');
    expect(written).not.toContain('status: stale');
    expect(noteStore.frontmatter('Notes.md')).toEqual({ title: 'Notes', tag: 'b1' });
  });
});

/**
 * Several views of one `.md` file (text tiles on different boards, a Document
 * tab, a Task List row) share one note model, so an edit
 * from any of them is what every other one reads and writes:
 *  - the model is found by path in any spelling (slashes, case);
 *  - frontmatter changes from different writers merge, none is dropped;
 *  - a body saved by a second view never loses the frontmatter a first view
 *    read from disk (the body lands on a fresh read of the file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'Sub/Notes.md': '---\ntitle: X\ntags: [a]\n---\nfirst\n',
  });
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('one note, many views', () => {
  it('a view naming the note with other slashes or case reaches the same model', async () => {
    const first = noteStore.acquire('Sub/Notes.md', 'tile-a');
    await first.loaded;
    expect(noteStore.acquire('sub\\notes.MD', 'tile-b')).toBe(first);
    expect(noteStore.get('SUB/NOTES.md')).toBe(first);
    expect(noteStore.get('Other.md')).toBeUndefined();
    expect(first.relPath).toBe('Sub/Notes.md');
  });

  it('frontmatter changes from two writers both land (a popup tag, then a task toggle)', async () => {
    const m = noteStore.acquire('Sub/Notes.md', 'doc');
    await m.loaded;
    noteStore.patchFrontmatter('Sub/Notes.md', patchToFrontmatterDelta({ tags: ['a', 'b'] }));
    noteStore.patchFrontmatter('Sub/Notes.md', patchToFrontmatterDelta({ completed: true }));
    expect(m.frontmatter).toEqual({ title: 'X', tags: ['a', 'b'], completed: true });
    await noteStore.flushAll();
    expect(noteStore.frontmatter('Sub/Notes.md')).toEqual({ title: 'X', tags: ['a', 'b'], completed: true });
    const disk = vault.read('Sub/Notes.md') ?? '';
    expect(disk).toContain('completed: true');
    expect(disk).toContain('tags:\n  - a\n  - b\n');
    expect(disk.endsWith('first\n')).toBe(true);
  });

  it('a body saved from a second view keeps the frontmatter block byte for byte', async () => {
    const tile = noteStore.acquire('Sub/Notes.md', 'tile');
    await tile.loaded;
    noteStore.acquire('Sub/Notes.md', 'doc');
    // The shared body is body-only: nothing a view reads from it carries a fence.
    expect(tile.body).toBe('first\n');
    noteStore.setBody('Sub/Notes.md', 'second', 'doc');
    expect(tile.body).toBe('second');
    await noteStore.flushAll();
    expect(vault.read('Sub/Notes.md')).toBe('---\ntitle: X\ntags: [a]\n---\nsecond\n');
  });
});

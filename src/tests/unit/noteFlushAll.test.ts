/**
 * `noteStore.flushAll()` is what save (Ctrl+S), quit, tab close and every
 * rename/delete drain call. Its contract:
 *  - every open view's unserialised keystrokes are pulled in first, so text
 *    typed since the editor last serialised is written too;
 *  - it resolves only after every write has settled (a slow write must not
 *    let "Saved" flash before the bytes are on disk);
 *  - a failed write is reported by note path in `failed`, and one failure
 *    doesn't stop the other notes' writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
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
    'a.md': '---\ntitle: A\n---\nA\n',
    'b.md': '---\ntitle: B\n---\nB\n',
    'c.md': '---\ntitle: C\n---\nC\n',
  });
  noteStore.__resetForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
  vi.restoreAllMocks();
});

describe('noteStore.flushAll', () => {
  it('reports nothing failed when nothing is queued', async () => {
    expect(await noteStore.flushAll()).toEqual({ failed: [], rawNotSaved: [] });
    expect(vault.writes).toEqual([]);
  });

  it('writes every queued note', async () => {
    for (const rel of ['a.md', 'b.md', 'c.md']) {
      noteStore.patchFrontmatter(rel, { set: { done: true }, unset: [] });
    }
    expect(await noteStore.flushAll()).toEqual({ failed: [], rawNotSaved: [] });
    for (const rel of ['a.md', 'b.md', 'c.md']) expect(vault.read(rel)).toContain('done: true');
  });

  it('pulls in keystrokes a view has not serialised yet', async () => {
    let typed = 'A typed since the last serialise';
    const m = noteStore.acquire('a.md', 'tile', {
      serialize: () => noteStore.setBody('a.md', typed, 'tile'),
    });
    await m.loaded;
    await noteStore.flushAll();
    expect(vault.read('a.md')).toBe('---\ntitle: A\n---\nA typed since the last serialise\n');

    // A released view is no longer asked.
    noteStore.release('a.md', 'tile');
    typed = 'never written';
    await noteStore.flushAll();
    expect(vault.read('a.md')).not.toContain('never written');
  });

  it('waits for a slow write before resolving', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vault.beforeWrite = async (rel) => {
      if (rel === 'a.md') await gate;
    };
    noteStore.patchFrontmatter('a.md', { set: { slow: true }, unset: [] });

    let resolved = false;
    const done = noteStore.flushAll().then((r) => {
      resolved = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
    expect(vault.read('a.md')).not.toContain('slow');

    release();
    expect(await done).toEqual({ failed: [], rawNotSaved: [] });
    expect(vault.read('a.md')).toContain('slow: true');
  });

  it('names a failed note by path and still writes the others', async () => {
    vault.failNextWrite('b.md', 'EACCES');
    for (const rel of ['a.md', 'b.md', 'c.md']) {
      noteStore.patchFrontmatter(rel, { set: { done: true }, unset: [] });
    }
    const result = await noteStore.flushAll();
    expect(result.failed).toEqual(['b.md']);
    expect(vault.read('a.md')).toContain('done: true');
    expect(vault.read('c.md')).toContain('done: true');
    expect(vault.read('b.md')).not.toContain('done');
    // The failed change is kept, not dropped: the next drain retries it.
    expect(noteStore.hasPendingWrites('b.md')).toBe(true);
  });
});

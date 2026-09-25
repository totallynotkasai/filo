/**
 * A note saved with a UTF-8 BOM keeps it through every write: the writer
 * takes the BOM from the fresh read of the raw bytes, never from text that a
 * parser already stripped it from. A Properties edit (a frontmatter delta on a
 * note no editor has open) and a body edit both re-emit it; a note without a
 * BOM never gains one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const BOM = '﻿';
let vault: MemoryVault;

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'BomNotes.md': `${BOM}---\ntitle: B\n---\nbody\n`,
    'Plain.md': '---\ntitle: P\n---\nbody\n',
  });
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('BOM preservation', () => {
  it('a frontmatter edit to an unopened BOM note keeps the BOM', async () => {
    noteStore.patchFrontmatter('BomNotes.md', { set: { status: 'updated' }, unset: [] });
    await noteStore.flushAll();
    expect(vault.read('BomNotes.md')).toBe(`${BOM}---\ntitle: B\nstatus: updated\n---\nbody\n`);
  });

  it('a body edit to an open BOM note keeps the BOM', async () => {
    const m = noteStore.acquire('BomNotes.md', 'tile');
    await m.loaded;
    expect(m.body).toBe('body\n');
    noteStore.setBody('BomNotes.md', 'new body', 'tile');
    await noteStore.flush('BomNotes.md');
    expect(vault.read('BomNotes.md')).toBe(`${BOM}---\ntitle: B\n---\nnew body\n`);
  });

  it('a note without a BOM never gains one', async () => {
    noteStore.patchFrontmatter('Plain.md', { set: { status: 'updated' }, unset: [] });
    await noteStore.flushAll();
    expect(vault.read('Plain.md')?.charCodeAt(0)).not.toBe(0xfeff);
    expect(vault.read('Plain.md')).toBe('---\ntitle: P\nstatus: updated\n---\nbody\n');
  });
});

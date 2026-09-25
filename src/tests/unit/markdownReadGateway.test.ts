/**
 * Loading a note is one fresh read, and the model's base (the bytes the local
 * state is built on, which the writer's drift check compares against) comes
 * from that same read: its hash, mtime and size, and its BOM. A base taken
 * from anything else would let the drift check pass against a disk it never
 * saw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { noteTextHash } from '@renderer/lib/notes/noteFile';
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
    'Notes/a.md': '---\ntags: [x]\n---\nHello body',
    'Notes/bom.md': `${BOM}---\ntitle: T\n---\nBody`,
  });
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('loading a note', () => {
  it('parses the read and takes the base from the same read', async () => {
    const reads = (): number =>
      vaultReads().filter((rel) => rel === 'Notes/a.md').length;
    const m = noteStore.acquire('Notes/a.md', 'tile');
    await m.loaded;

    expect(m.status).toBe('ready');
    expect(m.body).toBe('Hello body');
    expect(m.frontmatter.tags).toEqual(['x']);
    expect(reads()).toBe(1);

    const raw = vault.read('Notes/a.md') ?? '';
    const stat = await window.filo.invoke('vault:stat', '/vault', 'Notes/a.md');
    expect(m.base).toMatchObject({
      rawText: raw,
      hash: noteTextHash(raw),
      hadBom: false,
      mtimeMs: (stat as { mtimeMs: number }).mtimeMs,
      size: new TextEncoder().encode(raw).length,
    });
  });

  it('records the BOM of a BOM-led file', async () => {
    const m = noteStore.acquire('Notes/bom.md', 'tile');
    await m.loaded;
    expect(m.base?.hadBom).toBe(true);
    expect(m.frontmatter).toEqual({ title: 'T' });
    expect(m.body).toBe('Body');
  });

  it('a failed read leaves no base (the note is missing, not empty on disk)', async () => {
    const m = noteStore.acquire('Notes/missing.md', 'tile');
    await m.loaded;
    expect(m.status).toBe('missing');
    expect(m.base).toBeUndefined();
    // An edit to it is never written as a new file.
    noteStore.setBody('Notes/missing.md', 'typed', 'tile');
    await noteStore.flushAll();
    expect(vault.read('Notes/missing.md')).toBeUndefined();
  });
});

function vaultReads(): string[] {
  return vi.mocked(window.filo.invoke).mock.calls
    .filter((c) => c[0] === 'vault:read-file-text')
    .map((c) => String(c[2]));
}

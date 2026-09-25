/**
 * The note store and writer are keyed by the note's case-folded vault path, so
 * two vaults that each hold a `Notes.md` share a key. A vault swap resets them:
 * nothing queued in the outgoing vault may land on the new vault's same-named
 * file, and nothing remembered about it may suppress or distort the new
 * vault's first write to that path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installMemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const NOTE_A = '---\nvault: A\ntitle: Notes\n---\nvault A body\n';
const NOTE_B = '---\nvault: B\ntitle: Notes\n---\nvault B body\n';

async function swap(): Promise<void> {
  await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault-A', nextVault: '/vault-B', saveOutgoing: false });
  vaultStore.setPath('/vault-B');
}

describe('note store — vault-swap reset', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault-A');
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('after a vault swap, a write to a same-named file in the new vault lands', async () => {
    const vaultA = installMemoryVault({ 'Notes.md': NOTE_A }, '/vault-A');
    const a = noteStore.acquire('Notes.md', 'view');
    await a.loaded;
    noteStore.setBody('Notes.md', 'vault A edit', 'view');
    await noteStore.flushAll();
    expect(vaultA.read('Notes.md')).toBe('---\nvault: A\ntitle: Notes\n---\nvault A edit\n');

    await swap();
    const vaultB = installMemoryVault({ 'Notes.md': NOTE_B }, '/vault-B');

    const b = noteStore.acquire('Notes.md', 'view');
    expect(b).not.toBe(a);
    await b.loaded;
    expect(b.body).toBe('vault B body\n');
    noteStore.setBody('Notes.md', 'vault B edit', 'view');
    expect((await noteStore.flushAll()).failed).toEqual([]);

    expect(vaultB.read('Notes.md')).toBe('---\nvault: B\ntitle: Notes\n---\nvault B edit\n');
  });

  it('a change still queued in the outgoing vault never lands on the new vault\'s file', async () => {
    installMemoryVault({ 'Notes.md': NOTE_A }, '/vault-A');
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'from-A' }, unset: [] });

    await swap();
    const vaultB = installMemoryVault({ 'Notes.md': NOTE_B }, '/vault-B');

    expect(noteStore.hasPendingWrites('Notes.md')).toBe(false);
    expect((await noteStore.flushAll()).failed).toEqual([]);
    expect(vaultB.read('Notes.md')).toBe(NOTE_B);
    expect(vaultB.writes.filter(([, rel]) => rel.endsWith('.md'))).toHaveLength(0);
  });
});

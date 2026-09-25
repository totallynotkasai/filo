/**
 * A note write still in flight when the vault swaps must not reach into the
 * next vault when it settles: a late rejection must not show up as a failure
 * in the new vault's flush, and a late success must not touch the new vault's
 * same-named note or its write tracking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resetWriteTracking,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteStateInfo,
} from '@renderer/lib/boards/writeStateTracking';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const NOTE_A = '---\nvault: A\ntitle: Notes\n---\nvault A body\n';
const NOTE_B = '---\nvault: B\ntitle: Notes\n---\nvault B body\n';

/** Holds vault A's next `.md` write open until `release()`. */
function holdWrites(vault: MemoryVault): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => {
    vault.beforeWrite = async (rel) => {
      if (!rel.endsWith('.md')) return;
      resolve();
      await gate;
    };
  });
  return { entered, release };
}

async function swapToB(): Promise<MemoryVault> {
  await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault-A', nextVault: '/vault-B', saveOutgoing: false });
  resetWriteTracking('/vault-A');
  vaultStore.setPath('/vault-B');
  return installMemoryVault({ 'Notes.md': NOTE_B }, '/vault-B');
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('note writes across a vault swap', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault-A');
  });
  afterEach(() => {
    setWriteStateListener(null);
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('post-swap rejection does not pollute the new vault flush result', async () => {
    const vaultA = installMemoryVault({ 'Notes.md': NOTE_A }, '/vault-A');
    const held = holdWrites(vaultA);
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'a' }, unset: [] });
    await held.entered;

    const vaultB = await swapToB();

    // Vault A's write rejects after the swap.
    vaultA.failNextWrite('Notes.md', 'EIO');
    held.release();
    await settle();

    noteStore.patchFrontmatter('Notes.md', { set: { status: 'b' }, unset: [] });
    const result = await noteStore.flushAll();

    expect(result.failed).toEqual([]);
    expect(vaultB.read('Notes.md')).toBe('---\nvault: B\ntitle: Notes\nstatus: b\n---\nvault B body\n');
    expect(vaultA.read('Notes.md')).toBe(NOTE_A);
  });

  it('post-swap success does not touch the new vault\'s note or its tracking', async () => {
    const vaultA = installMemoryVault({ 'Notes.md': NOTE_A }, '/vault-A');
    const held = holdWrites(vaultA);
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'a' }, unset: [] });
    await held.entered;

    const vaultB = await swapToB();
    const model = noteStore.acquire('Notes.md', 'view-b');
    await model.loaded;
    const states: WriteStateInfo[] = [];
    setWriteStateListener((info) => states.push({ ...info }));

    // Vault A's write lands after the swap.
    held.release();
    await settle();

    // The new vault's note didn't adopt vault A's bytes.
    expect(model.frontmatter).toEqual({ vault: 'B', title: 'Notes' });
    expect(model.base?.rawText).toBe(NOTE_B);

    noteStore.patchFrontmatter('Notes.md', { set: { status: 'b' }, unset: [] });
    const result = await noteStore.flushAll();
    expect(result.failed).toEqual([]);
    expect(vaultB.read('Notes.md')).toBe('---\nvault: B\ntitle: Notes\nstatus: b\n---\nvault B body\n');
    expect((states.at(-1) ?? { failed: 0 }).failed).toBe(0);
  });

  it('same-vault write still settles cleanly (regression guard)', async () => {
    const vaultA = installMemoryVault({ 'Notes.md': NOTE_A }, '/vault-A');
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'a' }, unset: [] });

    const result = await noteStore.flushAll();

    expect(result.failed).toEqual([]);
    expect(vaultA.read('Notes.md')).toBe('---\nvault: A\ntitle: Notes\nstatus: a\n---\nvault A body\n');
  });
});

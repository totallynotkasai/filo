/**
 * A rename (in-app, or the rename-cascade recovery retry) moves every open
 * note under the old path: an exact file rename and every note under a renamed
 * folder follow, case-insensitively, taking the new path as given; unrelated
 * notes stay put.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore, type NoteModel } from '@renderer/stores/notes.svelte';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;

async function open(rel: string): Promise<NoteModel> {
  const m = noteStore.acquire(rel, `view:${rel}`);
  await m.loaded;
  return m;
}

/** Moves the file on disk, as the rename IPC would, before the sweep runs. */
function moveOnDisk(from: string, to: string): void {
  vault.writeExternally(to, vault.read(from) ?? '');
  vault.remove(from);
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'Notes/old.md': 'old\n',
    'Notes/2026/foo.md': 'foo\n',
    'Other/bar.md': 'bar\n',
    'Notes/Old.md': 'old\n',
  });
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('rename moves open notes', () => {
  it('repoints an exact-match file rename', async () => {
    const m = await open('Notes/old.md');
    moveOnDisk('Notes/old.md', 'Notes/new.md');
    renameAllPathKeys('Notes/old.md', 'Notes/new.md');
    expect(noteStore.get('Notes/new.md')).toBe(m);
    expect(noteStore.get('Notes/old.md')).toBeUndefined();
    expect(m.relPath).toBe('Notes/new.md');
  });

  it('repoints descendants under a renamed folder (prefix walk)', async () => {
    const m = await open('Notes/2026/foo.md');
    moveOnDisk('Notes/2026/foo.md', 'Archive/2026/foo.md');
    renameAllPathKeys('Notes', 'Archive');
    expect(noteStore.get('Archive/2026/foo.md')).toBe(m);
    expect(noteStore.get('Notes/2026/foo.md')).toBeUndefined();
    expect(m.relPath).toBe('Archive/2026/foo.md');
  });

  it('leaves unrelated notes untouched', async () => {
    const m = await open('Other/bar.md');
    renameAllPathKeys('Notes', 'Archive');
    expect(noteStore.get('Other/bar.md')).toBe(m);
    expect(m.relPath).toBe('Other/bar.md');
  });

  it('matches case-insensitively and applies the new path as given', async () => {
    const m = await open('Notes/Old.md');
    moveOnDisk('Notes/Old.md', 'notes/renamed.md');
    renameAllPathKeys('notes/old.md', 'notes/renamed.md');
    expect(noteStore.get('notes/renamed.md')).toBe(m);
    expect(m.relPath).toBe('notes/renamed.md');
  });

  it('a later edit lands on the renamed file, not the old path', async () => {
    const m = await open('Notes/2026/foo.md');
    moveOnDisk('Notes/2026/foo.md', 'Archive/2026/foo.md');
    renameAllPathKeys('Notes', 'Archive');
    noteStore.setBody(m.relPath, 'edited', 'view:Notes/2026/foo.md');
    await noteStore.flushAll();
    expect(vault.read('Archive/2026/foo.md')).toBe('edited\n');
    expect(vault.read('Notes/2026/foo.md')).toBeUndefined();
  });
});

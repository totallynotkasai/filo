/**
 * UpdatePropertiesCommand regression guard.
 *
 * The Document tab's tag row pushes one command per tag change, so Ctrl+Z
 * restores the note's frontmatter on disk.
 *
 * These tests assert:
 *   - execute() applies the "after" snapshot to the note's frontmatter on disk.
 *   - undo() restores the "before" snapshot, rebased on the note as it stands:
 *     a key another program added meanwhile survives.
 *   - redo() re-applies "after" again.
 *   - a leg against a note that can't be read refuses instead of writing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { UpdatePropertiesCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

describe('UpdatePropertiesCommand — frontmatter', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({
      'Notes.md': '---\ntags:\n  - old\n---\nhello body\n',
      'A.md': '---\npriority: low\n---\nbody\n',
      'X.md': '---\ntags:\n  - b\n---\nbody\n',
    });
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute writes the after snapshot to the note, keeping its body', async () => {
    const m = noteStore.acquire('Notes.md', 'popup');
    await m.loaded;

    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'Notes.md', fm: { tags: ['old'] } },
      { kind: 'frontmatter', relPath: 'Notes.md', fm: { tags: ['new'], priority: 'high' } },
    );

    await cmd.execute();
    expect(m.frontmatter).toMatchObject({ tags: ['new'], priority: 'high' });
    await noteStore.flushAll();
    const written = vault.read('Notes.md') ?? '';
    expect(written).toContain('priority: high');
    expect(written).toContain('- new');
    expect(written).toContain('hello body');
  });

  it('undo restores the prior frontmatter on disk; redo re-applies', async () => {
    const m = noteStore.acquire('A.md', 'popup');
    await m.loaded;

    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'A.md', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'A.md', fm: { priority: 'high' } },
    );

    await cmd.execute();
    expect(m.frontmatter).toMatchObject({ priority: 'high' });
    await noteStore.flushAll();
    expect(vault.read('A.md')).toBe('---\npriority: high\n---\nbody\n');

    await cmd.undo();
    expect(m.frontmatter).toMatchObject({ priority: 'low' });
    await noteStore.flushAll();
    expect(vault.read('A.md')).toBe('---\npriority: low\n---\nbody\n');

    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('A.md')).toBe('---\npriority: high\n---\nbody\n');
  });

  it('snapshots deep-cloned so later mutations do not poison the command', async () => {
    // Disk holds the post-execute "after" state (tags: [b]); undo reverts it
    // to the "before" snapshot.
    const sharedFm = { tags: ['a'] };
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'X.md', fm: sharedFm },
      { kind: 'frontmatter', relPath: 'X.md', fm: { tags: ['b'] } },
    );

    // Mutate the caller-side object after construction.
    (sharedFm.tags as string[]).push('poison');

    await cmd.undo();
    await noteStore.flushAll();
    const written = vault.read('X.md') ?? '';
    expect(written).toContain('- a');
    expect(written).not.toContain('poison');
  });

  it('refuses without writing when the note is gone (never recreates it)', async () => {
    vault.remove('A.md');
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'A.md', fm: { priority: 'high' } },
      { kind: 'frontmatter', relPath: 'A.md', fm: { priority: 'low' } },
    );
    await expect(cmd.undo()).rejects.toThrow();
    await noteStore.flushAll();
    expect(vault.read('A.md')).toBeUndefined();
    expect(vault.writes.filter(([, rel]) => rel === 'A.md')).toEqual([]);
  });

  it('writes nothing when no vault is open (defensive)', async () => {
    vaultStore.setPath('');
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'X.md', fm: {} },
      { kind: 'frontmatter', relPath: 'X.md', fm: { priority: 'high' } },
    );
    await cmd.execute().catch(() => undefined);
    await noteStore.flushAll();
    expect(vault.writes.filter(([, rel]) => rel.endsWith('.md'))).toEqual([]);
  });
});

describe('UpdatePropertiesCommand — undo preserves externally-added keys', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'H2.md': '---\npriority: low\n---\nh2 body\n' });
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('undo keeps a key added externally between edit and Ctrl+Z (open note)', async () => {
    const m = noteStore.acquire('H2.md', 'popup');
    await m.loaded;

    // User changes ONE property (priority low → high) via the popup.
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'H2.md', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'H2.md', fm: { priority: 'high' } },
    );
    await cmd.execute();
    await noteStore.flushAll();

    // Another tool adds `reviewed: true`; the watcher hands it to the note.
    vault.writeExternally('H2.md', '---\npriority: high\nreviewed: true\n---\nh2 body\n');
    await noteStore.onDiskChanged('H2.md');

    await cmd.undo();
    // Only the OWNED key (priority) reverts; `reviewed` stays.
    expect(m.frontmatter).toMatchObject({ priority: 'low', reviewed: true });
    await noteStore.flushAll();
    expect(vault.read('H2.md')).toBe('---\npriority: low\nreviewed: true\n---\nh2 body\n');
  });

  it('undo keeps a key added externally ON DISK when no view has the note open', async () => {
    vault.writeExternally('H2.md', '---\npriority: high\nreviewed: true\n---\nDisk body\n');

    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'H2.md', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'H2.md', fm: { priority: 'high' } },
    );

    // Undo reverts priority high → low while preserving the on-disk reviewed key.
    await cmd.undo();
    await noteStore.flushAll();
    expect(vault.read('H2.md')).toBe('---\npriority: low\nreviewed: true\n---\nDisk body\n');
  });
});

describe('UpdatePropertiesCommand — description', () => {
  it('uses a stable human-readable label', () => {
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'X.md', fm: {} },
      { kind: 'frontmatter', relPath: 'X.md', fm: { a: 1 } },
    );
    expect(cmd.description).toBe('Update properties');
  });
});

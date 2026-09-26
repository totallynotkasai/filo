import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { assembleMarkdownFile } from '@renderer/lib/editor/markdownSync';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A note's vault path is its only identity: every per-note map is keyed by
 * the case-folded path, and a rename moves each entry to the new key. These
 * pin the rename half, which a stable opaque id used to make unnecessary:
 * the note model (with its unsaved body), the writer's queue for it, the
 * frontmatter overlay of an unopened note, and a Document tab all follow.
 */

let vault: MemoryVault;

/** Moves a file on "disk" the way the in-app rename does, then runs the sweep. */
function renameOnDisk(oldRel: string, newRel: string): void {
  for (const [key, text] of [...vault.files]) {
    const rel = key === oldRel.toLowerCase() ? newRel
      : key.startsWith(`${oldRel.toLowerCase()}/`) ? newRel + key.slice(oldRel.length)
        : null;
    if (rel === null) continue;
    vault.remove(key);
    vault.writeExternally(rel, text);
  }
  renameAllPathKeys(oldRel, newRel);
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'Notes/Shopping.md': '---\ntitle: Shopping\n---\nmilk\n',
    'Notes/Old.md': '---\ntitle: T\n---\nbody\n',
    'Notes/2026/Daily Log.md': '---\ntitle: Daily\n---\nlog\n',
    'Other/Keep.md': '---\ntitle: Keep\n---\nkeep\n',
    'Notes/foo.md': '---\ntitle: foo\n---\nkept\n',
  });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  tabStore.closeAll();
});
afterEach(() => {
  noteStore.__resetForTests();
  tabStore.closeAll();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('one note per path', () => {
  it('any spelling of the path names the same note', async () => {
    const m = noteStore.acquire('Notes/Shopping.md', 'tile');
    expect(noteStore.acquire('notes/shopping.md', 'doc')).toBe(m);
    await m.loaded;
    expect(noteStore.get('NOTES\\Shopping.md')).toBe(m);
    expect(noteStore.get('notes/SHOPPING.md')?.relPath).toBe('Notes/Shopping.md');
    expect(m.body).toBe('milk\n');
  });

  it('a queued frontmatter change is shared by the path', () => {
    noteStore.patchFrontmatter('Notes/A.md', { set: { title: 'A' }, unset: [] });
    expect(noteStore.frontmatter('NOTES/A.MD')).toEqual({ title: 'A' });
    expect(noteStore.hasPendingWrites('notes/a.md')).toBe(true);
  });
});

describe('a rename re-keys the note store', () => {
  it('moves the model with its unsaved body, and the next write lands on the new file', async () => {
    const m = noteStore.acquire('Notes/Old.md', 'tile');
    await m.loaded;
    noteStore.setBody('Notes/Old.md', 'body 2', 'tile');

    renameOnDisk('Notes/Old.md', 'Notes/New.md');

    expect(noteStore.get('Notes/Old.md')).toBeUndefined();
    const moved = noteStore.get('Notes/New.md');
    expect(moved).toBe(m);
    expect(moved?.relPath).toBe('Notes/New.md');
    expect(moved?.body).toBe('body 2');
    expect(moved?.frontmatter).toEqual({ title: 'T' });
    expect(moved?.hasUnsavedBody).toBe(true);
    expect(noteStore.hasPendingWrites('Notes/Old.md')).toBe(false);
    expect(noteStore.hasPendingWrites('Notes/New.md')).toBe(true);

    await noteStore.flushAll();
    expect(vault.read('Notes/New.md')).toBe('---\ntitle: T\n---\nbody 2\n');
    expect(vault.read('Notes/Old.md')).toBeUndefined();
  });

  it('moves every note under a renamed folder, keeping each tail as spelled', async () => {
    const daily = noteStore.acquire('Notes/2026/Daily Log.md', 'tile');
    const keep = noteStore.acquire('Other/Keep.md', 'tile');
    await Promise.all([daily.loaded, keep.loaded]);
    renameOnDisk('Notes', 'Archive');
    expect(noteStore.get('Archive/2026/Daily Log.md')?.relPath).toBe('Archive/2026/Daily Log.md');
    expect(noteStore.get('Notes/2026/Daily Log.md')).toBeUndefined();
    expect(noteStore.get('Other/Keep.md')?.relPath).toBe('Other/Keep.md');
  });

  it('a case-only rename keeps the model and takes the new spelling', async () => {
    const m = noteStore.acquire('Notes/foo.md', 'tile');
    await m.loaded;
    renameOnDisk('Notes/foo.md', 'Notes/Foo.md');
    expect(noteStore.get('notes/foo.md')).toBe(m);
    expect(m.relPath).toBe('Notes/Foo.md');
    expect(m.body).toBe('kept\n');
  });

  it('a queued change of an unopened note follows it, overlay and all', async () => {
    noteStore.patchFrontmatter('Notes/Old.md', { set: { status: 'done' }, unset: [] });
    renameOnDisk('Notes/Old.md', 'Notes/New.md');
    expect(noteStore.frontmatter('Notes/New.md').status).toBe('done');
    expect(noteStore.hasPendingWrites('Notes/Old.md')).toBe(false);
    expect(await noteStore.flushAll()).toEqual({ failed: [], rawNotSaved: [] });
    expect(vault.read('Notes/New.md')).toBe('---\ntitle: T\nstatus: done\n---\nbody\n');
  });

  it('a new note at the freed path starts clean', async () => {
    const m = noteStore.acquire('Notes/Old.md', 'tile');
    await m.loaded;
    noteStore.setBody('Notes/Old.md', 'moved body', 'tile');
    renameOnDisk('Notes/Old.md', 'Notes/New.md');

    expect(await noteStore.createExclusive('Notes/Old.md', '---\ntitle: Fresh\n---\n')).toBe('created');
    const fresh = noteStore.acquire('Notes/Old.md', 'other');
    await fresh.loaded;
    expect(fresh).not.toBe(m);
    expect(fresh.frontmatter).toEqual({ title: 'Fresh' });
    await noteStore.flushAll();
    // The moved note's body went to the moved file only.
    expect(vault.read('Notes/Old.md')).toBe('---\ntitle: Fresh\n---\n');
    expect(vault.read('Notes/New.md')).toContain('moved body');
  });
});

describe('views follow the rename', () => {
  it('an editor whose note moved is still drained on save', async () => {
    let typed = 'typed before the rename';
    const m = noteStore.acquire('Notes/Old.md', 'tile', {
      serialize: () => noteStore.setBody(m.relPath, typed, 'tile'),
    });
    await m.loaded;
    renameOnDisk('Notes', 'Archive');
    typed = 'typed after the rename';
    await noteStore.flush('archive/old.md');
    expect(vault.read('Archive/Old.md')).toBe('---\ntitle: T\n---\ntyped after the rename\n');
  });

  it('a Document tab follows its note, and reopening the new path focuses it', () => {
    const tab = tabStore.openNote('Notes/A.md', 'A');
    const other = tabStore.openNote('Notes/B.md', 'B');
    renameAllPathKeys('Notes/A.md', 'Notes/Renamed.md');
    const moved = tabStore.tabs.find((t) => t.id === tab.id);
    expect(moved?.notePath).toBe('Notes/Renamed.md');
    // The board id is opaque, so the tab's undo stack is untouched by the rename.
    expect(moved?.boardId).toBe(tab.boardId);
    expect(tabStore.openNote('notes/renamed.md', 'A').id).toBe(tab.id);
    expect(tabStore.tabs.find((t) => t.id === other.id)?.notePath).toBe('Notes/B.md');
    expect(tabStore.tabs).toHaveLength(2);
  });
});

describe('frontmatter id (D6)', () => {
  it('assembling a note never adds an id key', () => {
    const text = assembleMarkdownFile({ title: 'Shopping' }, 'milk\n');
    expect(text).not.toMatch(/^id:/m);
  });

  it('an id the file already has is left untouched on a metadata edit', () => {
    const original = 'id: abc123\ntitle: Old\n';
    const text = assembleMarkdownFile({ id: 'abc123', title: 'New' }, 'body\n', {
      frontmatterDirty: true,
      originalFrontmatter: original,
    });
    expect(text).toContain('id: abc123\n');
    expect(text).toContain('title: New\n');
  });
});

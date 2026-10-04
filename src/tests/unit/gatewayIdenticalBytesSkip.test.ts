/**
 * The note writer skips a write whose assembled bytes equal what a fresh read
 * of the file holds (no phantom writes, no mtime churn for sync clients). The
 * skip compares against the disk, never a remembered copy, so it can't
 * swallow a "Keep mine" overwrite of another program's change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, setNotePromptHandlers, type NoteModel } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const REL = 'Note.md';
const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), writeTargetMissing: vi.fn(), reloadShrank: vi.fn(), reloadedOverTyping: vi.fn(), confirmReloadWithoutCopy: vi.fn(async () => false), dismiss: vi.fn() };

describe('note writer — identical bytes are not rewritten', () => {
  let vault: MemoryVault;
  let m: NoteModel;

  const mdWrites = (): string[] => vault.writes.filter(([, rel]) => rel.endsWith('.md')).map(([, , text]) => text);

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    for (const fn of Object.values(prompts)) fn.mockReset();
    setNotePromptHandlers(prompts);
    vault = installMemoryVault({ [REL]: '---\na: 1\n---\nHello\n' });
    m = noteStore.acquire(REL, 'view');
    await m.loaded;
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('an edit back to what is on disk writes nothing and leaves the note clean', async () => {
    noteStore.setBody(REL, 'Hello!', 'view');
    noteStore.setBody(REL, 'Hello', 'view');
    expect(await noteStore.flush(REL)).toBe(true);
    expect(mdWrites()).toEqual([]);
    expect(m.hasUnsavedBody).toBe(false);
    expect(noteStore.hasPendingWrites(REL)).toBe(false);
  });

  it('a changed body still writes', async () => {
    noteStore.setBody(REL, 'Hello world', 'view');
    await noteStore.flush(REL);
    expect(mdWrites()).toEqual(['---\na: 1\n---\nHello world\n']);
  });

  it('after a write, re-sending the same body writes nothing more', async () => {
    noteStore.setBody(REL, 'Changed', 'view');
    await noteStore.flush(REL);
    expect(mdWrites()).toHaveLength(1);
    noteStore.patchFrontmatter(REL, { set: { a: 1 }, unset: [] });
    await noteStore.flush(REL);
    expect(mdWrites()).toHaveLength(1);
  });

  it('Keep mine writes a body equal to the old disk bytes over another program\'s change', async () => {
    vault.writeExternally(REL, '---\na: 1\n---\nExternal\n');
    // The user types and undoes: the unsaved body equals what the note was built on.
    noteStore.setBody(REL, 'Hello!', 'view');
    noteStore.setBody(REL, 'Hello', 'view');
    expect(await noteStore.flush(REL)).toBe(false);
    expect(m.status).toBe('conflict');

    await noteStore.resolveConflict(REL, 'keep-mine');

    expect(vault.read(REL)).toBe('---\na: 1\n---\nHello\n');
  });
});

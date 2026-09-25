/**
 * A successful note write clears the note's unsaved state, but only for the
 * edit it carried. A note left marked unsaved after its write landed would
 * turn a later external edit into a spurious conflict and keep other views
 * from following the disk; a note marked saved while a newer edit is still
 * queued would let that edit be lost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore, type NoteModel } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

describe('note writes clear the unsaved state they carried', () => {
  let vault: MemoryVault;
  let m: NoteModel;

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'Note.md': '---\ntitle: Note\n---\nBase\n' });
    m = noteStore.acquire('Note.md', 'tile');
    noteStore.acquire('Note.md', 'doc');
    await m.loaded;
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('a keystroke-then-flush leaves the note saved', async () => {
    noteStore.setBody('Note.md', 'Typed', 'tile');
    expect(m.hasUnsavedBody).toBe(true);
    await noteStore.flush('Note.md');
    expect(m.hasUnsavedBody).toBe(false);
    expect(noteStore.hasPendingWrites('Note.md')).toBe(false);
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nTyped\n');
  });

  it('an edit made while the write is in flight keeps the note unsaved until it lands too', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    vault.beforeWrite = async (rel) => {
      if (!rel.endsWith('.md')) return;
      vault.beforeWrite = null;
      entered();
      await gate;
    };

    noteStore.setBody('Note.md', 'First', 'tile');
    const first = noteStore.flush('Note.md');
    await inFlight;
    noteStore.setBody('Note.md', 'Second', 'doc');
    release();
    await first;

    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nFirst\n');
    expect(m.hasUnsavedBody).toBe(true);

    await noteStore.flush('Note.md');
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nSecond\n');
    expect(m.hasUnsavedBody).toBe(false);
  });
});

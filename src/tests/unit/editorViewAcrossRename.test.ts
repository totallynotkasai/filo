/**
 * Keystrokes an editor holds when its note is renamed (a placeholder rename
 * after the title, a sidebar rename, another program's move) are saved once
 * typing pauses, with no further key. The rename sweep moves the note's
 * model to the new path before the view is pointed there, so the view
 * serialises into the moved model, not the old path's (where there is none).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { NoteEditorView } from '@renderer/lib/editor/noteEditorView';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/** An editor stand-in whose Markdown is whatever `text` holds. */
function fakeEditor(read: () => string): Editor {
  return {
    isDestroyed: false,
    state: { doc: { content: { size: 10 } } },
    storage: { markdown: { getMarkdown: read } },
  } as unknown as Editor;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('an editor view across a rename of its note', () => {
  let vault: MemoryVault;
  const prompts = {
    conflict: vi.fn(),
    deletedWithUnsavedBody: vi.fn(),
    writeTargetMissing: vi.fn(),
    reloadShrank: vi.fn(),
    reloadedOverTyping: vi.fn(),
    confirmReloadWithoutCopy: vi.fn(async () => false),
    dismiss: vi.fn(),
  };

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'New Card.md': '---\ntitle: Alice\n---\n', 'Other.md': 'Other text.\n' });
    setNotePromptHandlers(prompts);
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
  });

  it('keystrokes typed just before the rename are saved after it, with no further typing', async () => {
    let text = '';
    const view = new NoteEditorView('editor', () => fakeEditor(() => text));
    view.show('New Card.md');
    await noteStore.get('New Card.md')?.loaded;

    // The user types; the idle serialise is armed.
    text = 'Once upon a time';
    view.edited();

    // The rename lands (the file moved on disk, then the sweep re-keys every map),
    // and the component then points the view at the new path.
    const bytes = vault.read('New Card.md')!;
    vault.remove('New Card.md');
    vault.writeExternally('Alice.md', bytes);
    renameAllPathKeys('New Card.md', 'Alice.md');
    view.show('Alice.md');

    // No more typing, no blur, no save: wait past the idle serialise and the write.
    await wait(700);
    expect(view.hasUnserialised).toBe(false);
    expect(noteStore.get('Alice.md')?.body).toBe('Once upon a time');
    expect(vault.read('Alice.md')).toBe('---\ntitle: Alice\n---\nOnce upon a time\n');
    view.close();
  });

  it('switching the view to another note still hands the keystrokes to the note they were typed in', async () => {
    let text = '';
    const view = new NoteEditorView('editor', () => fakeEditor(() => text));
    view.show('New Card.md');
    await noteStore.get('New Card.md')?.loaded;
    text = 'Typed into the card';
    view.edited();

    view.show('Other.md');
    expect(view.hasUnserialised).toBe(false);
    await wait(700);
    expect(vault.read('New Card.md')).toBe('---\ntitle: Alice\n---\nTyped into the card\n');
    expect(vault.read('Other.md')).toBe('Other text.\n');
    view.close();
  });
});

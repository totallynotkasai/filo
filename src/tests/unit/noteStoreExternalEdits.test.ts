/**
 * noteStore + NoteEditorView — edits made elsewhere while a view holds
 * keystrokes, and rewrites that land under an unsaved body.
 *
 * Keys typed into a body the model has since replaced (the disk changed, a
 * reload, a rewrite) must never be written over that change: the store holds
 * them in conflict (the one prompt). A rewrite (Replace All, the raw view)
 * never moves the note's base on under an edit it didn't include, and never
 * runs while an edit of the note can't be saved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Editor } from '@tiptap/core';

vi.mock('../../renderer/lib/editor/markdownSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../renderer/lib/editor/markdownSync')>();
  return {
    ...actual,
    editorMarkdown: (editor: { text: string }) => editor.text,
    loadMarkdownIntoEditor: (editor: { text: string }, markdown: string) => {
      // Like the editor, the body is shown without its final newline.
      editor.text = markdown.replace(/\n+$/, '');
      return { lossy: false };
    },
  };
});

import { noteStore, setNotePromptHandlers } from '../../renderer/stores/notes.svelte';
import { NoteEditorView } from '../../renderer/lib/editor/noteEditorView';
import { NoteBusyError } from '../../renderer/lib/notes/noteWriter';
import { vaultIndexStore } from '../../renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '../../renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '../../renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), writeTargetMissing: vi.fn(), reloadShrank: vi.fn(), reloadedOverTyping: vi.fn(), confirmReloadWithoutCopy: vi.fn(async () => false), dismiss: vi.fn() };

interface FakeEditor {
  text: string;
  isDestroyed: boolean;
}

/** A view on a fake editor whose text is its Markdown. */
async function openView(rel: string, id = 'doc'): Promise<{ view: NoteEditorView; editor: FakeEditor }> {
  const editor: FakeEditor = { text: '', isDestroyed: false };
  const view = new NoteEditorView(id, () => editor as unknown as Editor);
  view.show(rel);
  await noteStore.get(rel)?.loaded;
  view.sync({ composing: false });
  return { view, editor };
}

/** Keys typed into the editor that haven't been serialised yet. */
function type(view: NoteEditorView, editor: FakeEditor, text: string): void {
  editor.text += text;
  view.edited();
}

const mdWrites = (): string[] => vault.writes.filter(([, rel]) => rel.endsWith('.md')).map(([, , t]) => t);

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ 'Note.md': '---\ntitle: Note\n---\nStart\n' });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  for (const fn of Object.values(prompts)) fn.mockReset();
  setNotePromptHandlers(prompts);
});

afterEach(() => {
  noteStore.__resetForTests();
  restoreFiloDefault();
});

describe('keys typed into a body that was replaced meanwhile', () => {
  it('a view whose keys were typed before the model took a new body holds them in conflict, and writes nothing', async () => {
    const { view, editor } = await openView('Note.md');
    type(view, editor, ' mine');
    // The model takes the disk version without asking the view first.
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nStart theirs\n');
    await noteStore.reload('Note.md');
    view.sync({ composing: false });
    expect(editor.text).toBe('Start mine');

    view.serialize();
    const m = noteStore.get('Note.md')!;
    expect(m.status).toBe('conflict');
    expect(prompts.conflict).toHaveBeenCalledTimes(1);
    expect(m.body).toBe('Start mine');
    expect(await noteStore.flush('Note.md')).toBe(false);
    expect(mdWrites()).toEqual([]);
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nStart theirs\n');

    await noteStore.resolveConflict('Note.md', 'keep-mine');
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nStart mine\n');
    view.close();
  });

  it('keys typed while the store reads the other program\'s version count as unsaved', async () => {
    const { view, editor } = await openView('Note.md');
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nStart theirs\n');
    vault.afterRead = () => {
      vault.afterRead = null;
      type(view, editor, ' mine');
    };
    await noteStore.onDiskChanged('Note.md');

    expect(noteStore.get('Note.md')!.status).toBe('conflict');
    expect(await noteStore.flush('Note.md')).toBe(false);
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nStart theirs\n');
    view.close();
  });

  it('no conflict when the replaced body is the one the keys were typed on, or already holds them', async () => {
    const { view, editor } = await openView('Note.md');
    type(view, editor, ' mine');
    // A change on disk that put back the very body the editor showed.
    vault.writeExternally('Note.md', '---\ntitle: Note\nstatus: open\n---\nStart\n');
    await noteStore.reload('Note.md');
    view.serialize();
    expect(noteStore.get('Note.md')!.status).toBe('ready');
    expect(await noteStore.flush('Note.md')).toBe(true);
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\nstatus: open\n---\nStart mine\n');
    view.close();
  });

  it('keys typed on a body the view itself wrote are an ordinary edit', async () => {
    const { view, editor } = await openView('Note.md');
    type(view, editor, ' one');
    view.serialize();
    expect(await noteStore.flush('Note.md')).toBe(true);
    type(view, editor, ' two');
    view.serialize();
    expect(noteStore.get('Note.md')!.status).toBe('ready');
    expect(await noteStore.flush('Note.md')).toBe(true);
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nStart one two\n');
    view.close();
  });
});

describe('a rewrite and an unsaved body', () => {
  it('a rewrite refuses while the note holds an edit that can\'t be saved', async () => {
    const m = noteStore.acquire('Note.md', 'doc');
    await m.loaded;
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nStart theirs\n');
    noteStore.setBody('Note.md', 'Start mine', 'doc');
    expect(await noteStore.flush('Note.md')).toBe(false);
    expect(m.status).toBe('conflict');

    await expect(noteStore.transform('Note.md', (fresh) => fresh.raw.replace('theirs', 'REPLACED'))).rejects.toBeInstanceOf(NoteBusyError);
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nStart theirs\n');
    // The raw view's save waits the same way.
    const raw = await noteStore.readRaw('Note.md');
    expect(await noteStore.writeRaw('Note.md', '---\ntitle: Note\n---\nRaw\n', raw?.hash ?? '')).toEqual({ status: 'conflict' });
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nStart theirs\n');
    noteStore.release('Note.md', 'doc');
  });

  it('keys serialised while a rewrite is being written are held in conflict with it, not written over it', async () => {
    const m = noteStore.acquire('Note.md', 'doc');
    await m.loaded;
    vault.beforeWrite = (rel) => {
      if (rel !== 'Note.md') return;
      vault.beforeWrite = null;
      noteStore.setBody('Note.md', 'Start typed', 'doc');
    };
    await noteStore.transform('Note.md', (fresh) => fresh.raw.replace('Start', 'Begin'));
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nBegin\n');
    expect(m.status).toBe('conflict');
    expect(await noteStore.flush('Note.md')).toBe(false);
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nBegin\n');
    noteStore.release('Note.md', 'doc');
  });
});

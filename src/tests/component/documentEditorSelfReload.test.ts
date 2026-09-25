import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { undoDepth } from '@tiptap/pm/history';
import { noteStore } from '@renderer/stores/notes.svelte';
import { editorMarkdown } from '@renderer/lib/editor/markdownSync';
import {
  recordingFilo,
  mountDocumentEditor,
  settle,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * The view that typed owns the note's body: its own autosave must never load
 * back into it (that would wipe redo, break an IME composition and reset the
 * undo stack on every save). A body typed in another view does load, but not
 * in the middle of a composition.
 */
describe('DocumentEditor does not reload its own autosave', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('keeps undo history and redo across a successful autosave', async () => {
    const fs = recordingFilo({ 'Doc.md': '---\na: 1\n---\nHello\n' });
    const m = await mountDocumentEditor({ docPath: 'Doc.md' });
    const ed = m.editor();
    ed.commands.focus('end');
    ed.commands.insertContent('X');
    await drainDebounce();
    expect(fs.writesTo('Doc.md').length).toBe(1);
    // A self-reload would have reset history; the typed step survives.
    expect(undoDepth(ed.state)).toBeGreaterThan(0);

    ed.commands.undo();
    await drainDebounce();
    expect(editorMarkdown(ed)).not.toContain('HelloX');
    expect(ed.can().redo()).toBe(true);
    ed.commands.redo();
    expect(editorMarkdown(ed)).toContain('HelloX');
    await m.unmount();
  });

  it('defers a sibling view\'s body until the IME composition ends', async () => {
    recordingFilo({ 'Doc.md': '---\na: 1\n---\nHello\n' });
    const m = await mountDocumentEditor({ docPath: 'Doc.md' });
    m.proseMirror().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await settle();
    noteStore.acquire('Doc.md', 'text-tile:other');
    noteStore.setBody('Doc.md', 'Sibling\n', 'text-tile:other');
    await settle();
    expect(m.proseMirror().textContent).toContain('Hello');
    expect(m.proseMirror().textContent).not.toContain('Sibling');
    m.proseMirror().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await settle();
    expect(m.proseMirror().textContent).toContain('Sibling');
    noteStore.release('Doc.md', 'text-tile:other');
    await m.unmount();
  });
});

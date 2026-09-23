import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { undoDepth } from '@tiptap/pm/history';
import { documentStore } from '@renderer/stores/document.svelte';
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
 * Audit-19 MD-4 — DocumentEditor never recorded its own typed body as
 * `lastLoadedBody`, so once the gateway markCleaned the writer after an
 * autosave, the reload `$effect` saw `docState.body !== lastLoadedBody` and
 * reloaded the editor's OWN content: redo was wiped, an IME composition broke,
 * and (with MD-1's history reset) the undo stack was lost on every save.
 */
describe('DocumentEditor does not reload its own autosave (MD-4)', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('keeps undo history and redo across a successful autosave', async () => {
    const fs = recordingFilo({ 'Doc.md': '---\na: 1\n---\nHello\n' });
    const m = await mountDocumentEditor({ docId: 'd1', docPath: 'Doc.md' });
    const ed = m.editor();
    ed.commands.focus('end');
    ed.commands.insertContent('X');
    await drainDebounce();
    expect(fs.writesTo('Doc.md').length).toBe(1);
    // A self-reload would have reset history (MD-1) — the typed step survives.
    expect(undoDepth(ed.state)).toBeGreaterThan(0);

    ed.commands.undo();
    await drainDebounce();
    expect(editorMarkdown(ed)).not.toContain('HelloX');
    expect(ed.can().redo()).toBe(true);
    ed.commands.redo();
    expect(editorMarkdown(ed)).toContain('HelloX');
    await m.unmount();
  });

  it('defers a sibling reload until the IME composition ends', async () => {
    recordingFilo({ 'Doc.md': '---\na: 1\n---\nHello\n' });
    const m = await mountDocumentEditor({ docId: 'd1', docPath: 'Doc.md' });
    m.proseMirror().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await settle();
    documentStore.updateContent('d1', '<p>Sibling</p>', 'Sibling\n', 'text-tile:other');
    await settle();
    expect(m.proseMirror().textContent).toContain('Hello');
    expect(m.proseMirror().textContent).not.toContain('Sibling');
    m.proseMirror().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await settle();
    expect(m.proseMirror().textContent).toContain('Sibling');
    await m.unmount();
  });
});

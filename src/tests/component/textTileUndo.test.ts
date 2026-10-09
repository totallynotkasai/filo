import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { editorMarkdown } from '@renderer/lib/editor/markdownSync';
import {
  drainUntilSettled,
  recordingFilo,
  mountTextTile,
  mountDocumentEditor,
  pressUndo,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * Audit-19 MD-1 — loading a file was recorded in ProseMirror's undo history, so
 * Ctrl+Z right after opening a note emptied it and autosave wrote `"\n"` over
 * the file. Driven through the real keymap on real mounted components.
 */
describe('Ctrl+Z right after a load does not empty the note (MD-1)', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('TextTile: load → Ctrl+Z leaves body and disk unchanged', async () => {
    const fs = recordingFilo({ 'Note.md': 'Precious text\n' });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    pressUndo(m);
    await drainUntilSettled();
    expect(editorMarkdown(m.editor())).toContain('Precious text');
    expect(fs.writesTo('Note.md')).toEqual([]);
    expect(fs.files.get('Note.md')).toBe('Precious text\n');
  });

  it('DocumentEditor: load → Ctrl+Z leaves body and disk unchanged', async () => {
    const fs = recordingFilo({ 'Doc.md': 'Precious text\n' });
    const m = await mountDocumentEditor({ docPath: 'Doc.md' });
    pressUndo(m);
    await drainUntilSettled();
    expect(editorMarkdown(m.editor())).toContain('Precious text');
    expect(fs.writesTo('Doc.md')).toEqual([]);
    await m.unmount();
  });
});

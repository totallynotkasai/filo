import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { unsavedWork } from '@renderer/lib/boards/writeStateTracking';
import { vaultPath } from '@shared/vaultPath';
import {
  recordingFilo,
  mountDocumentEditor,
  settle,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * Keystrokes the note model refuses stay the user's: a note whose file is gone
 * takes them as an unsaved body (the deleted-note prompt decides), and a note
 * that can't take them (read-only) keeps them in the editor, still counted as
 * unsaved and held by the rescue copy. Neither is dropped as if it were saved.
 */
describe('an editor whose keystrokes the note refuses', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('a note deleted on disk keeps what was typed after as an unsaved body', async () => {
    const fs = recordingFilo({ 'Doc.md': '---\ntitle: Doc\n---\nHello\n' });
    const m = await mountDocumentEditor({ docPath: 'Doc.md' });
    fs.files.delete('Doc.md');
    await noteStore.onDiskChanged('Doc.md');
    await settle();
    expect(noteStore.get('Doc.md')?.status).toBe('missing');

    const ed = m.editor();
    ed.commands.focus('end');
    ed.commands.insertContent(' typed after');
    await drainDebounce();

    const model = noteStore.get('Doc.md');
    expect(model?.hasUnsavedBody).toBe(true);
    expect(model?.body).toContain('typed after');
    expect(unsavedWork().pending).toContain(vaultPath('Doc.md'));
    const texts = await noteStore.unsavedTexts();
    expect(texts.some((t) => t.relPath === 'Doc.md' && t.text.includes('typed after'))).toBe(true);
    // Nothing is written blind where the file was.
    expect(fs.writesTo('Doc.md')).toEqual([]);
    await m.unmount();
  });

  it('a note that turned read-only keeps the keystrokes unsaved, and the rescue copy has them', async () => {
    const fs = recordingFilo({ 'Doc.md': '---\ntitle: Doc\n---\nHello\n' });
    const m = await mountDocumentEditor({ docPath: 'Doc.md' });
    const ed = m.editor();
    ed.commands.focus('end');
    ed.commands.insertContent(' typed');
    // The note turns read-only before the idle serialise.
    noteStore.setLossy('Doc.md', true);
    await drainDebounce();

    expect(noteStore.get('Doc.md')?.body).not.toContain('typed');
    expect(unsavedWork().pending).toContain(vaultPath('Doc.md'));
    const texts = await noteStore.unsavedTexts();
    expect(texts.some((t) => t.relPath === 'Doc.md' && t.text.includes('Hello typed'))).toBe(true);
    expect(fs.writesTo('Doc.md')).toEqual([]);
    await m.unmount();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import {
  drainUntilWritten,
  recordingFilo,
  mountTextTile,
  mountDocumentEditor,
  settle,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * Two spaces in a row are ordinary typing. They must survive a reload, must
 * not make the note read-only, and a note open in two views must stay
 * editable in both while one of them types.
 */
describe('double spaces', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('a note with a double space opens editable in both views', async () => {
    recordingFilo({ 'Spaced.md': 'End of one.  Start of two.\n' });
    const doc = await mountDocumentEditor({ docPath: 'Spaced.md' });
    const tile = await mountTextTile({ tile: { id: 't1', title: 'Spaced' } });
    expect(noteStore.get('Spaced.md')?.readOnly).toBe(false);
    expect(doc.editor().isEditable).toBe(true);
    expect(tile.editor().isEditable).toBe(true);
    await tile.unmount();
    await doc.unmount();
  });

  it('a typed double space is saved and the other view stays editable', async () => {
    const fs = recordingFilo({ 'Typed.md': 'Hello\n' });
    const doc = await mountDocumentEditor({ docPath: 'Typed.md' });
    const tile = await mountTextTile({ tile: { id: 't1', title: 'Typed' } });
    const ed = doc.editor();
    ed.commands.focus('end');
    ed.commands.insertContent(' world.  Next');
    await drainUntilWritten(fs, 'Typed.md');
    await settle();
    const writes = fs.writesTo('Typed.md');
    expect(writes.at(-1)?.content).toContain('Hello world.  Next');
    expect(noteStore.get('Typed.md')?.readOnly).toBe(false);
    expect(doc.editor().isEditable).toBe(true);
    expect(tile.editor().isEditable).toBe(true);
    await tile.unmount();
    await doc.unmount();
  });

  it('Take ownership holds when a second view opens the same note', async () => {
    recordingFilo({ 'Wrapped.md': 'A paragraph with a <!-- a comment --> comment.\n' });
    const doc = await mountDocumentEditor({ docPath: 'Wrapped.md' });
    expect(noteStore.get('Wrapped.md')?.readOnly).toBe(true);
    noteStore.takeOwnership('Wrapped.md');
    await settle();
    const tile = await mountTextTile({ tile: { id: 't1', title: 'Wrapped' } });
    expect(noteStore.get('Wrapped.md')?.readOnly).toBe(false);
    expect(doc.editor().isEditable).toBe(true);
    await tile.unmount();
    await doc.unmount();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { editorMarkdown } from '@renderer/lib/editor/markdownSync';
import {
  recordingFilo,
  mountTextTile,
  mountDocumentEditor,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/** The component-mount harness itself works. */
describe('component harness smoke', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('mounts a TextTile that loads the disk body into the editor and the note model', async () => {
    recordingFilo({ 'Note.md': 'Hello **world**\n' });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    expect(m.proseMirror().textContent).toContain('Hello world');
    expect(noteStore.get('Note.md')?.body).toBe('Hello **world**\n');
    expect(noteStore.get('Note.md')?.status).toBe('ready');
    expect(editorMarkdown(m.editor())).toContain('Hello **world**');
    await m.unmount();
  });

  it('mounts a DocumentEditor on a document tab', async () => {
    recordingFilo({ 'Doc.md': '---\na: 1\n---\nDoc body\n' });
    const m = await mountDocumentEditor({ docPath: 'Doc.md' });
    expect(m.proseMirror().textContent).toContain('Doc body');
    await m.unmount();
  });
});

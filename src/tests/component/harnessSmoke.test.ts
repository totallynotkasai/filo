import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { editorMarkdown } from '@renderer/lib/editor/markdownSync';
import {
  recordingFilo,
  mountTextTile,
  mountDocumentEditor,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/** Audit-19 0.1 (T0) — the component-mount harness itself works. */
describe('component harness smoke', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('mounts a TextTile that hydrates the disk body into editor + store', async () => {
    recordingFilo({ 'Note.md': 'Hello **world**\n' });
    const m = await mountTextTile({ tile: { id: 't1', contentId: 'd1', title: 'Note' } });
    expect(m.proseMirror().textContent).toContain('Hello world');
    expect(documentStore.getDocument('d1')?.body).toBe('Hello **world**\n');
    expect(editorMarkdown(m.editor())).toContain('Hello **world**');
    await m.unmount();
  });

  it('mounts a DocumentEditor on a document tab', async () => {
    recordingFilo({ 'Doc.md': '---\na: 1\n---\nDoc body\n' });
    const m = await mountDocumentEditor({ docId: 'doc1', docPath: 'Doc.md' });
    expect(m.proseMirror().textContent).toContain('Doc body');
    await m.unmount();
  });
});

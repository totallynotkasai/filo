/**
 * Audit-19 0.2 — the REAL `DocumentEditor.svelte` opened on a note and closed
 * with no edit must leave the bytes untouched and must not trip Svelte's
 * `effect_update_depth_exceeded` (the loop the svelte ^5.57.1 upgrade fixed;
 * also guarded in the built app by `e2e/noBytesByLooking.e2e.ts`). Plus the
 * DocumentEditor twin of MD-1 (load → Ctrl+Z). Pinned by
 * ci:markdown-body-roundtrip (EDITOR_SUITE arm).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { editorMarkdown } from '@renderer/lib/editor/markdownSync';
import {
  drainUntilSettled,
  recordingFilo,
  mountDocumentEditor,
  pressUndo,
  captureConsoleErrors,
  resetEditorHarness,
  teardownEditorHarness,
} from '../helpers/mountEditor';

const NOTE_LF = '---\ntags: [a]\n---\n# Title\n\nSome _emphasis_ and a list:\n\n- one\n- two\n';
const NOTE_CRLF = NOTE_LF.replace(/\n/g, '\r\n');

describe('DocumentEditor open → close (editor integration)', () => {
  let errors: ReturnType<typeof captureConsoleErrors>;
  beforeEach(() => {
    resetEditorHarness();
    errors = captureConsoleErrors();
  });
  afterEach(() => {
    errors.restore();
    teardownEditorHarness();
  });

  for (const [label, note] of [['CRLF', NOTE_CRLF], ['LF', NOTE_LF]] as const) {
    it(`(${label}) open → close: bytes unchanged, no effect_update_depth_exceeded`, async () => {
      const fs = recordingFilo({ 'Doc.md': note });
      const m = await mountDocumentEditor({ docPath: 'Doc.md' });
      expect(m.proseMirror().textContent).toContain('Title');
      await m.unmount();
      await drainUntilSettled();
      expect(fs.writesTo('Doc.md')).toEqual([]);
      expect(fs.files.get('Doc.md')).toBe(note);
      expect(errors.lines.filter((l) => l.includes('effect_update_depth_exceeded'))).toEqual([]);
    });
  }

  it('(c) load → Ctrl+Z leaves body and disk unchanged', async () => {
    const fs = recordingFilo({ 'Doc.md': NOTE_LF });
    const m = await mountDocumentEditor({ docPath: 'Doc.md' });
    pressUndo(m);
    await drainUntilSettled();
    expect(editorMarkdown(m.editor())).toContain('Title');
    expect(fs.writesTo('Doc.md')).toEqual([]);
    await m.unmount();
  });
});

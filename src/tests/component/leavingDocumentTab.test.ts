import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import {
  recordingFilo,
  mountDocumentEditor,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * Leaving a Document tab unmounts its editor. The formatting toolbar lets go
 * of that editor at once: it must not keep driving the toolbar from a
 * destroyed editor, whose note callback reads state of a destroyed view
 * (Svelte's `derived_inert` warning, many times per switch).
 */
describe('leaving a Document tab', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('the toolbar drops the editor at once, and reads nothing of the destroyed view', async () => {
    recordingFilo({ 'Doc.md': '---\ntags: [a]\n---\nHello\n' });
    const m = await mountDocumentEditor({ docPath: 'Doc.md' });
    const ed = m.editor();
    ed.commands.focus('end');
    ed.commands.insertContent('X');
    await drainDebounce();
    expect(tiptapToolbar.activeEditor).toBe(ed);

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      await m.unmount();
      expect(tiptapToolbar.activeEditor).toBeNull();
      // What the toolbar does on its next update.
      tiptapToolbar.syncState();
      tiptapToolbar.setLineSpacing(2);
    } finally {
      console.warn = orig;
    }
    expect(warnings.filter((w) => w.includes('derived_inert'))).toEqual([]);
  });
});

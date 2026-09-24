import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { editorMarkdown } from '@renderer/lib/editor/markdownSync';
import {
  recordingFilo,
  mountTextTile,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * Audit-19 MD-5 — TextTile must not load just any existing DocumentState for
 * its note into a writable editor. An unhydrated placeholder (body '', e.g.
 * from a DocumentEditor whose read failed, or from Kanban's
 * `openTileAsDocument`) would produce an empty editable body; the next
 * keystroke would write the real FM plus an empty body over the real note.
 */
function placeholder(filename: string, body = ''): void {
  documentStore.loadDocument({ filename, title: 'X', body, htmlContent: '', richText: [] });
}

describe('TextTile never adopts an unread placeholder body (MD-5)', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('(a) placeholder with no FM → reads disk, shows + keeps the real body', async () => {
    const fs = recordingFilo({ 'X.md': '---\na: 1\n---\nReal body\n' });
    placeholder('X.md');
    const m = await mountTextTile({ tile: { id: 't1', title: 'X' } });
    expect(m.proseMirror().textContent).toContain('Real body');
    expect(documentStore.getDocument('X.md')?.body).toBe('Real body\n');
    const ed = m.editor();
    ed.commands.focus('end');
    ed.commands.insertContent('!');
    await drainDebounce();
    const writes = fs.writesTo('X.md');
    expect(writes.length).toBe(1);
    expect(writes[0].content).toContain('Real body');
    expect(writes[0].content).toContain('a: 1');
    await m.unmount();
  });

  it('(b) placeholder + a failed read → no write, Retry banner', async () => {
    const fs = recordingFilo({ 'X.md': '---\na: 1\n---\nReal body\n' });
    fs.failReads('X.md', 'EBUSY');
    placeholder('X.md');
    const m = await mountTextTile({ tile: { id: 't1', title: 'X' } });
    expect(m.editor().isEditable).toBe(false);
    expect(m.target.textContent).toContain('Retry');
    m.editor().commands.insertContent('typed');
    await drainDebounce();
    await m.unmount();
    await drainDebounce();
    expect(fs.writesTo('X.md')).toEqual([]);
  });

  it('(c) placeholder with FM seeded but body "" (Kanban variant) still reads disk', async () => {
    const fs = recordingFilo({ 'X.md': '---\na: 1\n---\nReal body\n' });
    placeholder('X.md');
    documentStore.setFrontmatter('X.md', { a: 1 });
    const m = await mountTextTile({ tile: { id: 't1', title: 'X' } });
    expect(fs.calls).toContain('vault:read-file-text');
    expect(editorMarkdown(m.editor())).toContain('Real body');
    await m.unmount();
  });

  it('(d) a genuinely hydrated document for the note is reused without a second read', async () => {
    const fs = recordingFilo({ 'X.md': '---\na: 1\n---\nSibling body\n' });
    placeholder('X.md', 'Sibling body\n');
    documentStore.setFrontmatter('X.md', { a: 1 });
    const m = await mountTextTile({ tile: { id: 't1', title: 'X' } });
    expect(fs.calls).not.toContain('vault:read-file-text');
    expect(m.proseMirror().textContent).toContain('Sibling body');
    await m.unmount();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordingFilo,
  mountTextTile,
  mountDocumentEditor,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * Audit-19 MD-3 — `DocumentState.body` is body-only, but five sites re-parsed it
 * with `parseMarkdownFile`, which treats a body starting with a `---` line and
 * containing a later `---` line as FRONTMATTER. A note with real FM whose body
 * opens with a horizontal-rule pair lost its intro on the next remount/reload,
 * and the truncated body was written back — with no typing at all.
 */
const FILE = '---\ntitle: x\n---\n---\n\nSome intro\n\n---\n\nMore _text_\n';

describe('an HR-leading body survives remounts (MD-3)', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('TextTile: mount → unmount → remount still shows the intro', async () => {
    const fs = recordingFilo({ 'Note.md': FILE });
    const first = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    expect(first.proseMirror().textContent).toContain('Some intro');
    await first.unmount();
    await drainDebounce();
    const second = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    expect(second.proseMirror().textContent).toContain('Some intro');
    await second.unmount();
    await drainDebounce();
    expect(fs.files.get('Note.md')).toContain('Some intro');
  });

  it('DocumentEditor cached branch + one keystroke keeps the intro on disk', async () => {
    const fs = recordingFilo({ 'Note.md': FILE });
    // The TextTile reads disk, seeding the FM cache + body-only store body.
    const tile = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    const doc = await mountDocumentEditor({ docPath: 'Note.md' });
    expect(doc.proseMirror().textContent).toContain('Some intro');
    const ed = doc.editor();
    ed.commands.focus('end');
    ed.commands.insertContent('!');
    await drainDebounce();
    const writes = fs.writesTo('Note.md');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1].content).toContain('Some intro');
    await doc.unmount();
    await tile.unmount();
  });
});

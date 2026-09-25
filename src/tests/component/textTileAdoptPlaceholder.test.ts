import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { editorMarkdown } from '@renderer/lib/editor/markdownSync';
import {
  recordingFilo,
  mountTextTile,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
  VAULT,
} from './helpers/mountEditor';

/**
 * A TextTile must only ever edit the note's real body. An editor that became
 * writable over an empty or unread body would write the real frontmatter plus
 * an empty body over the note on the next keystroke. So the tile shows what
 * the note model read from disk, stays frozen while that read fails, and a
 * frontmatter change queued for a note nobody has loaded (a Kanban field edit)
 * doesn't stand in for the body.
 */
describe('TextTile never edits a body it has not read', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('(a) reads disk, shows + keeps the real body and frontmatter on the first edit', async () => {
    const fs = recordingFilo({ 'X.md': '---\na: 1\n---\nReal body\n' });
    const m = await mountTextTile({ tile: { id: 't1', title: 'X' } });
    expect(m.proseMirror().textContent).toContain('Real body');
    expect(noteStore.get('X.md')?.body).toBe('Real body\n');
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

  it('(b) a failed read → no write, Retry banner', async () => {
    const fs = recordingFilo({ 'X.md': '---\na: 1\n---\nReal body\n' });
    fs.failReads('X.md', 'EBUSY');
    const m = await mountTextTile({ tile: { id: 't1', title: 'X' } });
    expect(noteStore.get('X.md')?.status).toBe('unreadable');
    expect(m.editor().isEditable).toBe(false);
    expect(m.target.textContent).toContain('Retry');
    m.editor().commands.insertContent('typed');
    await drainDebounce();
    await m.unmount();
    await drainDebounce();
    expect(fs.writesTo('X.md')).toEqual([]);
  });

  it('(c) a frontmatter change queued before the tile mounts still reads the disk body', async () => {
    const fs = recordingFilo({ 'X.md': '---\na: 1\n---\nReal body\n' });
    noteStore.patchFrontmatter('X.md', { set: { b: 2 }, unset: [] });
    const m = await mountTextTile({ tile: { id: 't1', title: 'X' } });
    expect(fs.calls).toContain('vault:read-file-text');
    expect(editorMarkdown(m.editor())).toContain('Real body');
    await drainDebounce();
    const last = fs.writesTo('X.md').at(-1)?.content ?? '';
    expect(last).toContain('a: 1');
    expect(last).toContain('b: 2');
    expect(last).toContain('Real body');
    await m.unmount();
  });

  it('(d) a note another view already loaded is shown without a second read', async () => {
    const fs = recordingFilo({ 'X.md': '---\na: 1\n---\nSibling body\n' });
    vaultStore.setPath(VAULT);
    const sibling = noteStore.acquire('X.md', 'doc:sibling');
    await sibling.loaded;
    const readsBefore = fs.calls.filter((c) => c === 'vault:read-file-text').length;
    const m = await mountTextTile({ tile: { id: 't1', title: 'X' } });
    expect(fs.calls.filter((c) => c === 'vault:read-file-text').length).toBe(readsBefore);
    expect(noteStore.get('X.md')).toBe(sibling);
    expect(m.proseMirror().textContent).toContain('Sibling body');
    await m.unmount();
    noteStore.release('X.md', 'doc:sibling');
  });
});
